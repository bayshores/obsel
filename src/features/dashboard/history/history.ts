/**
 * One change record, as a row a reader can take in at a glance.
 *
 * Pure, and separate from the panel for the reason every other derivation on this
 * board is: what a row says is worth asserting without a browser, and a component
 * that computed its own sentences could only be checked by rendering it.
 *
 * The record is written by the server and read back out of DataHub, so this is
 * also where a record obsel wrote under an older shape has to stay readable. Every
 * field the row leads with is treated as possibly absent, and a row that cannot be
 * read says so rather than rendering as a line of blanks.
 */

import type { ChangeBody, ChangeEntry } from "@/src/server/coordinator/change-ledger";
import { datasetTitle } from "../naming";

export interface HistoryRow {
  /** Sequence within the board, so a reader can refer to one out loud. */
  sequence: number;
  /** The record's DataHub URN, for a reader who wants to open it there. */
  urn: string;
  /** `marked` or `cleared`, or null when the record will not parse. */
  event: "marked" | "cleared" | null;
  /** ISO instant, or null when unreadable. */
  at: string | null;
  /**
   * The headline: what happened, in one sentence, with no identifier in it.
   *
   * Never repeats what the detail lines below it carry — the panel prints this
   * plus the lists, and a headline restating a list would be the same fact twice
   * on one surface.
   */
  headline: string;
  /** Which columns moved, when the record carried a diff. */
  columns: string | null;
  /** The tasks flagged, nearest first, as `name (2 hops)`. */
  affected: string[];
  /** The tasks whose flags came off. */
  restored: string[];
  /** What prompted it, in words. Null when the record does not say. */
  cause: string | null;
  /** obsel's own measurement of the decision, in ms. Null when absent. */
  elapsedMs: number | null;
}

/** Newest first: a reader arriving at a history wants the last thing that happened. */
export function historyRows(entries: ChangeEntry[]): HistoryRow[] {
  return [...entries].reverse().map(rowOf);
}

function rowOf(entry: ChangeEntry): HistoryRow {
  const body = entry.body;

  if (body === null) {
    // Kept as a row rather than dropped. A history that silently omitted a record
    // obsel wrote would claim fewer decisions happened than really did, and a gap
    // that reads as "nothing happened here" is the exact failure this whole
    // feature exists to remove.
    return {
      sequence: entry.sequence,
      urn: entry.urn,
      event: null,
      at: null,
      headline: "obsel recorded a decision here that this page cannot read",
      columns: null,
      affected: [],
      restored: [],
      cause: null,
      elapsedMs: null,
    };
  }

  return {
    sequence: entry.sequence,
    urn: entry.urn,
    event: body.event,
    at: body.at,
    headline: headlineOf(body),
    columns: columnsOf(body),
    affected: body.affected.map(
      (task) => `${task.name} (${task.hops} ${task.hops === 1 ? "hop" : "hops"})`,
    ),
    restored: body.restored.map((task) => task.name),
    cause: causeOf(body),
    elapsedMs: typeof body.elapsedMs === "number" ? body.elapsedMs : null,
  };
}

/**
 * What happened, counted rather than listed.
 *
 * The counts are here and the names are in the lists below, so neither line is
 * the other one again. A decision that both flagged and cleared says both, in
 * that order, because the flag is the half a reader has to act on.
 */
function headlineOf(body: ChangeBody): string {
  const flagged = body.affected.length;
  const cleared = body.restored.length;
  const parts: string[] = [];
  if (flagged > 0) parts.push(`${flagged} ${flagged === 1 ? "task" : "tasks"} went out of date`);
  if (cleared > 0) parts.push(`${cleared} ${cleared === 1 ? "flag" : "flags"} came off`);
  // Not reachable through `changeBody`, which records nothing when both are
  // empty. Handled anyway: this reads records off DataHub, including any obsel
  // wrote under a shape this build did not produce.
  return parts.length === 0 ? "obsel recorded a decision that changed nothing" : parts.join(", ");
}

/** Which table moved, and how, without naming a hash. */
function causeOf(body: ChangeBody): string | null {
  if (body.changes.length === 0) return null;

  const named = body.changes
    .map((change) => {
      const table = datasetTitle(change.dataset);
      const kind =
        change.kind === "schema"
          ? "columns changed"
          : change.kind === "content"
            ? "values changed"
            : change.kind === "both"
              ? "columns and values changed"
              : change.kind;
      // Who noticed, when nobody reported it. `noticedBy: null` and an absent
      // `unreported` are different facts, and only the first is worth a phrase.
      const unreported =
        change.unreported === undefined
          ? ""
          : change.unreported.noticedBy === null
            ? ", which nothing reported and an outside observer found"
            : `, which nothing reported and ${change.unreported.noticedBy} found by reading it`;
      return `${table}: ${kind}${unreported}`;
    })
    .join("; ");

  const source = body.source === "observation" ? "an outside observation" : body.reporter?.name;
  return source === undefined ? named : `${named} — reported by ${source}`;
}

function columnsOf(body: ChangeBody): string | null {
  const parts = body.changes.flatMap((change) => {
    if (!change.columns) return [];
    const words = [
      change.columns.removed.length > 0 ? `left: ${change.columns.removed.join(", ")}` : null,
      change.columns.added.length > 0 ? `arrived: ${change.columns.added.join(", ")}` : null,
    ].filter((word): word is string => word !== null);
    return words.length === 0 ? [] : [words.join(" · ")];
  });
  return parts.length === 0 ? null : parts.join("; ");
}
