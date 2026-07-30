/**
 * What one recorded decision reads as, once it is a row.
 *
 * Two rules these hold. **Newest first**, because a reader arriving at a history
 * came for the last thing that happened, which is the opposite of the activity
 * feed beside it and deliberately so. And **a record obsel wrote is never
 * silently dropped**: a body this build cannot parse renders as a row that says
 * so, because a gap in a history reads as "nothing happened here", which is the
 * exact wrong answer this whole feature exists to remove.
 */

import { describe, expect, it } from "vitest";

import { historyRows } from "@/src/features/dashboard/history";
import type { ChangeBody, ChangeEntry } from "@/src/server/coordinator/change-ledger";

const AT = "2026-07-29T12:00:00.000Z";

function ds(name: string): string {
  return `urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.${name},PROD)`;
}

function body(overrides: Partial<ChangeBody> = {}): ChangeBody {
  return {
    event: "marked",
    at: AT,
    source: "completion",
    reporter: { taskUrn: "urn:task:clean_orders", name: "clean_orders" },
    changes: [{ dataset: ds("clean_orders"), kind: "schema" }],
    affected: [
      {
        taskUrn: "urn:task:build_revenue",
        name: "build_revenue",
        hops: 1,
        causedBy: ds("clean_orders"),
        reason: "clean orders changed after this finished",
      },
    ],
    restored: [],
    elapsedMs: 412,
    ...overrides,
  };
}

function entry(sequence: number, value: ChangeBody | null): ChangeEntry {
  return { sequence, urn: `urn:li:document:obsel.change.board_abc.${sequence}`, body: value };
}

describe("the order a history is read in", () => {
  it("puts the newest record first", () => {
    const rows = historyRows([
      entry(1, body({ at: "2026-07-29T10:00:00.000Z" })),
      entry(2, body({ at: "2026-07-29T11:00:00.000Z" })),
      entry(3, body({ at: AT })),
    ]);

    expect(rows.map((row) => row.sequence)).toEqual([3, 2, 1]);
  });

  it("has no rows for a board nothing has happened on", () => {
    expect(historyRows([])).toEqual([]);
  });
});

describe("what a row says happened", () => {
  it("counts the flagged work rather than listing it twice", () => {
    // The headline counts and the lines below name. A headline that listed the
    // tasks would be the same fact twice on one surface.
    const rows = historyRows([
      entry(
        1,
        body({
          affected: [
            {
              taskUrn: "urn:1",
              name: "build_revenue",
              hops: 1,
              causedBy: ds("clean_orders"),
              reason: "r",
            },
            {
              taskUrn: "urn:2",
              name: "write_docs",
              hops: 2,
              causedBy: ds("clean_orders"),
              reason: "r",
            },
          ],
        }),
      ),
    ]);

    expect(rows[0].headline).toBe("2 tasks went out of date");
    expect(rows[0].headline).not.toContain("build_revenue");
    expect(rows[0].affected).toEqual(["build_revenue (1 hop)", "write_docs (2 hops)"]);
  });

  it("agrees its nouns with one task and one flag", () => {
    const marked = historyRows([entry(1, body())])[0];
    expect(marked.headline).toBe("1 task went out of date");

    const cleared = historyRows([
      entry(
        1,
        body({
          event: "cleared",
          affected: [],
          restored: [{ taskUrn: "u", name: "write_docs", reason: "identical redo" }],
        }),
      ),
    ])[0];
    expect(cleared.headline).toBe("1 flag came off");
  });

  it("says both halves when one decision flagged and cleared, flag first", () => {
    const row = historyRows([
      entry(
        1,
        body({
          restored: [{ taskUrn: "u", name: "write_docs", reason: "identical redo" }],
        }),
      ),
    ])[0];

    expect(row.headline).toBe("1 task went out of date, 1 flag came off");
    expect(row.restored).toEqual(["write_docs"]);
  });

  it("names the table that moved and how, in words rather than a hash", () => {
    const row = historyRows([entry(1, body())])[0];

    expect(row.cause).toBe("clean orders: columns changed — reported by clean_orders");
    expect(row.cause).not.toMatch(/[0-9a-f]{12}/);
  });

  it("says an outside observation reported it, rather than naming a task", () => {
    // Blaming the producer would be wrong: it never reported writing those bytes.
    const row = historyRows([
      entry(
        1,
        body({
          source: "observation",
          reporter: undefined,
          changes: [
            {
              dataset: ds("clean_orders"),
              kind: "content",
              unreported: { noticedBy: null },
            },
          ],
        }),
      ),
    ])[0];

    expect(row.cause).toContain("an outside observation");
    expect(row.cause).toContain("nothing reported");
  });

  it("names the reader whose read exposed an unreported change", () => {
    const row = historyRows([
      entry(
        1,
        body({
          changes: [
            {
              dataset: ds("clean_orders"),
              kind: "content",
              unreported: { noticedBy: "audit_orders" },
            },
          ],
        }),
      ),
    ])[0];

    expect(row.cause).toContain("audit_orders found by reading it");
  });

  it("carries the column diff, and nothing when the record has none", () => {
    const withColumns = historyRows([
      entry(
        1,
        body({
          changes: [
            {
              dataset: ds("clean_orders"),
              kind: "schema",
              columns: { added: ["order_total_usd"], removed: ["order_total"] },
            },
          ],
        }),
      ),
    ])[0];
    expect(withColumns.columns).toBe("left: order_total · arrived: order_total_usd");

    expect(historyRows([entry(1, body())])[0].columns).toBeNull();
  });

  it("reports the measured duration as obsel measured it", () => {
    expect(historyRows([entry(1, body({ elapsedMs: 5399 }))])[0].elapsedMs).toBe(5399);
  });
});

describe("a record this page cannot read", () => {
  it("keeps its row and says so, rather than vanishing", () => {
    // The failure mode being avoided: dropping it would make the history claim
    // fewer decisions happened than obsel recorded.
    const rows = historyRows([entry(1, null), entry(2, body())]);

    expect(rows).toHaveLength(2);
    const unreadable = rows.find((row) => row.sequence === 1);
    expect(unreadable?.headline).toContain("cannot read");
    expect(unreadable?.event).toBeNull();
    // And it still points at the record, so a reader can open it in DataHub.
    expect(unreadable?.urn).toContain("obsel.change.");
  });

  it("claims nothing about a record it could not parse", () => {
    const row = historyRows([entry(1, null)])[0];

    expect(row.affected).toEqual([]);
    expect(row.restored).toEqual([]);
    expect(row.cause).toBeNull();
    expect(row.columns).toBeNull();
    expect(row.elapsedMs).toBeNull();
    expect(row.at).toBeNull();
  });
});
