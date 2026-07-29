/**
 * Which lineage edges a change actually travelled along.
 *
 * Split out of `layout.ts`, which no longer exists. This is the only part of
 * that file that was not geometry: it decides nothing about where a node sits
 * and everything about which path the dashboard is entitled to draw as the
 * cascade. Positions now come from dagre; this stays hand-written because it is
 * obsel reasoning, and it is the reasoning a graph library has no opinion about.
 */

import type { TaskRecord } from "@/src/server/coordinator/types";

/**
 * Which lineage edges the cascade lit, and on which wave.
 *
 * Walked forward from the dataset the mark names, through the same filter the
 * engine actually applied — which is not the same as re-deciding it here.
 *
 * **A task is part of this cascade only if it carries a mark naming this
 * origin.** An earlier version instead re-walked the graph from the origin and
 * admitted any task that was currently `complete` or `stale`, on the theory
 * that re-deriving from topology could not disagree with topology. It could
 * disagree with something more important: the marks. A task downstream of the
 * change that the engine did NOT mark — because it was running when the cascade
 * ran, or because it finished afterwards and is therefore built on the new data
 * — is `complete` by the time the dashboard polls, so the walk lit an amber path
 * straight through it. The graph asserted the change had reached work obsel had
 * decided it did not reach.
 *
 * Hop numbers are read off the marks for the same reason. The mark is what
 * obsel decided and what it wrote into DataHub; if a re-derivation and the mark
 * ever differ, the mark is right and the picture is wrong.
 *
 * Returns an empty map when nothing carries a mark for this origin, which is
 * what makes the calm states calm. Terminates on a cyclic graph: both visited
 * sets are consulted before anything is enqueued.
 *
 * @returns edge id (`${from}->${to}`) → the hop count recorded on the mark.
 */
export function cascadeEdges(
  tasks: TaskRecord[],
  originDataset: string | null,
  causeTaskUrn: string | null,
): Record<string, number> {
  const lit: Record<string, number> = {};
  if (originDataset === null) return lit;

  /*
   * Only tasks obsel marked for THIS change, with the distance it recorded.
   *
   * Every cause is consulted, not just the one the mark leads with. A task
   * broken by two changes carries the nearer one in its primary fields, so
   * matching on that alone left the second change's cascade half-drawn: the
   * board showed an origin whose reach stopped at whichever tasks happened to
   * have no closer cause. Each cause carries its own distance, which is what
   * the edge is lit with.
   */
  const markedHere = new Map<string, number>();
  for (const task of tasks) {
    if (task.urn === causeTaskUrn) continue;
    if (task.stale === null) continue;
    const causes = task.stale.causes ?? [task.stale];
    const here = causes.find((cause) => cause.causedBy === originDataset);
    if (here) markedHere.set(task.urn, here.hops);
  }
  if (markedHere.size === 0) return lit;

  const readersOf = new Map<string, TaskRecord[]>();
  for (const task of tasks) {
    for (const input of task.reads) {
      const list = readersOf.get(input);
      if (list === undefined) readersOf.set(input, [task]);
      else list.push(task);
    }
  }

  const seenData = new Set<string>([originDataset]);
  const seenTask = new Set<string>();
  let frontier: string[] = [originDataset];
  let rounds = 0;

  while (frontier.length > 0 && rounds < tasks.length + 2) {
    rounds += 1;
    const next: string[] = [];
    for (const dataset of frontier) {
      for (const task of readersOf.get(dataset) ?? []) {
        if (seenTask.has(task.urn)) continue;
        const hops = markedHere.get(task.urn);
        if (hops === undefined) continue; // obsel did not mark it — do not claim it did
        seenTask.add(task.urn);
        lit[`${dataset}->${task.urn}`] = hops;
        for (const output of task.writes) {
          lit[`${task.urn}->${output}`] = hops;
          if (!seenData.has(output)) {
            seenData.add(output);
            next.push(output);
          }
        }
      }
    }
    frontier = next;
  }

  return lit;
}
