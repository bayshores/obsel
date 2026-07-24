/**
 * The coordinator against a real DataHub, with real entities, edges, properties and
 * tags, and the real MCP server doing the tag writes.
 *
 * This replaced a suite that ran against an in-memory GMS. The fake was deleted rather
 * than kept alongside, and the reason is specific rather than principled: it encoded a
 * propagation delay it attributed to `docs/environment-findings.md` §6.1, and §6.1 says
 * something else — it measured asynchrony on the MCP tag path, not on an aspect read.
 * The tests agreed with the mistake, because a fake can only ever assert what its author
 * already believed. Nothing here can be wrong about DataHub in that way.
 *
 * **Its own DataFlow.** `OBSEL_FLOW_ID` comes from `vitest.live.config.ts`, not from an
 * assignment in this file. That was the first attempt and it silently did not work: ESM
 * hoists static imports, so `urns.ts` — whose `FLOW_URN` is a module-load constant — was
 * evaluated before the assignment ran, and this suite registered into the demo's own
 * `orders_pipeline` and reset it. The flow it uses is real; it is simply not the demo's.
 * The assertion that it is not the demo's is the FIRST test below, because it is the one
 * that caught that.
 *
 * **Fewer, larger tests than the unit suites, deliberately.** Every write here is
 * confirmed by polling DataHub until it is readable, so a test is seconds rather than
 * microseconds. Each one below is a scenario that asserts many things about one real
 * cascade, which is the honest shape for integration tests rather than a failure to
 * decompose them.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireDataHub, requireStaleTag, requireUvx } from "./reachable";

const { coordinateCompletion, readSwarm, registerTask, startTask, abandonTask, resetSwarm } =
  await import("@/src/server/coordinator/engine");
const { readTask } = await import("@/src/server/datahub/client");
const { closeMcpClient } = await import("@/src/server/datahub/mcp");
const { STALE_TAG_URN, datasetUrn, taskUrn } = await import("@/src/server/datahub/urns");

import type { CompletionReport } from "@/src/server/coordinator/types";

/**
 * The fixture graph, declared once: the demo's chain forking into two leaves, plus one
 * unrelated branch off the same seed table.
 *
 * `side_job` is registered here rather than inside the test that needs it. Registration
 * is permanent — obsel never deletes, by design — so a task registered mid-test stays a
 * member of the flow for every later run, and the enumeration assertion below started
 * failing on the second run against a count that was correct the first time.
 */
async function registerPipeline(): Promise<void> {
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
  // The unrelated branch: reads the same seed table, writes something of its own, and
  // must never be reached by a change to `clean_orders`.
  await registerTask("side_job", ["raw_orders"], ["side_table"], undefined, "Side job");
  // A second reader of clean_orders, for the unreported-change tests. The cascade from
  // an observed change stops at the reporter — its own outputs are judged by the normal
  // output comparison — so proving anything gets marked needs another finished reader.
  await registerTask("audit_orders", ["clean_orders"], ["audit_report"], undefined, "Order audit");
}

/**
 * A completion report, as an agent posts one.
 *
 * The fingerprints are literal strings rather than real sha256 output on purpose:
 * `agents/fingerprint.py` is what produces those and has its own checks, and what is
 * under test here is obsel's comparison of whatever it is handed. Using short values
 * keeps a failure message readable.
 */
function finished(
  name: string,
  dataset: string,
  schema: string,
  content: string,
  columns?: string[],
): CompletionReport {
  return {
    taskUrn: taskUrn(name),
    fingerprints: { [datasetUrn(dataset)]: { schema, content } },
    finishedAt: new Date().toISOString(),
    ...(columns === undefined
      ? {}
      : {
          run: {
            runner: "integration-test",
            ms: 1,
            outputs: { [datasetUrn(dataset)]: { rows: 39, columns } },
          },
        }),
  };
}

/** Every agent finishes, as the demo's `run` step does. */
async function runAll(cleanColumns = ["order_id", "order_total"]): Promise<void> {
  await coordinateCompletion(finished("clean_orders", "clean_orders", "s1", "c1", cleanColumns));
  await coordinateCompletion(finished("build_revenue", "daily_revenue", "s2", "c2"));
  await coordinateCompletion(finished("write_report", "revenue_report", "s3", "c3"));
  await coordinateCompletion(finished("write_docs", "pipeline_docs", "s4", "c4"));
}

/** Tag URNs DataHub reports right now, read straight off the entity. */
async function tagsOn(name: string): Promise<string[]> {
  return (await readTask(taskUrn(name)))?.tags ?? [];
}

beforeAll(async () => {
  await requireDataHub();
  await requireStaleTag();
  requireUvx();
  await registerPipeline();
  return async () => {
    // The MCP server is a child process; without this vitest hangs on exit.
    await closeMcpClient();
  };
});

beforeEach(async () => {
  // Back to registered, with the lineage intact. `resetSwarm` is itself under test
  // below, and using it here is deliberate: if it did not work, every test in this
  // file would fail rather than one, which is the failure mode worth having.
  await resetSwarm();
});

describe("this suite writes to its own flow, never the demo's", () => {
  it("is pointed at the integration flow", async () => {
    /*
     * First, because it is the assertion that caught the isolation silently failing.
     * These tests register real DataJobs and call `resetSwarm`, so if the override ever
     * stops being honoured they would clear whatever board the operator had on screen.
     * A green suite that had quietly done that is the worst outcome available here.
     */
    const swarm = await readSwarm();
    expect(swarm.snapshot.flow).toContain("obsel_integration_tests");
    expect(swarm.snapshot.flow).not.toContain("orders_pipeline");
  });
});

describe("registration puts real entities and real edges into DataHub", () => {
  it("enumerates the flow's members and reads their lineage back as edges", async () => {
    const swarm = await readSwarm();
    /*
     * Contains, not equals. Every live file registers a subject of its own into this
     * one integration flow, and registration is permanent by design — obsel never
     * deletes. Asserting an exact membership list made this fail the moment a second
     * live file existed, for a reason that was not a defect in anything.
     */
    const names = swarm.snapshot.tasks.map((t) => t.name);
    for (const expected of [
      "clean_orders",
      "build_revenue",
      "write_report",
      "write_docs",
      "side_job",
      "audit_orders",
    ]) {
      expect(names, expected).toContain(expected);
    }

    const cleaner = swarm.snapshot.tasks.find((t) => t.name === "clean_orders");
    // Not a list obsel keeps: these are `Consumes` and `Produces` edges in DataHub's
    // graph, enumerated back out of it.
    expect(cleaner?.reads).toEqual([datasetUrn("raw_orders")]);
    expect(cleaner?.writes).toEqual([datasetUrn("clean_orders")]);
    expect(cleaner?.title).toBe("Orders cleaner");
    expect(cleaner?.description).toBe("cleans the raw orders export");
    expect(cleaner?.status).toBe("registered");
  });
});

describe("a completion that changes nothing marks nothing", () => {
  it("marks nothing on a first run, and nothing on an identical re-run", async () => {
    /*
     * The rule the product lives or dies on. Staleness is decided by comparing the
     * recorded fingerprint, never by the fact that a write happened, because a tool
     * that shouts after every scheduled re-run gets muted and then its marks mean
     * nothing.
     */
    const first = await coordinateCompletion(finished("clean_orders", "clean_orders", "s1", "c1"));
    expect(first.changedOutputs).toEqual([]);
    expect(first.affected).toEqual([]);

    await runAll();

    const again = await coordinateCompletion(finished("clean_orders", "clean_orders", "s1", "c1"));
    expect(again.changedOutputs).toEqual([]);
    expect(again.affected).toEqual([]);

    const swarm = await readSwarm();
    expect(swarm.snapshot.tasks.filter((t) => t.stale !== null)).toEqual([]);
    // And nothing was tagged in DataHub either, which is the half a person sees.
    for (const name of ["build_revenue", "write_report", "write_docs"]) {
      expect(await tagsOn(name), name).toEqual([]);
    }
  });

  it("adds nothing and disturbs nothing when an identical re-run lands on a flagged board", async () => {
    // The harder version, and the one the demo films: hardest is the board that is
    // ALREADY flagged, where a false alarm would be invisible among true ones.
    await runAll();
    await coordinateCompletion(finished("clean_orders", "clean_orders", "s1-changed", "c1"));

    const before = (await readSwarm()).snapshot.tasks.map((t) => [t.name, t.stale?.since ?? null]);
    const again = await coordinateCompletion(
      finished("clean_orders", "clean_orders", "s1-changed", "c1"),
    );

    expect(again.affected).toEqual([]);
    const after = (await readSwarm()).snapshot.tasks.map((t) => [t.name, t.stale?.since ?? null]);
    expect(after).toEqual(before);
  });
});

describe("a real change cascades through DataHub's own lineage", () => {
  it("reaches direct and transitive work, marks it with reasons and columns, and tags it", async () => {
    await runAll(["order_id", "order_total"]);

    const result = await coordinateCompletion(
      finished("clean_orders", "clean_orders", "s1-changed", "c1", ["order_id", "order_total_usd"]),
    );

    // One schema change, three tasks reached over real `GET /relationships` hops.
    expect(result.changedOutputs).toEqual([
      {
        dataset: datasetUrn("clean_orders"),
        kind: "schema",
        columns: { added: ["order_total_usd"], removed: ["order_total"] },
      },
    ]);
    expect(Object.fromEntries(result.affected.map((a) => [a.task.name, a.mark.hops]))).toEqual({
      build_revenue: 1,
      write_report: 2,
      write_docs: 2,
    });

    // The cause is not a casualty. It stays complete and untagged.
    const cleaner = await readTask(taskUrn("clean_orders"));
    expect(cleaner?.status).toBe("complete");
    expect(cleaner?.stale).toBeNull();
    expect(await tagsOn("clean_orders")).toEqual([]);

    // Each mark as DataHub holds it, not as the return value described it.
    for (const [name, hops] of [
      ["build_revenue", 1],
      ["write_report", 2],
      ["write_docs", 2],
    ] as const) {
      const task = await readTask(taskUrn(name));
      expect(task?.status, name).toBe("stale");
      expect(task?.stale?.hops, name).toBe(hops);
      expect(task?.stale?.causedBy, name).toBe(datasetUrn("clean_orders"));
      expect(task?.stale?.causedByTask, name).toBe(taskUrn("clean_orders"));
      expect(task?.stale?.changeKind, name).toBe("schema");
      // Words, not warehouse identifiers, and built at the source rather than at render.
      expect(task?.stale?.reason, name).toContain("clean orders");
      expect(task?.stale?.reason, name).not.toContain("clean_orders");
      // The ORIGIN's diff, carried unchanged however far the walk went: the two-hop
      // tasks never read `clean_orders` and still name its columns.
      expect(task?.stale?.columns, name).toEqual({
        added: ["order_total_usd"],
        removed: ["order_total"],
      });
      expect(task?.stale?.detectedMs, name).toBeGreaterThanOrEqual(0);

      // The real tag, applied through the real MCP server and read back off the entity.
      expect(await tagsOn(name), name).toEqual([STALE_TAG_URN]);
      expect(task?.staleTagged, name).toBe(true);
    }

    expect(result.elapsedMs).toBeGreaterThan(0);
  });

  it("calls a content-only change content, and records no columns for it", async () => {
    await runAll(["order_id", "order_total"]);
    await coordinateCompletion(
      finished("clean_orders", "clean_orders", "s1", "c1-changed", ["order_id", "order_total"]),
    );
    const revenue = await readTask(taskUrn("build_revenue"));
    expect(revenue?.stale?.changeKind).toBe("content");
    // Absent rather than an empty diff: nothing moved, so there is nothing to show.
    expect(revenue?.stale?.columns ?? null).toBeNull();
  });

  it("leaves an unrelated branch alone", async () => {
    // Over-reaching is the same class of failure as crying wolf: a mark on work the
    // change never touched is a false alarm with extra steps.
    await runAll();
    await coordinateCompletion(finished("side_job", "side_table", "s9", "c9"));

    const result = await coordinateCompletion(
      finished("clean_orders", "clean_orders", "s1-changed", "c1"),
    );
    expect(result.affected.map((a) => a.task.name)).not.toContain("side_job");
    expect((await readTask(taskUrn("side_job")))?.stale).toBeNull();
    expect(await tagsOn("side_job")).toEqual([]);
  });
});

describe("a change nothing reported is caught by the next honest read", () => {
  /*
   * The writer-independent half of detection. Something rewrites clean_orders and
   * never tells obsel — no completion, no fingerprint, nothing. The producer's own
   * record cannot catch that, because the producer never sent one for the new bytes.
   * What catches it is the next honest reader: its completion report carries what it
   * actually read, and that contradicts what the producer recorded writing.
   *
   * The "hostile input" here is real in the only sense that matters: obsel receives
   * a genuine completion whose input fingerprint genuinely disagrees with a genuine
   * recorded one. There is no file to tamper with because obsel never reads files —
   * the disagreement between two reports IS the entire observable event.
   */

  /** Everyone finishes, including both readers of clean_orders. */
  async function runAllWithAudit(): Promise<void> {
    await runAll(["order_id", "order_total"]);
    await coordinateCompletion(finished("audit_orders", "audit_report", "sA", "cA"));
  }

  /** build_revenue re-runs and reports what it read alongside what it wrote. */
  function rereadReport(observedSchema: string): CompletionReport {
    return {
      ...finished("build_revenue", "daily_revenue", "s2", "c2"),
      inputs: {
        [datasetUrn("clean_orders")]: {
          schema: observedSchema,
          content: "c1",
          columns: ["order_id", "order_total_usd"],
        },
      },
    };
  }

  it("marks the other finished reader, with no author and a reason that says so", async () => {
    await runAllWithAudit();

    // build_revenue re-runs. Its output is byte-identical (s2/c2), so the output
    // comparison stays quiet — everything below comes from the input observation.
    await startTask(taskUrn("build_revenue"));
    const result = await coordinateCompletion(rereadReport("s1-silent"));

    expect(result.changedOutputs).toEqual([]);
    expect(result.observedChanges).toEqual([
      { dataset: datasetUrn("clean_orders"), kind: "schema" },
    ]);

    // audit_orders is the other finished reader of the changed table. write_report
    // and write_docs are reachable only through the reporter, whose own outputs
    // just compared identical, so they are correctly untouched.
    expect(result.affected.map((entry) => entry.task.name)).toEqual(["audit_orders"]);

    const audit = await readTask(taskUrn("audit_orders"));
    expect(audit?.status).toBe("stale");
    expect(audit?.stale?.causedBy).toBe(datasetUrn("clean_orders"));
    // No author: blaming clean_orders' producer would name a task that never wrote
    // these bytes.
    expect(audit?.stale?.causedByTask).toBeNull();
    expect(audit?.stale?.reason).toContain("Nothing reported that change");
    expect(audit?.stale?.reason).toContain("Daily revenue");
    // The diff still names columns, from the producer's recorded shape against the
    // reader's observed one.
    expect(audit?.stale?.columns).toEqual({
      added: ["order_total_usd"],
      removed: ["order_total"],
    });
    // And the half a person sees in DataHub's own UI landed too.
    expect(await tagsOn("audit_orders")).toContain(STALE_TAG_URN);

    for (const untouched of ["write_report", "write_docs", "side_job"]) {
      expect((await readTask(taskUrn(untouched)))?.stale, untouched).toBeNull();
    }
  });

  it("does not re-flag when a second read observes the same bytes", async () => {
    await runAllWithAudit();
    await startTask(taskUrn("build_revenue"));
    await coordinateCompletion(rereadReport("s1-silent"));

    // The observation was written onto the producer, which is what makes the second
    // identical read compare clean instead of re-running the cascade.
    const producer = await readTask(taskUrn("clean_orders"));
    expect(producer?.observed?.[datasetUrn("clean_orders")]).toEqual({
      schema: "s1-silent",
      content: "c1",
    });

    const before = (await readTask(taskUrn("audit_orders")))?.stale?.since;
    await startTask(taskUrn("build_revenue"));
    const again = await coordinateCompletion(rereadReport("s1-silent"));

    expect(again.observedChanges).toEqual([]);
    expect(again.affected).toEqual([]);
    expect((await readTask(taskUrn("audit_orders")))?.stale?.since).toBe(before);
  });

  it("marks nothing when the read matches what was recorded", async () => {
    await runAllWithAudit();
    await startTask(taskUrn("build_revenue"));
    const result = await coordinateCompletion({
      ...finished("build_revenue", "daily_revenue", "s2", "c2"),
      inputs: { [datasetUrn("clean_orders")]: { schema: "s1", content: "c1" } },
    });

    expect(result.observedChanges).toEqual([]);
    expect(result.affected).toEqual([]);
    expect((await readTask(taskUrn("audit_orders")))?.stale).toBeNull();
  });
});

describe("only finished work goes stale", () => {
  it("never marks work that is in flight, and stops the walk there", async () => {
    /*
     * A task running now will read the new input itself, so marking it is a false
     * positive, and its outputs are not final, so the walk must not continue through
     * it. Asserted through `startTask` rather than by writing the status directly,
     * because the path that sets `running` is the path that has to keep it.
     */
    await runAll();
    await startTask(taskUrn("build_revenue"));

    const result = await coordinateCompletion(
      finished("clean_orders", "clean_orders", "s1-changed", "c1"),
    );

    expect(result.affected.map((a) => a.task.name)).toEqual([]);
    const revenue = await readTask(taskUrn("build_revenue"));
    expect(revenue?.status).toBe("running");
    expect(revenue?.stale).toBeNull();
    // The walk stopped rather than reaching past it to the leaves it feeds.
    expect((await readTask(taskUrn("write_docs")))?.stale).toBeNull();
    expect(await tagsOn("write_docs")).toEqual([]);
  });

  it("never marks work that has never run", async () => {
    await coordinateCompletion(finished("clean_orders", "clean_orders", "s1", "c1"));
    const result = await coordinateCompletion(
      finished("clean_orders", "clean_orders", "s1-changed", "c1"),
    );
    expect(result.affected).toEqual([]);
  });
});

describe("a run keeps what the next comparison needs", () => {
  it("keeps fingerprints and run outputs through a start, so the diff survives", async () => {
    /*
     * This reverses an earlier decision, and the reversal is the point. `startTask`
     * used to clear `obsel.run.*` so live work could not be captioned with the previous
     * run's row count. Those are exactly the column lists the diff is computed against,
     * so clearing them left every mark with no columns to report while obsel held the
     * names all along.
     */
    await runAll(["order_id", "order_total"]);
    await startTask(taskUrn("clean_orders"));

    const mid = await readTask(taskUrn("clean_orders"));
    expect(mid?.status).toBe("running");
    expect(Object.keys(mid?.fingerprints ?? {})).toHaveLength(1);
    expect(mid?.run?.outputs[datasetUrn("clean_orders")]?.columns).toEqual([
      "order_id",
      "order_total",
    ]);

    await coordinateCompletion(
      finished("clean_orders", "clean_orders", "s1-changed", "c1", ["order_id", "order_total_usd"]),
    );
    expect((await readTask(taskUrn("build_revenue")))?.stale?.columns).toEqual({
      added: ["order_total_usd"],
      removed: ["order_total"],
    });
  });

  it("puts a task back where it was when a run dies without finishing", async () => {
    await runAll();
    await startTask(taskUrn("clean_orders"));

    const { task, reverted } = await abandonTask(taskUrn("clean_orders"));
    expect(reverted).toBe(true);
    expect(task.status).toBe("complete");
    // Its record of what it produced comes back with it, or the next completion has
    // nothing to compare against and a real change reads as a first run.
    expect(Object.keys(task.fingerprints)).toHaveLength(1);
  });

  it("returns an abandoned stale task to stale, not to complete", async () => {
    // A mark is only earned back by a run that succeeds, so a dead run must not clear
    // it — and the tag has to still be there too, or the two halves disagree.
    await runAll();
    await coordinateCompletion(finished("clean_orders", "clean_orders", "s1-changed", "c1"));
    await startTask(taskUrn("write_docs"));

    const { task } = await abandonTask(taskUrn("write_docs"));
    expect(task.status).toBe("stale");
    expect(task.stale).not.toBeNull();
    expect(await tagsOn("write_docs")).toEqual([STALE_TAG_URN]);
  });
});

describe("reset clears both halves, because they live on different aspects", () => {
  it("clears properties and the real tag, and keeps the lineage", async () => {
    /*
     * The properties are on `dataJobInfo` and the tag is on `globalTags`, so clearing
     * one leaves the other. The result is the single most
     * damaging frame the video could contain: DataHub showing a stale badge on a job
     * obsel calls registered.
     */
    await runAll();
    await coordinateCompletion(finished("clean_orders", "clean_orders", "s1-changed", "c1"));
    expect(await tagsOn("write_docs")).toEqual([STALE_TAG_URN]);

    const result = await resetSwarm();

    expect(result.reset).toContain("clean_orders");
    expect(result.tagsCleared.sort()).toEqual(["build_revenue", "write_docs", "write_report"]);

    for (const name of ["clean_orders", "build_revenue", "write_report", "write_docs"]) {
      const task = await readTask(taskUrn(name));
      expect(task?.status, name).toBe("registered");
      expect(task?.stale, name).toBeNull();
      expect(task?.fingerprints, name).toEqual({});
      // Read off the entity, not inferred from the reset's own report.
      expect(await tagsOn(name), name).toEqual([]);
      expect(task?.staleTagged, name).toBe(false);
      // And the edges the next take runs against are untouched.
      expect((task?.reads.length ?? 0) + (task?.writes.length ?? 0), name).toBeGreaterThan(0);
    }
  });

  it("reports no tags cleared rather than claiming it cleared some", async () => {
    await runAll();
    const result = await resetSwarm();
    expect(result.tagsCleared).toEqual([]);
  });
});
