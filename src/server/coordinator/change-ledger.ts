/**
 * What one coordination decision looked like, as a durable record.
 *
 * **This reverses a decision, and the decision it reverses is written down two
 * files away.** `completion.ts` said, of clearing a flag: "a clear leaves nothing
 * behind to carry its reason — absence of a mark is the record", with the trace
 * and the completion reply as the only places it spoke. That is sound as a rule
 * about *task properties*: a cleared task must not keep a stale reason on it,
 * because a reader would take a standing reason for a standing flag.
 *
 * It was never sound as a rule about history. The trace is process-local and
 * gone on restart, by its own declaration, and the completion reply reaches one
 * caller once. So a board that had been changed and then repaired read exactly
 * like a board nothing had ever happened to, and the question "what did obsel
 * flag here, and why, and did the redo close it?" had no answer anywhere. The
 * marks are still the evidence of what is *currently* wrong; this is the record
 * of what happened.
 *
 * Three properties keep the reversal from becoming a mechanism:
 *
 * - **Nothing reads it.** No staleness decision, no coverage verdict, no clear
 *   consults a change record. `restoredBy` still derives clears from task
 *   properties alone. A record is a chronicle, so a wrong one misleads a reader
 *   and cannot make obsel answer wrongly.
 * - **Nothing writes it but this.** There is no route and no tool that appends,
 *   edits or deletes a record; the only writer is a completion that already
 *   marked or cleared something. `tests/live/change-ledger.live.test.ts` asserts
 *   the absent endpoints, for the same reason the erasure suite does.
 * - **Append-only, like the rest of the ledger.** A record is written once. A
 *   later decision about the same tasks is a new record beside it.
 *
 * Pure: data in, data out, no IO and no model call. The writing half is in
 * `completion.ts`, at the one moment the values exist.
 */

import type { DatasetChange } from "./staleness";
import type { AffectedTask, RestoredTask, TaskRecord } from "./types";

/** Which way a coordination decision went. Both can be true of one decision. */
export type ChangeEvent = "marked" | "cleared";

/**
 * One record as a reader receives it, and the board's history as a whole.
 *
 * Declared in this module rather than beside the code that reads them, because
 * the page renders both and `change-history.ts` carries the `server-only` guard.
 * A browser module importing through that guard is forbidden here even for types
 * that erase at compile time: the rule is about the dependency direction, and a
 * type import is the step before somebody adds a value import beside it.
 */
export interface ChangeEntry {
  /** Sequence number within this board, counting from one. */
  sequence: number;
  /** The record's own URN in DataHub, so a reader can go and look at it. */
  urn: string;
  /** The decision, as it was written. Null when the stored body will not parse. */
  body: ChangeBody | null;
}

export interface ChangeHistory {
  flowId: string;
  entries: ChangeEntry[];
}

/**
 * One entry in a board's history.
 *
 * Names rather than only URNs throughout, and that is deliberate: a record has
 * to stay readable after the task it names has been renamed or removed, and a
 * reader looking at the ledger in DataHub's own UI has no board beside it to
 * resolve a URN against.
 */
export interface ChangeBody {
  event: ChangeEvent;
  /** ISO instant the decision was made. */
  at: string;
  /**
   * What prompted the decision: an agent reporting a completion, or an outside
   * feed reporting what a table now holds.
   *
   * Recorded rather than inferred from whether `reporter` is present. They are
   * different facts about the world — one has an accountable task behind it and
   * the other does not — and a reader deciding which by the absence of a field
   * would be reading a gap as a claim.
   */
  source: "completion" | "observation";
  /**
   * The completion that caused it. Absent on an observation: the reporter is not
   * a task in the swarm, and naming the table's producer here would blame it for
   * bytes it never reported writing.
   */
  reporter?: { taskUrn: string; name: string };
  /** What the connecting MCP client called itself, when one was involved. */
  client?: { name: string; version?: string };
  /** The outputs whose fingerprints moved, with what moved about them. */
  changes: {
    dataset: string;
    kind: string;
    columns?: { added: string[]; removed: string[] };
    /** Columns the producer had declared meaningless, if any. */
    excluded?: string[];
    /** Set when nothing reported this change and a reader found it. */
    unreported?: { noticedBy: string | null };
  }[];
  /** Finished work this decision flagged, nearest first. */
  affected: { taskUrn: string; name: string; hops: number; causedBy: string; reason: string }[];
  /** Flags this decision took off, because a redo proved the ground never moved. */
  restored: { taskUrn: string; name: string; reason: string }[];
  /** How long the whole decision took, end to end, measured by obsel. */
  elapsedMs: number;
}

/**
 * Build the record for one decision, or null when there is nothing to record.
 *
 * Null on a quiet completion, which is most of them. A record per re-run that
 * marked and cleared nothing would grow the ledger for every run of every task
 * and say nothing a reader came for; the trace already narrates those while they
 * happen. So the ledger holds decisions that changed the board and nothing else.
 */
export function changeBody(input: {
  source: "completion" | "observation";
  reporter?: TaskRecord;
  at: string;
  changes: DatasetChange[];
  affected: AffectedTask[];
  restored: RestoredTask[];
  elapsedMs: number;
  client?: { name: string; version?: string };
}): ChangeBody | null {
  const { reporter, affected, restored } = input;
  if (affected.length === 0 && restored.length === 0) return null;

  return {
    // `marked` when anything was flagged, even if this decision also cleared
    // something: a decision that both flags and clears is led by the flag,
    // because that is the part a reader has to act on.
    event: affected.length > 0 ? "marked" : "cleared",
    at: input.at,
    source: input.source,
    ...(reporter ? { reporter: { taskUrn: reporter.urn, name: reporter.name } } : {}),
    ...(input.client ? { client: input.client } : {}),
    changes: input.changes.map((change) => ({
      dataset: change.dataset,
      kind: change.kind,
      /*
       * The column diff is carried here because this is the only moment it
       * exists. `decideCompletion` computes it while it still holds both the
       * previous run's shapes and the new ones, and `recordCompletion`
       * overwrites the former a few lines later. A record built after the fact
       * could say a table changed but never which columns moved.
       */
      ...(change.columns ? { columns: change.columns } : {}),
      ...(change.excluded && change.excluded.length > 0 ? { excluded: [...change.excluded] } : {}),
      ...(change.unreported
        ? { unreported: { noticedBy: change.unreported.noticedBy?.name ?? null } }
        : {}),
    })),
    affected: affected.map((entry) => ({
      taskUrn: entry.task.urn,
      name: entry.task.name,
      hops: entry.mark.hops,
      causedBy: entry.mark.causedBy,
      reason: entry.mark.reason,
    })),
    restored: restored.map((entry) => ({
      taskUrn: entry.task.urn,
      name: entry.task.name,
      reason: entry.reason,
    })),
    elapsedMs: input.elapsedMs,
  };
}
