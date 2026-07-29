/**
 * What to redo, and in what order, when a change has left work flagged.
 *
 * obsel says what is out of date and refuses to say it is fine again without
 * the work being redone. That is the correct half to be strict about, and on
 * its own it hands somebody a list of flagged tasks and a graph to hold in
 * their head: redo the wrong one first and its output is built on an input that
 * is itself about to be rebuilt, so it comes out wrong and gets flagged again
 * by the redo of the task above it.
 *
 * This derives the order. It is not a scheduler and does not become one: it
 * starts nothing, writes nothing, and has no route or tool that accepts a task.
 * The output is a reading of the snapshot, exactly like `readyToStart` and
 * `blocked` beside it in `staleness.ts`.
 *
 * **Nothing here clears a flag or can be made to.** A plan naming a task is not
 * a claim about that task's soundness; it is a claim about ordering. The only
 * things that take a flag off are the flagged task's own redo and the derived
 * restoration in `restoredBy`, and both require work to have actually happened.
 *
 * Pure, like `staleness.ts`, and unmarked by `server-only` for the same reason:
 * the shapes have to be nameable by browser code even though nothing there
 * renders them today.
 */

import { producersOf } from "./staleness";
import type { SwarmSnapshot, TaskRecord } from "./types";

/** One task to redo, with enough of its record to act without a second lookup. */
export interface RerunPlanEntry {
  urn: string;
  name: string;
  title: string | null;
  reads: string[];
  writes: string[];
  /**
   * The dataset the task's primary mark blames, or null when the record has no
   * mark to read. Carried so a plan row can be traced back to the change that
   * caused it without joining against the snapshot again.
   */
  causedBy: string | null;
}

export interface RerunPlan {
  /**
   * Flagged tasks in waves. Everything in wave N reads nothing that a flagged
   * task in a later wave writes, so a wave can be redone in any internal order,
   * or all at once, and each task's inputs are settled before it runs.
   */
  waves: RerunPlanEntry[][];
  /**
   * The URNs in wave 0 whose every input is genuinely settled right now.
   *
   * Not the same as "wave 0". A wave-0 task has no FLAGGED task upstream, which
   * is what the ordering is about; it can still be waiting on an unflagged
   * producer that is mid-run, and starting it then reads a version about to be
   * replaced. Same rule as `readyToStart`, applied to flagged work.
   */
  startableNow: string[];
  /**
   * Flagged tasks that could not be ordered, because they sit in a cycle of
   * flagged work.
   *
   * Reported rather than dropped, and rather than being forced into an
   * arbitrary wave. A cycle has no correct order, and inventing one would put a
   * task in front of an input it genuinely depends on. Somebody has to break
   * the loop; obsel says which tasks it is.
   */
  cyclic: RerunPlanEntry[];
}

function entryFor(task: TaskRecord): RerunPlanEntry {
  return {
    urn: task.urn,
    name: task.name,
    title: task.title ?? null,
    reads: [...task.reads],
    writes: [...task.writes],
    causedBy: task.stale?.causedBy ?? null,
  };
}

/** Sorted by URN throughout, so a plan does not jitter between identical polls. */
function byUrn(a: TaskRecord, b: TaskRecord): number {
  return a.urn.localeCompare(b.urn);
}

/**
 * The order to redo flagged work in, from one snapshot.
 *
 * The edge that decides ordering is "this flagged task reads a dataset that
 * flagged task writes". Unflagged producers are not edges: their output is not
 * about to change, so nothing waits on them for ordering purposes, though
 * `startableNow` still refuses a task whose unflagged producer is mid-run.
 *
 * Producers come from `producersOf`, which keeps EVERY writer of a dataset. The
 * browser's `inDependencyOrder` keeps only the last writer registered, which is
 * fine for laying boxes out on a canvas and is not fine here: a task waiting on
 * two writers of one table must come after both, and keeping one of them would
 * order it ahead of work its input genuinely depends on.
 */
export function rerunPlan(snapshot: SwarmSnapshot): RerunPlan {
  const flagged = snapshot.tasks.filter((task) => task.status === "stale").sort(byUrn);
  if (flagged.length === 0) return { waves: [], startableNow: [], cyclic: [] };

  const producers = producersOf(snapshot);
  const flaggedUrns = new Set(flagged.map((task) => task.urn));

  // Which flagged tasks each flagged task must follow. Self-edges are dropped:
  // a task that reads a table it also writes does not wait for itself, and
  // keeping the edge would put every such task in the cycle report.
  const waitsFor = new Map<string, Set<string>>();
  for (const task of flagged) {
    const upstream = new Set<string>();
    for (const input of task.reads) {
      for (const writer of producers.get(input) ?? []) {
        if (writer.urn !== task.urn && flaggedUrns.has(writer.urn)) upstream.add(writer.urn);
      }
    }
    waitsFor.set(task.urn, upstream);
  }

  const waves: RerunPlanEntry[][] = [];
  const placed = new Set<string>();
  let remaining = flagged;

  while (remaining.length > 0) {
    const wave = remaining.filter((task) =>
      [...(waitsFor.get(task.urn) ?? [])].every((urn) => placed.has(urn)),
    );
    // Nothing placeable and work left over: every remaining task is waiting on
    // another one that is also waiting. That is a cycle, and it terminates the
    // loop rather than spinning it.
    if (wave.length === 0) {
      return {
        waves,
        startableNow: startable(waves[0] ?? [], snapshot, producers),
        cyclic: remaining.map(entryFor),
      };
    }
    waves.push(wave.map(entryFor));
    for (const task of wave) placed.add(task.urn);
    remaining = remaining.filter((task) => !placed.has(task.urn));
  }

  return { waves, startableNow: startable(waves[0] ?? [], snapshot, producers), cyclic: [] };
}

/**
 * Which of the first wave can actually be started now.
 *
 * A flagged task with no flagged producer can still be waiting on an ordinary
 * one that has not finished. `readyToStart` keeps the same rule for registered
 * work, and the reason is the same: reading a table a producer is part way
 * through writing reads a version that is about to be replaced.
 */
function startable(
  wave: RerunPlanEntry[],
  snapshot: SwarmSnapshot,
  producers: Map<string, TaskRecord[]>,
): string[] {
  const settled = (input: string, self: string): boolean =>
    (producers.get(input) ?? []).every(
      (producer) =>
        producer.urn === self || producer.status === "complete" || producer.status === "stale",
    );

  return wave
    .filter((entry) => entry.reads.every((input) => settled(input, entry.urn)))
    .map((entry) => entry.urn)
    .sort();
}
