/**
 * One table, one volatile list, decided before anything is written.
 *
 * The exclusion list decides what a fingerprint of a table MEANS, and every
 * reader hashes an input under the producer's list looked up off the board. Two
 * tasks that both write one table and declare different lists for it put two
 * incompatible answers on the board for the same question, and the board read
 * that builds the reader-side map has nowhere to go: `volatile_by_dataset` in
 * `agents/mcp_core.py` raises, and every agent reading the board fails until the
 * swarm is reset.
 *
 * Pure input, pure output. The decision here is what the door consults; the
 * round trip through DataHub is `tests/live/volatile.live.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { volatileConflict } from "@/src/server/coordinator/volatile";

function ds(name: string): string {
  return `urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.${name},PROD)`;
}

function board(...entries: [string, Record<string, string[]>][]) {
  return entries.map(([name, volatile]) => ({
    name,
    volatile: Object.fromEntries(Object.entries(volatile).map(([t, c]) => [ds(t), c])),
  }));
}

describe("a declared volatile list against the lists already on the board", () => {
  it("refuses a second writer that excludes a different column", () => {
    const refusal = volatileConflict(
      "load_orders_v2",
      { [ds("orders")]: ["batch_id"] },
      board(["load_orders", { orders: ["loaded_at"] }]),
    );

    expect(refusal).not.toBeNull();
    // Naming all four facts, so the refusal is actionable without a board read.
    expect(refusal).toContain("orders");
    expect(refusal).toContain("load_orders");
    expect(refusal).toContain("load_orders_v2");
    expect(refusal).toContain("loaded_at");
    expect(refusal).toContain("batch_id");
    // The same fact the reader-side door reports, in the same words.
    expect(refusal).toContain("two tasks declare different volatile columns");
  });

  it("accepts the same list written in a different order", () => {
    expect(
      volatileConflict(
        "load_orders_v2",
        { [ds("orders")]: ["row_number", "loaded_at"] },
        board(["load_orders", { orders: ["loaded_at", "row_number"] }]),
      ),
    ).toBeNull();
  });

  it("accepts a table no other task declares anything about", () => {
    expect(
      volatileConflict(
        "load_returns",
        { [ds("returns")]: ["loaded_at"] },
        board(["load_orders", { orders: ["batch_id"] }]),
      ),
    ).toBeNull();
  });

  it("refuses a list that only adds a column to the recorded one", () => {
    // A superset is a different list. It hashes fewer columns, so a real change
    // in the added column would vanish rather than be reported.
    const refusal = volatileConflict(
      "load_orders_v2",
      { [ds("orders")]: ["loaded_at", "amount"] },
      board(["load_orders", { orders: ["loaded_at"] }]),
    );
    expect(refusal).toContain("amount");
  });

  it("refuses a list that drops a column the recorded one excludes", () => {
    expect(
      volatileConflict(
        "load_orders_v2",
        { [ds("orders")]: ["loaded_at"] },
        board(["load_orders", { orders: ["loaded_at", "batch_id"] }]),
      ),
    ).not.toBeNull();
  });

  it("leaves the task's own record to the same-task immutability guard", () => {
    // Re-registering the same name under a changed list is refused in
    // `registerTask` against that task's own record, with a sentence about
    // baselines this one has no standing to write.
    expect(
      volatileConflict(
        "load_orders",
        { [ds("orders")]: ["batch_id"] },
        board(["load_orders", { orders: ["loaded_at"] }]),
      ),
    ).toBeNull();
  });

  it("declares nothing and so conflicts with nothing", () => {
    expect(
      volatileConflict("read_orders", {}, board(["load_orders", { orders: ["loaded_at"] }])),
    ).toBeNull();
  });

  it("ignores tasks that recorded no list at all", () => {
    expect(
      volatileConflict("load_orders", { [ds("orders")]: ["loaded_at"] }, [
        { name: "read_orders" },
        { name: "audit_orders", volatile: {} },
      ]),
    ).toBeNull();
  });

  it("names the same conflict whichever order the board is read in", () => {
    const one = volatileConflict(
      "load_orders_v3",
      { [ds("orders")]: ["batch_id"] },
      board(["a_writer", { orders: ["loaded_at"] }], ["z_writer", { orders: ["loaded_at"] }]),
    );
    const other = volatileConflict(
      "load_orders_v3",
      { [ds("orders")]: ["batch_id"] },
      board(["z_writer", { orders: ["loaded_at"] }], ["a_writer", { orders: ["loaded_at"] }]),
    );
    expect(one).toEqual(other);
  });
});
