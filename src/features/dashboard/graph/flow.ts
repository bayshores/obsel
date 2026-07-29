/**
 * Which edges touch the node a reader is pointing at.
 *
 * This is emphasis, not a claim. `cascade.ts` beside it answers "where did a
 * change actually travel", read off the marks obsel wrote; this answers "what is
 * wired to the thing under the pointer", read off `reads` and `writes`. The two
 * must never be confused on screen, so the cascade keeps amber and its own dash
 * pattern and this one is drawn in rose, and an edge the cascade lit is never
 * given a flow class at all.
 *
 * **Direct edges only.** Walking further would draw a path that looks like reach,
 * and reach is exactly the claim `cascade.ts` derives from marks rather than from
 * topology, for the reason its header documents at length. One hop is structure:
 * this table is read by these agents, and written by that one. Nothing about it
 * says a change went anywhere.
 */

import type { TaskRecord } from "@/src/server/coordinator/types";

/**
 * Edge ids incident to one node, spelled exactly as `layoutPositions` spells them.
 *
 * Both cases come out of the same two lists. For a dataset: the edge from its
 * writer, and one to each task that reads it. For a task: one from each dataset
 * it reads, and one to each it writes. Every edge in the graph is already drawn
 * in the direction data moves (`positions.ts` builds reads as dataset→task and
 * writes as task→dataset), so an animation that runs along the path is pointing
 * the right way in all four cases without any per-edge direction logic here.
 *
 * A URN that names nothing on the board, and null, both return an empty set: the
 * caller clears every flow class rather than leaving the last one lit.
 *
 * @returns edge ids (`${from}->${to}`), matching `PositionedEdge.id`.
 */
export function flowEdgeIds(tasks: TaskRecord[], urn: string | null): ReadonlySet<string> {
  const lit = new Set<string>();
  if (urn === null) return lit;

  const task = tasks.find((candidate) => candidate.urn === urn);
  if (task !== undefined) {
    for (const input of task.reads) lit.add(`${input}->${task.urn}`);
    for (const output of task.writes) lit.add(`${task.urn}->${output}`);
    return lit;
  }

  // Not a task, so the only other thing a node id can name is a dataset. An
  // invented URN matches neither and correctly lights nothing.
  for (const candidate of tasks) {
    if (candidate.writes.includes(urn)) lit.add(`${candidate.urn}->${urn}`);
    if (candidate.reads.includes(urn)) lit.add(`${urn}->${candidate.urn}`);
  }
  return lit;
}
