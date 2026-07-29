"use client";

/**
 * A table drawn as its shape, never as its contents.
 *
 * obsel holds no warehouse credentials and never reads a table, so there is no
 * honest way to preview values and this component is built so that there is no
 * dishonest way either: it receives a list of column names and a row count, and
 * nothing else. A cell cannot render a value because no value is ever passed in.
 *
 * The placeholder rows are uniform blocks on purpose. Varying their widths would
 * make the sketch look like it was measured from something, which is exactly the
 * impression the caption then has to argue against. They are all the same, they
 * shimmer, and they read as what they are: room where rows are, unread.
 *
 * The column names, by contrast, are real. They come from the writing agent's own
 * completion report, and they are the most specific thing obsel can truthfully
 * say about what is in a table.
 */

import { useReducedMotion } from "motion/react";

import { useCountUp } from "./use-count-up";
import type { ColumnChange, OutputShape } from "@/src/server/coordinator/types";

import styles from "./schematic.module.css";

/**
 * How many placeholder rows to draw.
 *
 * Capped because the sketch is a fixed-height thing inside a scrolling panel and
 * a table of two thousand rows would push everything below it off the bottom. The
 * exact count is stated in the caption, so the cap costs no information — it is
 * the drawing that is bounded, not the claim.
 */
export const SCHEMATIC_ROW_CAP = 6;

export function schematicRowCount(rows: number): number {
  if (!Number.isFinite(rows) || rows <= 0) return 0;
  return Math.min(Math.floor(rows), SCHEMATIC_ROW_CAP);
}

export interface SchematicColumn {
  name: string;
  state: "current" | "added" | "removed";
}

/**
 * The columns to draw, in the order they are drawn.
 *
 * Current columns keep the writer's reported order, because that order is itself
 * reported and re-sorting it would invent a fact. Removed columns are appended
 * after them: they are not in the table any more, so there is no position in the
 * current shape they could honestly occupy, and putting them last is what makes
 * "these two are gone" readable as a group.
 *
 * `change` null means no mark names this table, and every column comes back
 * `current` — an unchanged table must not be drawn as though something happened
 * to it.
 */
export function schematicColumns(
  columns: string[],
  change: ColumnChange | null,
): SchematicColumn[] {
  if (change === null) {
    return columns.map((name) => ({ name, state: "current" }));
  }

  const added = new Set(change.added);
  const drawn: SchematicColumn[] = columns.map((name) => ({
    name,
    state: added.has(name) ? "added" : "current",
  }));

  // A removed column that somehow still appears in the current shape is not
  // drawn twice; the current shape is the newer report and wins.
  const present = new Set(columns);
  for (const name of change.removed) {
    if (present.has(name)) continue;
    drawn.push({ name, state: "removed" });
  }
  return drawn;
}

/**
 * The sketch, plus the sentence that says what it is.
 *
 * `changeKey` identifies the reported shape rather than the numbers in it, so the
 * row count is counted up once when a new report lands and not again on every
 * poll that re-serves the same one.
 */
export function Schematic({
  shape,
  change = null,
  changeKey,
}: {
  shape: OutputShape;
  /** The column diff from the mark naming this table, when one stands. */
  change?: ColumnChange | null;
  changeKey: string;
}) {
  const still = useReducedMotion() === true;
  const columns = schematicColumns(shape.columns, change);
  const rows = schematicRowCount(shape.rows);
  const counted = useCountUp(shape.rows, changeKey, !still);

  return (
    <div className={styles.schematic}>
      <div className={styles.scroll}>
        {/*
          Columns sized to their names, never to an even share of the width.
          `1fr` columns let a long name overflow its track and land on top of
          its neighbour, and two column names overlapping is not a cosmetic
          fault: it renders a name that is neither of the two real ones. The
          sketch scrolls sideways instead, and the caption states the true
          column count so nothing is hidden by the scroll.
        */}
        <div
          className={styles.grid}
          style={{ gridTemplateColumns: `repeat(${Math.max(columns.length, 1)}, max-content)` }}
        >
          {columns.map((column) => (
            <div
              key={`${column.state}:${column.name}`}
              className={`${styles.column} ${
                column.state === "added"
                  ? styles.added
                  : column.state === "removed"
                    ? styles.removed
                    : ""
              }`}
            >
              <span className={styles.columnName}>
                {column.state === "added" ? "+ " : column.state === "removed" ? "- " : ""}
                {column.name}
              </span>
              {/*
                Decoration, and only decoration: aria-hidden because a screen
                reader announcing six empty cells per column would be reading out
                the absence of data as though it were data. The caption below
                carries the whole claim in words.
              */}
              <div className={styles.cells} aria-hidden="true">
                {/* A removed column has no rows now, so it is drawn as a header
                    with nothing under it. */}
                {column.state === "removed"
                  ? null
                  : Array.from({ length: rows }, (_, index) => (
                      <span
                        key={index}
                        className={styles.cell}
                        style={{ ["--row" as string]: String(index) }}
                      />
                    ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <p className={styles.caption}>
        a sketch of {shape.columns.length} {shape.columns.length === 1 ? "column" : "columns"} and{" "}
        {counted ?? shape.rows} {shape.rows === 1 ? "row" : "rows"}, from what the writer last
        reported. obsel never reads the table itself.
      </p>
    </div>
  );
}
