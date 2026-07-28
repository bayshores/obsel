import { describe, expect, it } from "vitest";

import {
  SCHEMATIC_ROW_CAP,
  schematicColumns,
  schematicRowCount,
} from "@/src/features/cockpit/schematic";

describe("schematicRowCount", () => {
  it("draws one block per row up to the cap", () => {
    expect(schematicRowCount(0)).toBe(0);
    expect(schematicRowCount(3)).toBe(3);
    expect(schematicRowCount(SCHEMATIC_ROW_CAP)).toBe(SCHEMATIC_ROW_CAP);
  });

  it("caps a large table, since the caption states the real count", () => {
    expect(schematicRowCount(5000)).toBe(SCHEMATIC_ROW_CAP);
  });

  it("draws nothing for a count that is not a count", () => {
    // Including infinity: a count nobody could have taken is not drawn as
    // though six rows had been reported.
    expect(schematicRowCount(-4)).toBe(0);
    expect(schematicRowCount(Number.NaN)).toBe(0);
    expect(schematicRowCount(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("schematicColumns", () => {
  const columns = ["order_id", "customer", "order_total_usd", "order_date"];

  it("marks nothing when no mark names the table", () => {
    expect(schematicColumns(columns, null)).toEqual([
      { name: "order_id", state: "current" },
      { name: "customer", state: "current" },
      { name: "order_total_usd", state: "current" },
      { name: "order_date", state: "current" },
    ]);
  });

  it("flags what arrived in place, and appends what left", () => {
    const drawn = schematicColumns(columns, {
      added: ["order_total_usd"],
      removed: ["order_total"],
    });

    expect(drawn).toEqual([
      { name: "order_id", state: "current" },
      { name: "customer", state: "current" },
      { name: "order_total_usd", state: "added" },
      { name: "order_date", state: "current" },
      { name: "order_total", state: "removed" },
    ]);
  });

  it("keeps the writer's reported column order", () => {
    const scrambled = ["order_date", "order_id", "customer"];
    const drawn = schematicColumns(scrambled, { added: [], removed: [] });

    expect(drawn.map((column) => column.name)).toEqual(scrambled);
  });

  it("does not draw a removed column that the current shape still has", () => {
    // A stale mark and a newer completion report can disagree; the shape is the
    // newer of the two, and drawing the column twice would show both answers.
    const drawn = schematicColumns(columns, { added: [], removed: ["customer"] });

    expect(drawn.filter((column) => column.name === "customer")).toEqual([
      { name: "customer", state: "current" },
    ]);
  });

  it("handles a content change, which names no columns at all", () => {
    const drawn = schematicColumns(columns, { added: [], removed: [] });

    expect(drawn.every((column) => column.state === "current")).toBe(true);
    expect(drawn).toHaveLength(columns.length);
  });
});
