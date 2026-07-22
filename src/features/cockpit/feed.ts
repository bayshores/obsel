/**
 * What changed between two reads of the swarm.
 *
 * Pure. Two snapshots in, a list of events out, no clock and no counter — the
 * same pair of snapshots always produces the same events with the same ids.
 *
 * ## The honesty boundary
 *
 * This is a diff of two JSON bodies polled a second apart. It can establish
 * that a field differs from the previous successful read, and **nothing else**.
 * It did not witness obsel read the lineage graph, compare a fingerprint, walk
 * the cascade, or poll DataHub until a write was confirmed. None of that is in
 * the payload. The panel says so in as many words, and the panel is not called
 * a "recorder" or a "log", because one word in a title can undo a paragraph of
 * disclosure beneath it.
 *
 * ## The absence trap
 *
 * `coordinateCompletion` writes the finishing task's new fingerprints and its
 * `complete` status BEFORE it writes any stale mark. So there is a reliable
 * window, at least one poll wide, in which a diff can truthfully observe "a new
 * output was recorded and nothing was marked" — while the cascade that is about
 * to mark three tasks is still in flight.
 *
 * That observation is true and the obvious sentence for it is a lie. **No event
 * here asserts an absence.** Every event states something that appeared or
 * changed; none of them says nothing happened, nothing was marked, or anything
 * is clear. A viewer inferring "no news is good news" from a quiet feed is a
 * risk this module cannot remove, which is why the panel carries the
 * disclosure rather than relying on the rows to imply it.
 */

import type { StaleMark, SwarmSnapshot, TaskRecord } from "@/src/server/coordinator/types";

export type FeedEventKind =
  /** Present in this read, absent from the previous one. */
  | "appeared"
  /** Moved to `running`. */
  | "started"
  /** Moved to `complete` without having carried a mark. */
  | "finished"
  /** Moved to `stale`. The one event that carries its cause. */
  | "went-stale"
  /** Was carrying a mark and is no longer. */
  | "cleared"
  /** A recorded output fingerprint differs from the previous read's. */
  | "output-changed"
  /** Absent from this read, present in the previous one. */
  | "left";

export interface FeedEvent {
  /**
   * Derived from the data, never from a counter or a clock, so React keys are
   * stable across re-renders and the same diff twice is idempotent.
   */
  id: string;
  kind: FeedEventKind;
  taskUrn: string;
  taskName: string;
  /**
   * The coordinator's own stamp on the snapshot this was observed in.
   *
   * Never a browser clock. The browser knows when it received a body, which is
   * a different quantity from when the state it describes became true, and
   * labelling one as the other is the kind of small lie this whole panel exists
   * to avoid.
   */
  observedAt: string;
  /** Which output moved, on `output-changed`. */
  dataset: string | null;
  /** The mark as written, on `went-stale`. Quoted, never re-derived. */
  mark: StaleMark | null;
}

/** How many events the panel keeps. Older ones are dropped, and it says so. */
export const FEED_LIMIT = 40;

function statusEvent(before: TaskRecord, after: TaskRecord): FeedEventKind | null {
  if (before.status !== after.status) {
    if (after.status === "stale") return "went-stale";
    if (after.status === "running") return "started";
    if (after.status === "complete") return before.stale !== null ? "cleared" : "finished";
    return null;
  }
  // Same status, but a mark it was carrying is gone — a re-run that succeeded.
  if (before.stale !== null && after.stale === null) return "cleared";
  return null;
}

/**
 * Every output whose recorded fingerprint differs between the two reads.
 *
 * A fingerprint appearing for the first time is deliberately NOT a change, and
 * mirrors `compareFingerprints` returning null on a first run: there was
 * nothing to compare it against, so nothing moved.
 */
function changedOutputs(before: TaskRecord, after: TaskRecord): string[] {
  const moved: string[] = [];
  for (const dataset of Object.keys(after.fingerprints).sort()) {
    const was = before.fingerprints[dataset];
    const now = after.fingerprints[dataset];
    if (was === undefined) continue;
    if (was.schema !== now.schema || was.content !== now.content) moved.push(dataset);
  }
  return moved;
}

/**
 * Diff two consecutive reads.
 *
 * Ordering is deterministic — tasks in the order the snapshot lists them, then
 * departures — so two runs over the same pair produce an identical list. There
 * is no sort by time, because every event in one diff shares one `observedAt`.
 */
export function diffSnapshots(before: SwarmSnapshot | null, after: SwarmSnapshot): FeedEvent[] {
  // The first read invents no history. There is no previous state to compare
  // against, and a feed opening with four "finished" rows would be claiming to
  // have watched something it was not there for.
  if (before === null) return [];

  const was = new Map(before.tasks.map((task) => [task.urn, task]));
  const events: FeedEvent[] = [];

  const push = (
    kind: FeedEventKind,
    task: TaskRecord,
    extra: { dataset?: string; mark?: StaleMark | null } = {},
  ): void => {
    events.push({
      id: `${task.urn}@${after.at}#${kind}${extra.dataset === undefined ? "" : `:${extra.dataset}`}`,
      kind,
      taskUrn: task.urn,
      taskName: task.name,
      observedAt: after.at,
      dataset: extra.dataset ?? null,
      mark: extra.mark ?? null,
    });
  };

  for (const task of after.tasks) {
    const previous = was.get(task.urn);
    if (previous === undefined) {
      // "appeared", never "was registered": obsel may have registered it many
      // reads before this cockpit was open.
      push("appeared", task);
      continue;
    }

    const kind = statusEvent(previous, task);
    if (kind !== null) push(kind, task, { mark: kind === "went-stale" ? task.stale : null });

    for (const dataset of changedOutputs(previous, task)) {
      push("output-changed", task, { dataset });
    }
  }

  const present = new Set(after.tasks.map((task) => task.urn));
  for (const task of before.tasks) {
    // "left", never "was deleted": it is absent from a list, which is all a
    // diff of two lists can tell anyone.
    if (!present.has(task.urn)) push("left", task);
  }

  return events;
}

/** Newest first, capped. Returns the same array identity when nothing is new. */
export function appendEvents(existing: FeedEvent[], incoming: FeedEvent[]): FeedEvent[] {
  if (incoming.length === 0) return existing;
  const seen = new Set(existing.map((event) => event.id));
  const fresh = incoming.filter((event) => !seen.has(event.id));
  if (fresh.length === 0) return existing;
  return [...fresh.reverse(), ...existing].slice(0, FEED_LIMIT);
}
