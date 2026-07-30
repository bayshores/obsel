/**
 * Change histories, invented.
 *
 * **Invented, not recorded**, and the header says so because the rest of this
 * directory has to be read the same way. These are hand-written bodies in the
 * shape `GET /api/changes` serves, used to put the history panel into states a
 * live board cannot be driven into on demand: a read that failed, a record this
 * build cannot parse, a decision that both flagged and cleared.
 *
 * What that costs, stated plainly: no browser test here proves obsel wrote a
 * record or read one back. `tests/live/change-ledger.live.test.ts` drives a real
 * cascade against a real DataHub, appends the record, and reads it out again;
 * `tests/change-ledger.test.ts` and `tests/dashboard-history.test.ts` cover what
 * a record says and what a row reads as. This file covers only the rendering.
 */

import type {
  ChangeBody,
  ChangeEntry,
  ChangeHistory,
} from "@/src/server/coordinator/change-ledger";

const FLOW = "orders_pipeline";

function ds(name: string): string {
  return `urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.${name},PROD)`;
}

function task(name: string): string {
  return `urn:li:dataJob:(urn:li:dataFlow:(obsel,${FLOW},prod),${name})`;
}

function entry(sequence: number, body: ChangeBody | null): ChangeEntry {
  return {
    sequence,
    urn: `urn:li:document:obsel.change.orders_pipeline_1a2b3c4d.${sequence}`,
    body,
  };
}

function history(entries: ChangeEntry[]): ChangeHistory {
  return { flowId: FLOW, entries };
}

/** A board nothing has happened on. What a judge sees before pressing anything. */
export function noChanges(): ChangeHistory {
  return history([]);
}

/**
 * The demo's own cascade, recorded: one column renamed, three tasks flagged.
 *
 * The figures match the recorded run the rest of this suite uses, so a reader
 * comparing the history against the graph beside it sees one story.
 */
export function cascadeRecorded(): ChangeHistory {
  return history([
    entry(1, {
      event: "marked",
      at: "2026-07-29T14:05:52.244Z",
      source: "completion",
      reporter: { taskUrn: task("clean_orders"), name: "clean_orders" },
      changes: [
        {
          dataset: ds("clean_orders"),
          kind: "schema",
          columns: { added: ["order_total_usd"], removed: ["order_total"] },
        },
      ],
      affected: [
        {
          taskUrn: task("build_revenue"),
          name: "build_revenue",
          hops: 1,
          causedBy: ds("clean_orders"),
          reason: "clean orders changed after this finished",
        },
        {
          taskUrn: task("write_report"),
          name: "write_report",
          hops: 2,
          causedBy: ds("clean_orders"),
          reason: "built on work from Daily revenue, which is itself out of date",
        },
        {
          taskUrn: task("write_docs"),
          name: "write_docs",
          hops: 2,
          causedBy: ds("clean_orders"),
          reason: "built on work from Daily revenue, which is itself out of date",
        },
      ],
      restored: [],
      elapsedMs: 5399,
    }),
  ]);
}

/** The same board after the repair: the marking, and the clearance beside it. */
export function repairRecorded(): ChangeHistory {
  const marked = cascadeRecorded().entries[0];
  return history([
    marked,
    entry(2, {
      event: "cleared",
      at: "2026-07-29T14:09:11.002Z",
      source: "completion",
      reporter: { taskUrn: task("build_revenue"), name: "build_revenue" },
      changes: [],
      affected: [],
      restored: [
        {
          taskUrn: task("write_report"),
          name: "write_report",
          reason: "the redo of Daily revenue came back identical",
        },
        {
          taskUrn: task("write_docs"),
          name: "write_docs",
          reason: "the redo of Daily revenue came back identical",
        },
      ],
      elapsedMs: 1732,
    }),
  ]);
}

/**
 * A change nobody reported, found by an outside observation.
 *
 * The record has to name the observation rather than the table's producer, which
 * never reported writing those bytes.
 */
export function unreportedRecorded(): ChangeHistory {
  return history([
    entry(1, {
      event: "marked",
      at: "2026-07-29T14:20:00.000Z",
      source: "observation",
      changes: [{ dataset: ds("clean_orders"), kind: "content", unreported: { noticedBy: null } }],
      affected: [
        {
          taskUrn: task("build_revenue"),
          name: "build_revenue",
          hops: 1,
          causedBy: ds("clean_orders"),
          reason: "clean orders changed and nothing reported it",
        },
      ],
      restored: [],
      elapsedMs: 880,
    }),
  ]);
}

/**
 * A record obsel wrote that this build cannot parse.
 *
 * The state that decides whether the panel is honest: it has to show a row
 * saying so, because dropping it would claim fewer decisions happened than
 * obsel recorded.
 */
export function unreadableRecorded(): ChangeHistory {
  // The readable one second, so the two carry distinct sequences and distinct
  // urns. The panel keys rows on the urn, and two rows sharing one would collapse
  // into a single row — which is the very disappearance this state exists to
  // prove does not happen.
  return history([entry(1, null), entry(2, cascadeRecorded().entries[0].body)]);
}
