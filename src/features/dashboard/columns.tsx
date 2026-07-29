"use client";

/**
 * A table's column names, and which of them arrived or left.
 *
 * This was a drawing called `Schematic`: column names over six blank blocks per
 * column, standing in for rows, inside a bordered box under a heading reading
 * "shape". The blocks went first — they stated nothing the panel's own fields did
 * not state better, and grey blocks in a column are how the rest of the web
 * spells "loading" — and the box and the heading went with them, because a
 * container around a single line of names is scaffolding for something that is
 * no longer there. What was ever real is here: the names.
 *
 * They come from the writing agent's own completion report, and they are the
 * most specific thing obsel can truthfully say about what is in a table. obsel
 * holds no warehouse credentials and never reads one. Nothing is passed to this
 * component but names, so no value can be rendered by it.
 */

import type { ColumnChange } from "@/src/server/coordinator/types";

import styles from "./columns.module.css";

export interface ColumnState {
  name: string;
  state: "current" | "added" | "removed";
}

/**
 * The names to show, in the order they are shown.
 *
 * Current columns keep the writer's reported order, because that order is itself
 * reported and re-sorting it would invent a fact. Removed columns are appended
 * after them: they are not in the table any more, so there is no position in the
 * current shape they could honestly occupy, and putting them last is what makes
 * "these two are gone" readable as a group.
 *
 * `change` null means no mark names this table, and every column comes back
 * `current` — an unchanged table must not be shown as though something happened
 * to it.
 */
export function columnStates(columns: string[], change: ColumnChange | null): ColumnState[] {
  if (change === null) {
    return columns.map((name) => ({ name, state: "current" }));
  }

  const added = new Set(change.added);
  const named: ColumnState[] = columns.map((name) => ({
    name,
    state: added.has(name) ? "added" : "current",
  }));

  // A removed column that somehow still appears in the current shape is not
  // listed twice; the current shape is the newer report and wins.
  const present = new Set(columns);
  for (const name of change.removed) {
    if (present.has(name)) continue;
    named.push({ name, state: "removed" });
  }
  return named;
}

export function ColumnNames({
  columns,
  change = null,
}: {
  columns: string[];
  /** The column diff from the mark naming this table, when one stands. */
  change?: ColumnChange | null;
}) {
  const named = columnStates(columns, change);

  return (
    /*
     * Wrapping, never scrolling sideways. The names used to sit in `max-content`
     * grid tracks so that a long one could not overflow its track and land on
     * top of its neighbour, which would render a name that is neither of the two
     * real ones. Inline names cannot overlap, so a wide table simply takes more
     * lines of the panel.
     */
    <span className={styles.names}>
      {named.map((column) => (
        <span
          key={`${column.state}:${column.name}`}
          className={
            column.state === "added"
              ? styles.added
              : column.state === "removed"
                ? styles.removed
                : styles.name
          }
        >
          {column.state === "added" ? "+ " : column.state === "removed" ? "- " : ""}
          {column.name}
        </span>
      ))}
    </span>
  );
}
