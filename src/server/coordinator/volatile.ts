/**
 * One table, one volatile list, across the whole board.
 *
 * The columns a task registers as volatile are excluded from the content hash of
 * its output, so the list decides what a recorded fingerprint of that table
 * MEANS. Two fingerprints are comparable only if both were taken under the same
 * list, and a reader hashes an input under the PRODUCER's list, looked up by
 * dataset off the board rather than by resolving a producer.
 *
 * That lookup has one answer per table or none. Two tasks writing one table
 * under different lists put two answers on the board for one question:
 * `volatile_by_dataset` in `agents/mcp_core.py` refuses to pick between them and
 * raises, so every agent path that builds the reader-side exclusion map fails
 * for the whole board until the swarm is reset.
 *
 * This is the pure half of the door that keeps that state off the board. It is
 * separate from the same-task immutability guard in
 * `src/server/datahub/client.ts`, which compares a re-registration against that
 * one task's own record: that guard protects the baselines already taken, this
 * one protects the lookup every reader depends on.
 */

import { datasetName } from "@/src/server/datahub/urns";

/** A task on the board, as far as this decision is concerned. */
export interface VolatileDeclaration {
  name: string;
  /** Declared volatile columns, keyed by full dataset URN. */
  volatile?: Record<string, string[]>;
}

function normalize(columns: readonly string[]): string[] {
  return [...columns].sort();
}

/**
 * The sentence refusing this registration, or null when nothing conflicts.
 *
 * Refuses only a genuine disagreement. The same list in a different order is
 * the same list; a table no other task declares anything about is free; and a
 * record under the registering task's OWN name is left alone, because that
 * comparison belongs to the immutability guard, which has a different remedy to
 * offer.
 *
 * Deterministic in the board's order: tables and tasks are both considered in
 * sorted order, so the same conflict produces the same sentence whichever way
 * DataHub happened to return the swarm.
 */
export function volatileConflict(
  name: string,
  declared: Record<string, string[]>,
  board: readonly VolatileDeclaration[],
): string | null {
  const recorded = [...board]
    .filter((task) => task.name !== name && task.volatile)
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const dataset of Object.keys(declared).sort()) {
    const incoming = normalize(declared[dataset]);
    for (const task of recorded) {
      const columns = task.volatile?.[dataset];
      if (!columns) continue;
      const existing = normalize(columns);
      if (JSON.stringify(existing) === JSON.stringify(incoming)) continue;

      return (
        `two tasks declare different volatile columns for ${datasetName(dataset)}: ` +
        `${task.name} declared ${JSON.stringify(existing)} and ${name} declares ` +
        `${JSON.stringify(incoming)}. Those columns decide what a fingerprint of that table ` +
        "means, and every reader hashes it under the producer's list looked up off the board, " +
        "so a board carrying both lists hashes one table two ways and one side's reads look " +
        "like a change nobody reported. Register under the list already recorded, or reset, " +
        "which clears the baselines it was taken under."
      );
    }
  }

  return null;
}
