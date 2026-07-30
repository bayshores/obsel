/**
 * The board's change history, written to a real DataHub and read back out of it.
 *
 * This is the half of the durable-record work that no unit test can reach.
 * `tests/change-ledger.test.ts` covers what a record says; what has to be proven
 * here is that a real cascade appends one, that a real repair appends the
 * clearance beside it rather than over it, and that the enumeration finds them
 * without touching a search index.
 *
 * **Asserted as a delta, never as an absolute sequence.** Every live file shares
 * one flow, obsel deletes nothing, and the ledger is append-only, so this suite
 * cannot own record 1 on the second run — a test pinned to a fixed sequence
 * number would pass once and then fail forever. Each test reads the history, does
 * one thing, and asserts what arrived.
 *
 * The mutating-verb assertions at the end are the same shape as the erasure
 * suite's "no route marks an asset covered": a ledger a caller could append to
 * would let somebody write "this was cleared" with no work redone, which is the
 * one thing obsel's clearing rule exists to prevent.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { API_TOKEN, startObsel } from "./obsel-server";
import type { ObselServer } from "./obsel-server";
import { requireDataHub, requireStaleTag, requireUvx } from "./reachable";

const { coordinateCompletion, registerTask, resetSwarm } =
  await import("@/src/server/coordinator/engine");
const { readChanges } = await import("@/src/server/coordinator/change-history");
const { readChangesFor, forgetChangeHeads } = await import("@/src/server/datahub/documents");
const { closeMcpClient } = await import("@/src/server/datahub/mcp");
const { datasetUrn, taskUrn, FLOW_ID } = await import("@/src/server/datahub/urns");

import type { ChangeEntry } from "@/src/server/coordinator/change-history";
import type { CompletionReport } from "@/src/server/coordinator/types";

/** Not 3098 or 3099: `run-commands` and `worker` hold those. */
const PORT = 3095;

let obselServer: ObselServer;

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

/** The whole chain finishes, so there is finished work for a change to reach. */
async function runAll(cleanColumns = ["order_id", "order_total"]): Promise<void> {
  await coordinateCompletion(finished("clean_orders", "clean_orders", "s1", "c1", cleanColumns));
  await coordinateCompletion(finished("build_revenue", "daily_revenue", "s2", "c2"));
  await coordinateCompletion(finished("write_report", "revenue_report", "s3", "c3"));
  await coordinateCompletion(finished("write_docs", "pipeline_docs", "s4", "c4"));
}

/** The history right now, straight out of DataHub. */
async function history(): Promise<ChangeEntry[]> {
  // The head cache is per process and this suite writes from this one. Forgetting
  // it costs a re-seed and removes any chance of a stale count deciding a test.
  forgetChangeHeads(FLOW_ID);
  return (await readChanges()).entries;
}

beforeAll(async () => {
  await requireDataHub();
  await requireStaleTag();
  requireUvx();

  // The same graph `engine.live.test.ts` uses. Registration is permanent, so these
  // are almost certainly already members of the flow; re-declaring is idempotent.
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

  obselServer = await startObsel(PORT, FLOW_ID);

  return async () => {
    await obselServer.stop();
    await closeMcpClient();
  };
}, 180_000);

describe("a real cascade writes itself into the ledger", () => {
  it("records the change, its cause, and every task it flagged", async () => {
    await resetSwarm();
    await runAll();
    const before = await history();

    // The demo's own change: one column renamed, values untouched.
    await coordinateCompletion(
      finished("clean_orders", "clean_orders", "s1-renamed", "c1", ["order_id", "order_total_usd"]),
    );

    const after = await history();
    expect(after.length).toBe(before.length + 1);

    const record = after[after.length - 1];
    const body = record.body;
    expect(body).not.toBeNull();
    expect(body?.event).toBe("marked");
    expect(body?.source).toBe("completion");
    expect(body?.reporter?.name).toBe("clean_orders");

    // The cause, named as the dataset that actually moved.
    expect(body?.changes.map((change) => change.dataset)).toEqual([datasetUrn("clean_orders")]);
    expect(body?.changes[0].kind).toBe("schema");
    // The column diff, which exists at no later moment: `recordCompletion`
    // overwrote the previous run's shapes immediately after this was computed.
    expect(body?.changes[0].columns).toEqual({
      added: ["order_total_usd"],
      removed: ["order_total"],
    });

    // Three finished tasks downstream, two of which never read the changed table.
    expect(body?.affected.map((entry) => entry.name).sort()).toEqual([
      "build_revenue",
      "write_docs",
      "write_report",
    ]);
    const indirect = body?.affected.find((entry) => entry.name === "write_docs");
    expect(indirect?.hops).toBe(2);
    expect(indirect?.reason.length).toBeGreaterThan(0);

    // A measured figure, not a derived one.
    expect(body?.elapsedMs).toBeGreaterThan(0);
    // And the record is a real DataHub document a reader can go and open.
    expect(record.urn).toMatch(/^urn:li:document:obsel\.change\./);
  }, 180_000);

  it("appends the clearance beside the marking, and never over it", async () => {
    await resetSwarm();
    await runAll();
    await coordinateCompletion(
      finished("clean_orders", "clean_orders", "s1-renamed", "c1", ["order_id", "order_total_usd"]),
    );
    const afterMark = await history();
    const marking = afterMark[afterMark.length - 1];

    /*
     * The repair, as the demo performs it: the flagged task nearest the change
     * re-runs and its own table comes back byte-identical, so obsel clears the
     * flags on the work built on it without those tasks running at all.
     *
     * `build_revenue` rather than `clean_orders`. Reverting the origin table would
     * be a second change to it, which re-flags its direct readers in the same
     * decision that clears the others — a real case, asserted below, but not the
     * one that produces a clearance on its own.
     */
    await coordinateCompletion(finished("build_revenue", "daily_revenue", "s2", "c2"));

    const afterRepair = await history();
    expect(afterRepair.length).toBe(afterMark.length + 1);

    const clearance = afterRepair[afterRepair.length - 1];
    expect(clearance.body?.event).toBe("cleared");
    expect(clearance.body?.affected).toEqual([]);
    expect(clearance.body?.restored.map((entry) => entry.name).sort()).toEqual([
      "write_docs",
      "write_report",
    ]);
    expect(clearance.body?.restored[0].reason.length).toBeGreaterThan(0);

    /*
     * Append-only, checked rather than assumed. This is the whole reason the
     * history lives in the ledger instead of on the tasks: the marking record has
     * to still say what obsel flagged after the flags themselves are gone. A
     * design that updated a record in place would pass every other assertion in
     * this file and fail this one.
     */
    const reread = afterRepair.find((entry) => entry.urn === marking.urn);
    expect(reread).toBeDefined();
    expect(JSON.stringify(reread?.body)).toBe(JSON.stringify(marking.body));
  }, 180_000);

  it("records a revert as the change it is, not as a repair", async () => {
    await resetSwarm();
    await runAll();
    await coordinateCompletion(
      finished("clean_orders", "clean_orders", "s1-renamed", "c1", ["order_id", "order_total_usd"]),
    );
    const before = await history();

    /*
     * Putting the column back. Tempting to read as undoing the change, and obsel
     * does not: the table moved again, so its readers are flagged again and
     * nothing is cleared. `restoredBy` clears only where a redo came back
     * identical to what is currently recorded, which is a proof that the ground
     * never moved — a revert is a second movement, not a proof.
     *
     * Recorded here because it is the shape a reader is most likely to
     * misinterpret, and because a record claiming this cleared anything would be
     * the history disagreeing with the marks.
     */
    await coordinateCompletion(
      finished("clean_orders", "clean_orders", "s1", "c1", ["order_id", "order_total"]),
    );

    const after = await history();
    expect(after.length).toBe(before.length + 1);

    const body = after[after.length - 1].body;
    expect(body?.event).toBe("marked");
    expect(body?.affected.length).toBeGreaterThan(0);
    expect(body?.restored).toEqual([]);
  }, 180_000);

  it("writes nothing for a completion that decided nothing", async () => {
    await resetSwarm();
    await runAll();
    const before = await history();

    // An identical re-run: the correctness rule the whole project rests on. It
    // marks nothing, so it must record nothing — a history entry per re-run would
    // bury the two entries a reader came for.
    await coordinateCompletion(
      finished("clean_orders", "clean_orders", "s1", "c1", ["order_id", "order_total"]),
    );

    expect((await history()).length).toBe(before.length);
  }, 180_000);
});

describe("the history is read without a search index", () => {
  it("stops at the first genuine 404 rather than trusting a count", async () => {
    const entries = await history();

    // One past the end returns nothing at all. That is the enumeration's only
    // stopping condition, and it is a real 404 from the OpenAPI v3 read rather
    // than an empty search result — the distinction `documents.ts` records,
    // because an unindexed record and an absent one are indistinguishable to a
    // search and mean opposite things.
    const past = await readChangesFor(FLOW_ID, { from: entries.length + 1, limit: 3 });
    expect(past).toEqual([]);

    // And resuming from a known point returns the tail, since a record cannot
    // change once written.
    if (entries.length > 0) {
      const tail = await readChangesFor(FLOW_ID, { from: entries.length, limit: 5 });
      expect(tail).toHaveLength(1);
    }
  }, 120_000);

  it("serves the same history over HTTP as the coordinator reads in process", async () => {
    const answer = await fetch(`${obselServer.url}/api/changes`);
    expect(answer.ok).toBe(true);

    const served = (await answer.json()) as { flowId: string; entries: ChangeEntry[] };
    expect(served.flowId).toBe(FLOW_ID);
    expect(served.entries.length).toBe((await history()).length);
  }, 120_000);
});

describe("nothing can write, edit or clear a record through a route", () => {
  /*
   * The same guard the erasure suite keeps over "no route marks an asset
   * covered", and it exists here for a sharper reason. obsel's clearing rule is
   * that a flag comes off through redone work and nothing else. A ledger a caller
   * could append to would let somebody record "this was cleared" without redoing
   * anything, and a later reader would find a history that contradicts the marks.
   *
   * These are the verbs a later commit adds for convenience, so they are asserted
   * absent rather than assumed absent.
   */
  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "refuses %s on the history",
    async (method) => {
      const answer = await fetch(`${obselServer.url}/api/changes`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_TOKEN}` },
        body: JSON.stringify({ event: "cleared", affected: [] }),
      });

      // Not 2xx under any circumstances, and specifically not with a token: the
      // token gates obsel's mutations, and the point here is that there is no
      // mutation behind this path for a token to authorize.
      expect(answer.ok).toBe(false);
      expect(answer.status).toBe(405);
    },
    60_000,
  );

  it("offers no route that names a task to clear", async () => {
    // The neighbouring shape a caller would reach for next.
    for (const path of ["/api/changes/clear", "/api/changes/1", "/api/history"]) {
      const answer = await fetch(`${obselServer.url}${path}`, { method: "POST" });
      expect(answer.ok, `${path} must not exist`).toBe(false);
    }
  }, 60_000);
});
