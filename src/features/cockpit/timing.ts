/**
 * The numbers the stat ribbon reports, derived from a snapshot.
 *
 * Pure, so every claim the cockpit makes about a measurement can be tested
 * without a browser. The rule these functions exist to keep is that obsel never
 * shows a number it did not measure — a plausible-looking figure is worse than
 * an em dash, because a viewer cannot tell it is invented.
 */

import type { StaleMark, TaskRecord } from "@/src/server/coordinator/types";

export interface DetectionTiming {
  /** Coordinator-measured ms: report received, to marks confirmed in DataHub. */
  ms: number;
  /** Name of the task whose output changed. */
  source: string;
  /** How many tasks that one change invalidated. */
  flagged: number;
}

export interface SwarmTotals {
  tasks: number;
  finished: number;
  stale: number;
  timing: DetectionTiming | null;
  /** Tasks carrying an unresolved mark of obsel's own. */
  marked: number;
  /**
   * How many of those DataHub confirms it tagged.
   *
   * **Null means obsel does not know**, not zero. A snapshot captured before
   * `tags` existed carries no tag information at all, and reporting `0 of 3` there
   * would claim DataHub is missing three tags obsel never actually looked for.
   * Understating obsel's own contribution is still a false claim.
   */
  tagged: number | null;
  /**
   * Tasks DataHub reports as tagged that carry no mark. Null under the same
   * not-recorded rule as `tagged`.
   *
   * Unlike a shortfall in `tagged`, this never resolves itself by waiting. It is
   * the reset-by-hand fault `docs/demo-script.md` calls the most damaging frame the
   * video could contain: a tag from a previous take still on the entity while
   * obsel's own properties say the task is clean.
   */
  leftOver: number | null;
}

/**
 * A wall-clock time, as every surface in the cockpit renders it.
 *
 * One function because there must be exactly one answer. The graph and the
 * ledger show the same instants, and an earlier version had them disagree —
 * the graph formatted UTC while the ledger formatted local, so `clean_orders`
 * appeared to have finished at 00:23:52 in one panel and 5:23:52 PM in the
 * other. On a screen whose entire purpose is establishing what happened when,
 * that is not a cosmetic defect.
 *
 * 24-hour, so the string is always eight characters: the graph reserves box
 * width from a character count, and "5:23:52 PM" is not the same width as
 * "17:23:52".
 */
export function clockTime(iso: string | null): string {
  if (iso === null) return "--:--:--";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "--:--:--";
  return at.toLocaleTimeString([], { hour12: false });
}

/**
 * The change the cockpit is currently talking about: the most recent mark.
 *
 * There must be exactly one answer to "which change?", because several surfaces
 * ask it — the graph outlines that dataset and captions it `changed · schema`,
 * and the stat ribbon reports the time it took to detect it. Those two used
 * different rules: the graph took the first mark in dependency order, the
 * ribbon took the newest. With one cascade on the board they agree by accident.
 * With two, the graph captions one dataset while the ribbon times the other,
 * and the cockpit contradicts itself on screen with no indication which half is
 * right.
 *
 * Marks carried by tasks that are not themselves stale are excluded: a stale
 * task being re-run keeps its mark while it works, and work in the middle of
 * being fixed does not define what is currently wrong.
 *
 * Ties are broken on `causedBy` so the answer never depends on array order —
 * two marks stamped in the same second are otherwise a coin flip that could
 * change between polls and flicker the caption.
 */
export function currentChange(tasks: TaskRecord[]): StaleMark | null {
  const marks = marksOf(tasks);
  if (marks.length === 0) return null;
  return marks.reduce((best, mark) => {
    const a = Date.parse(mark.since);
    const b = Date.parse(best.since);
    if (Number.isNaN(a)) return best;
    if (Number.isNaN(b) || a > b) return mark;
    if (a === b && mark.causedBy < best.causedBy) return mark;
    return best;
  });
}

function marksOf(tasks: TaskRecord[]): StaleMark[] {
  return tasks
    .filter((task) => task.status === "stale")
    .map((task) => task.stale)
    .filter((mark): mark is StaleMark => mark !== null);
}

/**
 * How long detection took, taken from the number the coordinator measured.
 *
 * `detectedMs` is recorded onto the mark itself and covers the whole job: the
 * completion report arriving, the graph being read, the decision, and every
 * mark written and confirmed in DataHub.
 *
 * An earlier version of this subtracted the changed task's `finishedAt` from
 * `mark.since`. That was wrong twice over. The two timestamps are stamped in
 * different processes, and `since` is captured before any write happens — so
 * the figure excluded the very writes the sentence claimed to be timing. It
 * also went negative as soon as the upstream task ran again, which deleted the
 * number from the screen during the demo's closing shot while three tasks sat
 * there flagged.
 *
 * Returns null rather than a guess whenever the measurement is unavailable.
 */
export function detectionTiming(tasks: TaskRecord[]): DetectionTiming | null {
  const marks = marksOf(tasks);
  const newest = currentChange(tasks);
  if (newest === null) return null;

  const causeUrn = newest.causedByTask;
  if (causeUrn === null) return null;

  const cause = tasks.find((task) => task.urn === causeUrn);
  if (cause === undefined) return null;

  const fromSameChange = marks.filter((mark) => mark.causedByTask === causeUrn);
  const measured = fromSameChange
    .map((mark) => mark.detectedMs)
    .filter((ms): ms is number => typeof ms === "number" && Number.isFinite(ms) && ms >= 0);

  // A mark written before detectedMs was recorded has no measurement, and the
  // cockpit says so rather than inventing one.
  if (measured.length === 0) return null;

  return { ms: Math.max(...measured), source: cause.name, flagged: fromSameChange.length };
}

/**
 * Every count the stat ribbon shows, from one pass over the snapshot.
 *
 * `deepestReach` used to be here, the maximum hop count across every mark. It was
 * removed rather than kept: the graph labels each marked box with its own `· N
 * hops`, so the ribbon was restating the largest number already on screen.
 */
export function totals(tasks: TaskRecord[]): SwarmTotals {
  // A freshly read task always has a `tags` array, empty or not. All of them
  // lacking the key means this snapshot predates obsel reading tags back, which is
  // not the same as DataHub holding none.
  const tagsKnown = tasks.some((task) => task.tags !== undefined);
  const marked = tasks.filter((task) => task.stale !== null);

  return {
    tasks: tasks.length,
    finished: tasks.filter((t) => t.status === "complete" || t.status === "stale").length,
    stale: tasks.filter((t) => t.status === "stale").length,
    timing: detectionTiming(tasks),
    marked: marked.length,
    tagged: tagsKnown ? marked.filter((task) => task.staleTagged === true).length : null,
    leftOver: tagsKnown
      ? tasks.filter((task) => task.staleTagged === true && task.stale === null).length
      : null,
  };
}

/**
 * Sort tasks so a reader can follow the pipeline top to bottom: a task appears
 * after whatever produces the data it reads.
 *
 * Layer by layer rather than a plain depth-first walk, so tasks at the same
 * distance from the source sit together, and alphabetically inside a layer so
 * the order does not jitter between polls. A cycle must not drop tasks off the
 * board, so anything left over is appended in a stable order.
 */
export function inDependencyOrder(tasks: TaskRecord[]): TaskRecord[] {
  const producerOf = new Map<string, string>();
  for (const task of tasks) {
    for (const output of task.writes) producerOf.set(output, task.urn);
  }

  const dependencies = new Map<string, string[]>();
  for (const task of tasks) {
    dependencies.set(
      task.urn,
      task.reads
        .map((input) => producerOf.get(input))
        .filter((urn): urn is string => urn !== undefined && urn !== task.urn),
    );
  }

  const byName = (a: TaskRecord, b: TaskRecord): number => a.name.localeCompare(b.name);
  const ordered: TaskRecord[] = [];
  const placed = new Set<string>();
  let remaining = [...tasks];

  while (remaining.length > 0) {
    const layer = remaining
      .filter((task) => (dependencies.get(task.urn) ?? []).every((urn) => placed.has(urn)))
      .sort(byName);

    if (layer.length === 0) {
      ordered.push(...[...remaining].sort(byName));
      break;
    }

    for (const task of layer) {
      ordered.push(task);
      placed.add(task.urn);
    }
    remaining = remaining.filter((task) => !placed.has(task.urn));
  }

  return ordered;
}

/**
 * The sentence under the stale count.
 *
 * Every branch states what was actually observed. There is deliberately no
 * "all clear" phrasing for the case where nothing has finished yet — nothing
 * being stale because nothing has run is not the same claim as nothing being
 * stale because everything checks out.
 */
export function summaryLine(total: number, finished: number, stale: number): string {
  if (total === 0) return "No tasks registered yet.";
  if (finished === 0) {
    return `No task has finished yet, so there is nothing that could be out of date. ${total} registered.`;
  }
  if (stale === 0) {
    return `${finished} of ${total} ${total === 1 ? "task has" : "tasks have"} finished, and everything they were built on is still true.`;
  }
  return `${stale} of ${finished} finished ${finished === 1 ? "task is" : "tasks are"} built on something that has since changed.`;
}
