/**
 * Whether the board has a record of an output actually moving.
 *
 * Four things about this are the opposite of what a reader expects, and each one
 * is load-bearing somewhere else in the repository.
 *
 * **It asks whether an output moved, never whether a task completed twice.** The
 * hashes are compared; the presence of the key is not enough. A version that
 * checked `previousFingerprints !== undefined` would pass most tests and be
 * wrong about the one case obsel exists for.
 *
 * **An identical re-run records nothing here**, so this cannot fire on the case
 * obsel exists to stay quiet about. `engine.ts` writes a previous entry only
 * when `compareFingerprints(current, next) !== null`, and that is null when
 * nothing moved, with its own comment saying that replacing it would make
 * "previous" equal "current" and the distinction meaningless. A first
 * completion writes nothing either, because there is no current to supersede.
 *
 * **It reads false again only because `resetSwarm` nulls the property.** That
 * null, in the reset list in `engine.ts`, is what lets the guide stop offering
 * "start over" to a board that has already started over. Trimming it from that
 * list would silently re-break the button this gates, with nothing failing.
 *
 * **Its scope is the flow, not one pipeline.** A visiting agent's own task
 * changing its output counts. That matches the scope of the thing it gates:
 * `resetSwarm` puts back every task on the flow, so a signal narrower than the
 * flow would offer a button that does more than the signal knew about.
 */

import type { TaskRecord } from "@/src/server/coordinator/types";

/** One task's recorded output moving, hashes compared rather than keys counted. */
export function outputChanged(task: TaskRecord): boolean {
  const previous = task.previousFingerprints;
  if (previous === undefined) return false;
  return Object.entries(previous).some(([urn, before]) => {
    const now = task.fingerprints[urn];
    return now !== undefined && (now.schema !== before.schema || now.content !== before.content);
  });
}

/**
 * Whether anything on this board has been redone since the last reset.
 *
 * This is what tells a board that has been all the way round from one nobody has
 * touched. Both are settled and unflagged; only this distinguishes them, and it
 * comes from DataHub rather than from what this server happens to remember,
 * which is the whole point: the board survives a restart and the server's memory
 * does not.
 */
export function boardSawAChange(tasks: readonly TaskRecord[]): boolean {
  return tasks.some(outputChanged);
}
