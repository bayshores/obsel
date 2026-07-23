/**
 * The file that decides what obsel does, tested for the first time.
 *
 * `hackathon.md` has named this the repository's most honest weakness since the first
 * commit: `engine.ts`, `client.ts` and `mcp.ts` existed and type-checked, and not one
 * of them was covered. The reason was mechanical rather than a judgement — all three
 * import `server-only`, which throws unless the bundler resolves under React's
 * `react-server` condition, so a test could not load them at all. `vitest.config.ts`
 * now aliases that marker to a no-op (see `tests/support/server-only.ts`), and Next.js
 * still enforces the real guard at build time, so nothing is weakened.
 *
 * **What a green run here does and does not prove.** `staleness.ts` already covered
 * the rules purely: given two fingerprints, is this a change, and given a graph, what
 * does it reach. None of that touched the code that *calls* them. These tests cover
 * that layer: reading the swarm out of DataHub, comparing what a completion reports
 * against what was recorded, walking the lineage, writing each mark back, and
 * confirming it landed. They run against `tests/support/fake-datahub.ts`, which
 * encodes DataHub as `docs/environment-findings.md` measured it. So this proves obsel
 * behaves correctly against DataHub as measured, and cannot prove DataHub behaves that
 * way. Where a belief is load bearing, the test says which finding it rests on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { datasetUrnOf, fakeDataHub, registerStaleTag, taskUrnOf } from "./support/fake-datahub";
import type { FakeDataHub } from "./support/fake-datahub";
import type { CompletionReport } from "@/src/server/coordinator/types";

/*
 * The MCP tag path is stubbed, and the stub writes into the same fake store.
 *
 * `mcp.ts` speaks MCP to a `uvx mcp-server-datahub` subprocess, which a unit test has
 * no business spawning. Recording the calls and stopping there would have been enough
 * to assert obsel asked for the right tags, and not enough for anything downstream:
 * the tag would never appear on the entity, so `staleTagged` and the board's
 * write-back count could not be exercised at all. Writing into `fake.jobs` instead
 * keeps the two halves of a mark coherent — properties on `dataJobInfo`, tags on
 * `globalTags` — which is the separation that makes a leftover tag possible in the
 * first place.
 *
 * What stays uncovered, and is listed as such in `docs/architecture.md`: the MCP round
 * trip itself, including `confirmTagState`'s bounded polling.
 */
const tagCalls: { op: "add" | "remove"; urns: string[] }[] = [];
let current: FakeDataHub | null = null;

vi.mock("@/src/server/datahub/mcp", () => ({
  applyStaleTag: async (urns: string[]) => {
    tagCalls.push({ op: "add", urns });
    for (const urn of urns) {
      const job = current?.jobs.get(urn);
      if (job !== undefined && !job.tags.includes(STALE_TAG)) job.tags.push(STALE_TAG);
    }
    return "tagged";
  },
  removeStaleTag: async (urns: string[]) => {
    tagCalls.push({ op: "remove", urns });
    for (const urn of urns) {
      const job = current?.jobs.get(urn);
      if (job !== undefined) job.tags = job.tags.filter((tag) => tag !== STALE_TAG);
    }
    return "untagged";
  },
  listMcpTools: async () => ["add_tags", "remove_tags"],
  closeMcpClient: async () => undefined,
}));

const STALE_TAG = "urn:li:tag:obsel-stale";

const { coordinateCompletion, readSwarm, registerTask, startTask, abandonTask, resetSwarm } =
  await import("@/src/server/coordinator/engine");
const { readTask } = await import("@/src/server/datahub/client");

/** The demo's own shape: one linear chain that forks into two leaves. */
async function pipeline(): Promise<void> {
  await registerTask(
    "clean_orders",
    ["raw_orders"],
    ["clean_orders"],
    "cleans the raw orders export",
    "Orders cleaner",
  );
  await registerTask(
    "build_revenue",
    ["clean_orders"],
    ["daily_revenue"],
    undefined,
    "Daily revenue",
  );
  await registerTask(
    "write_report",
    ["daily_revenue"],
    ["revenue_report"],
    undefined,
    "Revenue report",
  );
  await registerTask("write_docs", ["daily_revenue"], ["pipeline_docs"], undefined, "Table docs");
}

/**
 * A completion report, in the shape an agent posts it.
 *
 * `columns` is optional because `run` is: an agent that reports nothing about itself
 * must still get a correct staleness answer, and half these cases prove it does.
 */
function finished(
  name: string,
  dataset: string,
  schema: string,
  content: string,
  columns?: string[],
): CompletionReport {
  return {
    taskUrn: taskUrnOf(name),
    fingerprints: { [datasetUrnOf(dataset)]: { schema, content } },
    finishedAt: new Date().toISOString(),
    ...(columns === undefined
      ? {}
      : {
          run: {
            runner: "codex-cli 0.144.4",
            ms: 40_000,
            outputs: { [datasetUrnOf(dataset)]: { rows: 39, columns } },
          },
        }),
  };
}

/** Run the whole pipeline to a settled board, as the demo's `run` step does. */
async function runAll(cleanColumns = ["order_id", "order_total"]): Promise<void> {
  await coordinateCompletion(finished("clean_orders", "clean_orders", "s1", "c1", cleanColumns));
  await coordinateCompletion(finished("build_revenue", "daily_revenue", "s2", "c2"));
  await coordinateCompletion(finished("write_report", "revenue_report", "s3", "c3"));
  await coordinateCompletion(finished("write_docs", "pipeline_docs", "s4", "c4"));
}

let fake: FakeDataHub;

beforeEach(async () => {
  tagCalls.length = 0;
  fake = fakeDataHub();
  current = fake;
  registerStaleTag(fake);
  await pipeline();
});

afterEach(() => {
  fake.restore();
  current = null;
});

describe("registration puts real entities and real edges into DataHub", () => {
  it("writes a DataJob per task, with its lineage as edges rather than as a list", async () => {
    const swarm = await readSwarm();
    expect(swarm.snapshot.tasks.map((t) => t.name).sort()).toEqual([
      "build_revenue",
      "clean_orders",
      "write_docs",
      "write_report",
    ]);
    const cleaner = swarm.snapshot.tasks.find((t) => t.name === "clean_orders");
    expect(cleaner?.reads).toEqual([datasetUrnOf("raw_orders")]);
    expect(cleaner?.writes).toEqual([datasetUrnOf("clean_orders")]);
    expect(cleaner?.title).toBe("Orders cleaner");
    expect(cleaner?.status).toBe("registered");
  });

  it("never asks GET /entities/<urn> whether something exists", async () => {
    /*
     * Finding §1, and the reason it matters more than a style preference: that
     * endpoint synthesises a well-formed response for ANY syntactically valid URN,
     * including one invented on the spot. The fake reproduces that fabrication, so if
     * obsel ever reached for it, existence checks would silently start passing for
     * tasks that do not exist and the cascade would walk into nothing.
     */
    await readSwarm();
    expect(fake.callsTo("/entities/")).toEqual([]);
    expect(fake.callsTo("/openapi/v3/entity/datajob/").length).toBeGreaterThan(0);
  });

  it("traverses over /relationships and never over GraphQL", async () => {
    // Finding §7: the GraphQL lineage surface reads a search index that lagged over 90
    // seconds on freshly registered tasks and answered with an empty list rather than
    // an error, so obsel would be blind exactly when it matters, and blind silently.
    await readSwarm();
    expect(fake.callsTo("/relationships").length).toBeGreaterThan(0);
    expect(fake.callsTo("/api/graphql")).toEqual([]);
    expect(fake.callsTo("graphql")).toEqual([]);
  });
});

describe("a completion that changes nothing marks nothing", () => {
  it("marks nothing on the first run, because there is nothing to compare against", async () => {
    const result = await coordinateCompletion(finished("clean_orders", "clean_orders", "s1", "c1"));
    expect(result.changedOutputs).toEqual([]);
    expect(result.affected).toEqual([]);
  });

  it("marks nothing when a re-run produces the identical output", async () => {
    /*
     * The rule the product lives or dies on. Staleness is decided by comparing the
     * recorded fingerprint, never by the fact that a write happened, because a tool
     * that shouts after every scheduled re-run gets muted and then the marks mean
     * nothing.
     */
    await runAll();
    tagCalls.length = 0;

    const again = await coordinateCompletion(finished("clean_orders", "clean_orders", "s1", "c1"));

    expect(again.changedOutputs).toEqual([]);
    expect(again.affected).toEqual([]);
    expect(tagCalls.filter((c) => c.op === "add")).toEqual([]);
    const swarm = await readSwarm();
    expect(swarm.snapshot.tasks.filter((t) => t.stale !== null)).toEqual([]);
  });

  it("leaves existing marks exactly as they were when a later re-run changes nothing", async () => {
    // The harder version, and the one the demo films: an identical re-run on a board
    // that is ALREADY flagged must add nothing and disturb nothing.
    await runAll();
    await coordinateCompletion(finished("clean_orders", "clean_orders", "s1-changed", "c1"));
    const before = (await readSwarm()).snapshot.tasks.map((t) => [t.name, t.stale?.since]);

    const again = await coordinateCompletion(
      finished("clean_orders", "clean_orders", "s1-changed", "c1"),
    );

    expect(again.affected).toEqual([]);
    const after = (await readSwarm()).snapshot.tasks.map((t) => [t.name, t.stale?.since]);
    expect(after).toEqual(before);
  });
});

describe("a real change cascades, and says why", () => {
  it("reaches direct and transitive downstream work, with the right distances", async () => {
    await runAll();

    const result = await coordinateCompletion(
      finished("clean_orders", "clean_orders", "s1-changed", "c1"),
    );

    // `columns` is null because this completion reported no `run`, so obsel had no
    // column list to diff against. The diff is display material; the change is not.
    expect(result.changedOutputs).toEqual([
      { dataset: datasetUrnOf("clean_orders"), kind: "schema", columns: null },
    ]);
    const reached = Object.fromEntries(
      result.affected.map((entry) => [entry.task.name, entry.mark.hops]),
    );
    // build_revenue read the changed table. The other two never touched it and are
    // reached through what did, which is the entire reason this needs a graph.
    expect(reached).toEqual({ build_revenue: 1, write_report: 2, write_docs: 2 });
  });

  it("never marks the task that caused the change", async () => {
    await runAll();
    const result = await coordinateCompletion(
      finished("clean_orders", "clean_orders", "s1-changed", "c1"),
    );
    expect(result.affected.map((a) => a.task.name)).not.toContain("clean_orders");
    const cleaner = await readTask(taskUrnOf("clean_orders"));
    expect(cleaner?.status).toBe("complete");
    expect(cleaner?.stale).toBeNull();
  });

  it("gives every mark a reason, a cause and a distance, in DataHub", async () => {
    // A mark with no traceable cause is not actionable, so this asserts the mark as
    // DataHub holds it rather than as the return value described it.
    await runAll();
    await coordinateCompletion(finished("clean_orders", "clean_orders", "s1-changed", "c1"));

    const docs = await readTask(taskUrnOf("write_docs"));
    expect(docs?.status).toBe("stale");
    expect(docs?.stale?.causedBy).toBe(datasetUrnOf("clean_orders"));
    expect(docs?.stale?.causedByTask).toBe(taskUrnOf("clean_orders"));
    expect(docs?.stale?.hops).toBe(2);
    expect(docs?.stale?.changeKind).toBe("schema");
    expect(docs?.stale?.reason).toBeTruthy();
    // Words, not warehouse identifiers, and built at the source rather than at render.
    expect(docs?.stale?.reason).toContain("clean orders");
    expect(docs?.stale?.reason).not.toContain("clean_orders");
    expect(docs?.stale?.since).toBeTruthy();
  });

  it("records which columns moved, from the previous run's own report", async () => {
    /*
     * The diff is derived from `obsel.run.outputs`, which obsel already recorded, and
     * carries the ORIGIN's change however far the walk goes. So a two-hop mark on a
     * task that never read `clean_orders` still names the columns of `clean_orders`.
     */
    await runAll(["order_id", "order_total"]);
    await coordinateCompletion(
      finished("clean_orders", "clean_orders", "s1-changed", "c1", ["order_id", "order_total_usd"]),
    );

    for (const name of ["build_revenue", "write_report", "write_docs"]) {
      const task = await readTask(taskUrnOf(name));
      expect(task?.stale?.columns, name).toEqual({
        added: ["order_total_usd"],
        removed: ["order_total"],
      });
    }
  });

  it("calls a content-only change content, and records no columns for it", async () => {
    await runAll(["order_id", "order_total"]);
    await coordinateCompletion(
      finished("clean_orders", "clean_orders", "s1", "c1-changed", ["order_id", "order_total"]),
    );
    const revenue = await readTask(taskUrnOf("build_revenue"));
    expect(revenue?.stale?.changeKind).toBe("content");
    // Absent rather than an empty diff: nothing moved, so there is nothing to show.
    expect(revenue?.stale?.columns ?? null).toBeNull();
  });

  it("does not mark an unrelated branch", async () => {
    // A second source feeding a second leaf. The change to clean_orders must not reach
    // it, and a cascade that over-reaches is the same failure as one that cries wolf.
    await registerTask("side_job", ["raw_orders"], ["side_table"]);
    await runAll();
    await coordinateCompletion(finished("side_job", "side_table", "s9", "c9"));

    const result = await coordinateCompletion(
      finished("clean_orders", "clean_orders", "s1-changed", "c1"),
    );
    expect(result.affected.map((a) => a.task.name)).not.toContain("side_job");
    expect((await readTask(taskUrnOf("side_job")))?.stale).toBeNull();
  });
});

describe("only finished work goes stale", () => {
  it("leaves a task that is running now unmarked", async () => {
    /*
     * A task in flight will pick the new input up itself, so marking it is a false
     * positive. Asserted through `startTask` rather than by writing the status
     * directly, because the path that sets `running` is the path that has to keep it.
     */
    await runAll();
    await startTask(taskUrnOf("write_docs"));

    const result = await coordinateCompletion(
      finished("clean_orders", "clean_orders", "s1-changed", "c1"),
    );

    expect(result.affected.map((a) => a.task.name)).not.toContain("write_docs");
    const docs = await readTask(taskUrnOf("write_docs"));
    expect(docs?.status).toBe("running");
    expect(docs?.stale).toBeNull();
  });

  it("leaves a task that has never run unmarked", async () => {
    // Registered and never executed: there is no finished work to invalidate.
    await coordinateCompletion(finished("clean_orders", "clean_orders", "s1", "c1"));
    const result = await coordinateCompletion(
      finished("clean_orders", "clean_orders", "s1-changed", "c1"),
    );
    expect(result.affected).toEqual([]);
  });
});

describe("the mark is written into DataHub, both halves of it", () => {
  it("tags exactly the tasks it marked, and no others", async () => {
    await runAll();
    tagCalls.length = 0;
    await coordinateCompletion(finished("clean_orders", "clean_orders", "s1-changed", "c1"));

    const tagged = tagCalls.filter((c) => c.op === "add").flatMap((c) => c.urns);
    expect(new Set(tagged)).toEqual(
      new Set([taskUrnOf("build_revenue"), taskUrnOf("write_report"), taskUrnOf("write_docs")]),
    );
    expect(tagged).not.toContain(taskUrnOf("clean_orders"));
  });

  it("reads the tag back onto the record, so the two halves can be compared", async () => {
    await runAll();
    await coordinateCompletion(finished("clean_orders", "clean_orders", "s1-changed", "c1"));

    const docs = await readTask(taskUrnOf("write_docs"));
    expect(docs?.tags).toEqual([STALE_TAG]);
    expect(docs?.staleTagged).toBe(true);

    // The cause is not a casualty, and carries no tag.
    const cleaner = await readTask(taskUrnOf("clean_orders"));
    expect(cleaner?.tags).toEqual([]);
    expect(cleaner?.staleTagged).toBe(false);
  });

  it("measures how long it took, and does not invent the figure", async () => {
    await runAll();
    const result = await coordinateCompletion(
      finished("clean_orders", "clean_orders", "s1-changed", "c1"),
    );
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    const docs = await readTask(taskUrnOf("write_docs"));
    expect(docs?.stale?.detectedMs).toBeGreaterThanOrEqual(0);
  });

  it("leaves a human-authored tag in place, because writes are additive", async () => {
    await runAll();
    const job = fake.jobs.get(taskUrnOf("write_docs"));
    job?.tags.push("urn:li:tag:pii");

    await coordinateCompletion(finished("clean_orders", "clean_orders", "s1-changed", "c1"));

    const docs = await readTask(taskUrnOf("write_docs"));
    expect(docs?.tags).toContain("urn:li:tag:pii");
    expect(docs?.tags).toContain(STALE_TAG);
  });
});

describe("a run keeps what the next comparison needs", () => {
  it("keeps the previous run's outputs through a start, so the column diff survives", async () => {
    /*
     * This reverses an earlier decision and the reversal is the point. `startTask`
     * used to clear `obsel.run.*` so that live work could not be captioned with the
     * previous run's row count. Those are exactly the column lists the diff is
     * computed against, so clearing them left every mark with no columns to report,
     * and the board fell back to "the columns in clean orders changed" while obsel
     * held the names all along.
     */
    await runAll(["order_id", "order_total"]);
    await startTask(taskUrnOf("clean_orders"));

    const mid = await readTask(taskUrnOf("clean_orders"));
    expect(mid?.status).toBe("running");
    expect(mid?.run?.outputs[datasetUrnOf("clean_orders")]?.columns).toEqual([
      "order_id",
      "order_total",
    ]);

    await coordinateCompletion(
      finished("clean_orders", "clean_orders", "s1-changed", "c1", ["order_id", "order_total_usd"]),
    );
    expect((await readTask(taskUrnOf("build_revenue")))?.stale?.columns).toEqual({
      added: ["order_total_usd"],
      removed: ["order_total"],
    });
  });

  it("keeps the fingerprints through a start, so a re-run is comparable", async () => {
    await runAll();
    await startTask(taskUrnOf("clean_orders"));
    const mid = await readTask(taskUrnOf("clean_orders"));
    expect(Object.keys(mid?.fingerprints ?? {})).toHaveLength(1);
  });

  it("puts a task back where it was when a run dies without finishing", async () => {
    await runAll();
    await startTask(taskUrnOf("clean_orders"));

    const { task, reverted } = await abandonTask(taskUrnOf("clean_orders"));

    expect(reverted).toBe(true);
    expect(task.status).toBe("complete");
    // Its record of what it produced has to come back with it, or the next completion
    // has nothing to compare against and a real change reads as a first run.
    expect(Object.keys(task.fingerprints)).toHaveLength(1);
  });

  it("returns an abandoned stale task to stale, not to complete", async () => {
    // A mark is only earned back by a run that succeeds. A dead run must not clear it.
    await runAll();
    await coordinateCompletion(finished("clean_orders", "clean_orders", "s1-changed", "c1"));
    await startTask(taskUrnOf("write_docs"));

    const { task } = await abandonTask(taskUrnOf("write_docs"));
    expect(task.status).toBe("stale");
    expect(task.stale).not.toBeNull();
  });
});

describe("reset clears both halves, because they live on different aspects", () => {
  it("clears the marks, the tag and the measurement", async () => {
    /*
     * The properties are on `dataJobInfo` and the tag is on `globalTags`, so clearing
     * one leaves the other. `docs/demo-script.md` calls the result the single most
     * damaging frame the video could contain: DataHub showing a stale badge on a job
     * obsel calls registered.
     */
    await runAll();
    await coordinateCompletion(finished("clean_orders", "clean_orders", "s1-changed", "c1"));

    const result = await resetSwarm();

    expect(result.reset.sort()).toEqual([
      "build_revenue",
      "clean_orders",
      "write_docs",
      "write_report",
    ]);
    expect(result.tagsCleared.sort()).toEqual(["build_revenue", "write_docs", "write_report"]);

    for (const name of ["clean_orders", "build_revenue", "write_report", "write_docs"]) {
      const task = await readTask(taskUrnOf(name));
      expect(task?.status, name).toBe("registered");
      expect(task?.stale, name).toBeNull();
      expect(task?.tags, name).toEqual([]);
      expect(task?.staleTagged, name).toBe(false);
      expect(task?.fingerprints, name).toEqual({});
    }
  });

  it("keeps the lineage, which is what a second take runs against", async () => {
    await runAll();
    await resetSwarm();
    const cleaner = await readTask(taskUrnOf("clean_orders"));
    expect(cleaner?.reads).toEqual([datasetUrnOf("raw_orders")]);
    expect(cleaner?.writes).toEqual([datasetUrnOf("clean_orders")]);
  });

  it("reports no tags cleared rather than claiming it cleared some", async () => {
    await runAll();
    const result = await resetSwarm();
    expect(result.tagsCleared).toEqual([]);
  });
});

describe("writes are confirmed rather than assumed", () => {
  it("polls until a written property is actually readable", async () => {
    /*
     * A test of obsel's defensive code, and deliberately not a claim about DataHub.
     *
     * §6.1 measured asynchrony on the MCP tag path: `remove_tags` immediately after
     * `add_tags` errored and the identical call moments later worked. It did NOT
     * measure a lagging aspect read, and `async=false` is documented as applying the
     * aspect before answering. obsel still wraps every property write in
     * `confirmWrite`, because a single immediate read-back producing a false failure
     * would be retried and would double-write.
     *
     * So this holds each write invisible for 400ms to make that loop actually run. At
     * zero delay the first read-back always succeeds and the polling is dead code every
     * other test still passes.
     */
    fake.restore();
    fake = fakeDataHub({ writeDelayMs: 400 });
    current = fake;
    registerStaleTag(fake);
    await pipeline();
    await runAll();

    const result = await coordinateCompletion(
      finished("clean_orders", "clean_orders", "s1-changed", "c1"),
    );

    expect(result.affected).toHaveLength(3);
    // Confirmed means readable, so the mark is on the entity by the time this returns.
    expect((await readTask(taskUrnOf("write_docs")))?.stale).not.toBeNull();
  });
});
