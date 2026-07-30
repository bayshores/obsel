import { describe, expect, it } from "vitest";

import { columnStates } from "@/src/features/dashboard/details/columns";

/*
 * `schematicRowCount` and its cap were tested here until the thing they sized
 * was removed. Six empty blocks under each column name stated nothing the
 * panel's own fields did not state better, and read as a panel still loading.
 * Nothing bounds this now, because what is shown is the column names.
 */

describe("columnStates", () => {
  const columns = ["order_id", "customer", "order_total_usd", "order_date"];

  it("marks nothing when no mark names the table", () => {
    expect(columnStates(columns, null)).toEqual([
      { name: "order_id", state: "current" },
      { name: "customer", state: "current" },
      { name: "order_total_usd", state: "current" },
      { name: "order_date", state: "current" },
    ]);
  });

  it("flags what arrived in place, and appends what left", () => {
    const named = columnStates(columns, {
      added: ["order_total_usd"],
      removed: ["order_total"],
    });

    expect(named).toEqual([
      { name: "order_id", state: "current" },
      { name: "customer", state: "current" },
      { name: "order_total_usd", state: "added" },
      { name: "order_date", state: "current" },
      { name: "order_total", state: "removed" },
    ]);
  });

  it("keeps the writer's reported column order", () => {
    const scrambled = ["order_date", "order_id", "customer"];
    const named = columnStates(scrambled, { added: [], removed: [] });

    expect(named.map((column) => column.name)).toEqual(scrambled);
  });

  it("does not list a removed column that the current shape still has", () => {
    // A stale mark and a newer completion report can disagree; the shape is the
    // newer of the two, and listing the column twice would show both answers.
    const named = columnStates(columns, { added: [], removed: ["customer"] });

    expect(named.filter((column) => column.name === "customer")).toEqual([
      { name: "customer", state: "current" },
    ]);
  });

  it("handles a content change, which names no columns at all", () => {
    const named = columnStates(columns, { added: [], removed: [] });

    expect(named.every((column) => column.state === "current")).toBe(true);
    expect(named).toHaveLength(columns.length);
  });
});
