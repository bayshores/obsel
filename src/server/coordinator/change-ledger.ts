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
 * - **No obsel decision reads it.** No staleness verdict, no coverage verdict
 *   and no clear consults a change record. `restoredBy` still derives clears
 *   from task properties alone. A record is a chronicle, so a wrong one misleads
 *   a reader and cannot make obsel answer wrongly.
 *
 *   One thing does read it, and it is not a decision: a record carrying an
 *   `incident` names the DataHub incident that cascade raised and the tasks
 *   closing it depends on, and the repair path reads that back to resolve it.
 *   The property above is what makes that safe — the incident is a copy of the
 *   marks on DataHub's own surface, so a record that cannot be read leaves an
 *   incident open beside marks that are already correct, which is the direction
 *   every rule here falls.
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
  /**
   * The DataHub incident this decision raised, when it raised one.
   *
   * Additive and optional: every record written before incidents existed, and
   * every record for a decision that only cleared flags, has no such field, and
   * an absent field means no incident rather than an unresolved one.
   *
   * It is recorded HERE, at decision time, for one reason: the code that later
   * resolves the incident has to know which tasks closing it depends on, and the
   * only alternative is finding out by searching — for the incident, or for the
   * tasks it named. `documents.ts` states why nothing in obsel searches, and it
   * applies with full force here: a resolve path that could not find an
   * incident would leave it open forever on a repaired board, which reads as a
   * standing finding about work that is fine.
   */
  incident?: {
    /** The DataHub incident URN, as `raiseIncident` returned it. */
    urn: string;
    /** The dataset it was raised on: the output that moved. */
    dataset: string;
    /** The tasks it named. It resolves when none of them still cites `dataset`. */
    taskUrns: string[];
  };
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
  incident?: RaisedIncident;
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
    ...(input.incident
      ? {
          incident: {
            urn: input.incident.urn,
            dataset: input.incident.dataset,
            taskUrns: [...input.incident.taskUrns],
          },
        }
      : {}),
    elapsedMs: input.elapsedMs,
  };
}

/**
 * One incident obsel raised, as the code that raised it knows it.
 *
 * Declared beside the record it goes into rather than in `types.ts`, because
 * the record is the only place it is kept: nothing in obsel holds a list of open
 * incidents in memory or in a property, and a server restart between the raise
 * and the repair must not lose the ability to close one.
 */
export interface RaisedIncident {
  urn: string;
  dataset: string;
  taskUrns: string[];
}

/**
 * The record entry for a raise, including one whose confirmation did not land.
 *
 * **A URN DataHub minted is recorded whether or not obsel could confirm it.**
 * `raiseIncident` returns the URN of an incident that now exists; the two aspect
 * reads that follow only establish that it reads ACTIVE and is attached to the
 * table. Either read can fail on a transient non-2xx or a timeout while the
 * incident is already open. If the URN is dropped at that point, no obsel path
 * can ever name it again: `resolveClosedIncidents` and `resolveResetIncidents`
 * both take their candidates from change records, so the incident stays ACTIVE
 * and the dataset's health stays FAIL over work that may since have been redone.
 *
 * Recording it costs nothing in the other direction. Every resolve path checks
 * the dataset's own `activeIncidentsOn` before acting, so a recorded URN for an
 * incident that somehow is not open is simply not a candidate.
 *
 * The unconfirmed raise is still reported as unconfirmed by the caller's traced
 * step. This decides what is written down, not what obsel claims happened.
 *
 * Pure, and structurally typed on purpose: `incidents.ts` carries `server-only`,
 * and this module is reachable from the browser.
 */
export function raisedIncidentRecord(
  raise: { urn: string; confirmed: boolean; unconfirmed?: string } | null,
  dataset: string,
  taskUrns: readonly string[],
): RaisedIncident | null {
  if (raise === null) return null;
  return { urn: raise.urn, dataset, taskUrns: [...taskUrns] };
}

/**
 * Which recorded incidents this board's current marks no longer justify.
 *
 * Pure, and the whole rule: an incident closes when NOT ONE of the tasks it
 * named still carries a mark citing the dataset it was raised on. `stillCites`
 * answers that per task, from the board as it stands after the decision that is
 * calling this — so a partial repair, where one named task was redone and the
 * others were not, returns nothing and the incident stays open. That direction
 * is deliberate and matches the clearing rule it rides on: resolving an incident
 * over work that is still flagged would say in DataHub the opposite of what
 * obsel's own marks say.
 *
 * A task marked by a different dataset's change never cited this one, so it does
 * not hold the incident open. That is the same scope the incident was raised
 * with: it is about one output moving, not about the board being clean.
 *
 * Nothing here reads DataHub or resolves anything. The caller does both, and is
 * expected to check each candidate's state before resolving it, because this
 * function cannot tell an incident that is already RESOLVED from one that is not.
 */
export function closableIncidents(
  bodies: readonly (ChangeBody | null)[],
  stillCites: (taskUrn: string, dataset: string) => boolean,
): RaisedIncident[] {
  const closable: RaisedIncident[] = [];
  const seen = new Set<string>();
  for (const body of bodies) {
    const incident = body?.incident;
    if (!incident || seen.has(incident.urn)) continue;
    seen.add(incident.urn);
    if (incident.taskUrns.some((taskUrn) => stillCites(taskUrn, incident.dataset))) continue;
    closable.push(incident);
  }
  return closable;
}
