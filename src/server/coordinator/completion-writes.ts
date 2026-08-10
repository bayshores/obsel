import "server-only";

/**
 * Writing a decision back, once `completion.ts` has made it.
 *
 * Nothing in here decides anything: every value it stores was computed by the
 * pure functions in `staleness.ts` and handed over. It is separate because the
 * ordering rules below are about DataHub's two surfaces disagreeing -- the
 * properties obsel records against the tag DataHub's own UI shows -- and that is
 * a different question from what a completion invalidates.
 */

import { applyStaleTag, removeStaleTag } from "@/src/server/datahub/mcp";
import { PROP, updateTaskProperties } from "@/src/server/datahub/client";
import { clientProperty } from "@/src/server/http/client-body";
import type { PropertyPatch } from "@/src/server/datahub/properties";
import {
  changeHeadFor,
  nextChangeSequence,
  readChangesFor,
  writeChangeRecord,
} from "@/src/server/datahub/documents";
import {
  activeIncidentsOn,
  raiseStaleWorkIncident,
  resolveIncident,
} from "@/src/server/datahub/incidents";
import { FLOW_ID } from "@/src/server/datahub/urns";
import { changeBody, closableIncidents } from "./change-ledger";
import type { ChangeBody, RaisedIncident } from "./change-ledger";
import {
  compareFingerprints,
  hopLabel as hops,
  mergeMark,
  tableLabel,
  taskLabel as label,
} from "./staleness";
import type { DatasetChange } from "./staleness";
import { emit } from "./trace";
import type { AffectedTask, CompletionReport, RestoredTask, TaskRecord } from "./types";

/**
 * Every field a standing mark occupies, set to null.
 *
 * A flag comes off two ways -- the task's own redo, and obsel restoring a task
 * an upstream redo proved sound -- and both must strip exactly the same fields.
 * `updateTaskProperties` merges, so a field left out of one of them survives
 * the clear, and a task carrying half a reason reads as a standing flag whose
 * cause has gone missing.
 */
const NO_MARK: PropertyPatch = {
  [PROP.staleCausedBy]: null,
  [PROP.staleCausedByTask]: null,
  [PROP.staleHops]: null,
  [PROP.staleChangeKind]: null,
  [PROP.staleColumns]: null,
  [PROP.staleReason]: null,
  [PROP.staleSince]: null,
  [PROP.staleDetectedMs]: null,
  [PROP.staleCauses]: null,
};

/**
 * Append one decision to the board's history, if it decided anything.
 *
 * Last, after the marks, the self-mark and the clears have all landed, so the
 * record describes what actually happened rather than what was about to. And
 * deliberately unable to fail the completion: a history write that throws emits a
 * traced step naming the failure and returns. The flags are the evidence and they
 * are already in DataHub; losing the chronicle of a cascade is a worse outcome
 * than not having it, but it is nowhere near as bad as failing a completion that
 * had already succeeded and having the agent retry it. This is the same posture
 * as the `detectedMs` pass above.
 *
 * A retried completion that failed part-way can append a second record about the
 * same marks. Accepted: the ledger is a chronicle nothing reads back, so a
 * duplicate entry is a reader seeing one event twice, not obsel deciding wrongly.
 * Refusing duplicates would mean reading the history to decide whether to write
 * it, which is exactly the dependency this design is keeping out.
 */
export async function recordChange(input: {
  source: "completion" | "observation";
  reporter?: TaskRecord;
  changes: DatasetChange[];
  affected: AffectedTask[];
  restored: RestoredTask[];
  elapsedMs: number;
  client?: { name: string; version?: string };
  incident?: RaisedIncident;
}): Promise<void> {
  const body = changeBody({ ...input, at: new Date().toISOString() });
  if (body === null) return;

  try {
    const sequence = await nextChangeSequence(FLOW_ID);
    await writeChangeRecord(FLOW_ID, sequence, {
      at: body.at,
      body: JSON.stringify(body),
      assets: body.changes.map((change) => change.dataset),
    });
    emit(
      "write",
      `recorded change ${sequence}`,
      `${body.affected.length} flagged, ${body.restored.length} cleared`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    emit("write", "could not record this change in the ledger", message);
  }
}

/**
 * Raise ONE DataHub incident for this cascade, on the table whose output moved.
 *
 * A stale mark is obsel's record and lives on the DataJob. An incident is
 * DataHub's, lives on the dataset, and is what somebody looking at that table in
 * DataHub sees — its `health` reads `FAIL` while the incident is open. One per
 * cascade, not one per flagged task: the change is a single event, and a table
 * carrying six incidents for one rename would be six copies of one fact.
 *
 * The target is the nearest mark's `causedBy`, which is the output that actually
 * changed. `affected` is ordered nearest first, so that is `affected[0]`.
 *
 * Nothing new is written in words: the title counts the tasks and names the
 * table, and the body is each mark's own recorded reason and hop count. obsel
 * says the same thing in both places or it would be two answers.
 *
 * **It cannot fail a completion.** A raise that throws is a traced step and
 * nothing else. The marks are the answer and they are already in DataHub;
 * losing the second copy of them is worth strictly less than failing a
 * completion that had already succeeded and having the agent retry it. That is
 * the same posture as `recordChange` above.
 *
 * A completion retried after a partial failure can raise a second incident for
 * the same cascade — `raiseIncident` takes no idempotency key and obsel invents
 * none. Both name the same tasks, so the repair that closes one closes the
 * other; the cost is two rows on the table rather than one.
 */
export async function raiseCascadeIncident(
  affected: AffectedTask[],
): Promise<RaisedIncident | null> {
  if (affected.length === 0) return null;

  const dataset = affected[0].mark.causedBy;
  const table = tableLabel(dataset);
  const listed = affected.slice(0, 20);
  const body = listed
    .map((entry) => `${label(entry.task)} (${hops(entry.mark.hops)}): ${entry.mark.reason}`)
    .join("\n");
  const remainder =
    affected.length > listed.length ? `\n… and ${affected.length - listed.length} more` : "";

  try {
    const urn = await raiseStaleWorkIncident({
      dataset,
      title: `${affected.length} finished ${affected.length === 1 ? "task is" : "tasks are"} out of date after ${table} changed`,
      description:
        `${body}${remainder}\n\n` +
        "Raised by obsel. It is resolved once none of the tasks above still " +
        "carries a mark citing this table, which happens when each of them has " +
        "been redone or an upstream redo has shown its work was built on ground " +
        "that never moved. No obsel route and no obsel tool resolves it by hand.",
      startedAt: affected[0].mark.since,
    });

    if (urn === null) {
      // The skip trap 4 in `incidents.ts` forces. Traced rather than silent:
      // a table obsel flagged work over, that DataHub has no entity for, is
      // worth someone knowing about.
      emit("write", `raised no incident on ${table}`, "DataHub has no dataset under that URN");
      return null;
    }

    emit(
      "write",
      `raised a DataHub incident on ${table}`,
      `names ${affected.length} flagged task(s)`,
    );
    return { urn, dataset, taskUrns: affected.map((entry) => entry.task.urn) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    emit("write", `could not raise a DataHub incident on ${table}`, message);
    return null;
  }
}

/**
 * How far back the repair path looks for an incident it may now close.
 *
 * The ledger is append-only and per board, and a repair follows its cascade
 * within a handful of decisions in every shape obsel has been run in. An
 * incident older than this window stays open until a later repair brings it
 * inside — stated because it is a real limit, and it falls the safe way: an
 * incident left open over repaired work is visible and correctable, while one
 * resolved over work that is still flagged would have DataHub contradicting
 * obsel's own marks.
 */
const INCIDENT_LOOKBACK = 50;

/**
 * Resolve every incident this decision's repairs have closed out.
 *
 * Called from the clear path and from nowhere else, because this is the only
 * moment a flag comes off. `stillCites` answers, for the board as it stands
 * after this decision, whether one task still carries a mark citing one dataset;
 * `closableIncidents` is the rule, and it is pure.
 *
 * **Nothing is searched for.** The candidates come from the dataset's own
 * `incidentsSummary` aspect — one read per repaired table, no index — and the
 * tasks each incident named come from the change record written when it was
 * raised. The ledger walk happens only when a repaired table genuinely has an
 * open incident on it, so an ordinary repair costs one read.
 *
 * Like the raise, it cannot fail a completion.
 */
export async function resolveClosedIncidents(
  datasets: string[],
  stillCites: (taskUrn: string, dataset: string) => boolean,
): Promise<void> {
  if (datasets.length === 0) return;

  try {
    const open = new Set<string>();
    for (const dataset of datasets) {
      for (const urn of await activeIncidentsOn(dataset)) open.add(urn);
    }
    if (open.size === 0) return;

    const head = await changeHeadFor(FLOW_ID);
    const from = Math.max(1, head - INCIDENT_LOOKBACK + 1);
    const records = await readChangesFor(FLOW_ID, { from, limit: INCIDENT_LOOKBACK });
    const bodies = records.map((record) => {
      try {
        return JSON.parse(record.body) as ChangeBody;
      } catch {
        // A record whose body will not parse is a record this path cannot act
        // on. `readChanges` renders the same case as a null body rather than
        // failing the read, and the incident simply stays open.
        return null;
      }
    });

    const closable = closableIncidents(bodies, stillCites).filter((incident) =>
      open.has(incident.urn),
    );

    for (const incident of closable) {
      await resolveIncident({
        urn: incident.urn,
        dataset: incident.dataset,
        message: "obsel: no task this incident named still carries a mark citing this table",
      });
      emit(
        "write",
        `resolved the DataHub incident on ${tableLabel(incident.dataset)}`,
        `${incident.taskUrns.length} named task(s), none still flagged for this table`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    emit("write", "could not resolve a DataHub incident", message);
  }
}

/**
 * Resolve every ledger-recorded incident after the board itself was wiped.
 *
 * Called from `resetSwarm` and from nowhere else, after the reset has stripped
 * every mark from the flow. At that moment any incident a cascade raised names
 * marks that no longer exist, so leaving it open would keep the dataset's
 * `health` at FAIL over findings the board no longer makes. The rule is
 * `closableIncidents` with a `stillCites` that answers false for everything,
 * which is literally true of a board that was just wiped.
 *
 * This is not a dismissal path, for the same reason reset itself is not: no
 * incident is passed in and none can be — the candidates come from the change
 * ledger's own records, exactly as the repair path finds them — and the marks
 * the incident described are already gone, taken by the reset that called this.
 * A caller who wants an incident closed without redoing work still has to wipe
 * the whole board to get it, on the flow they hold the token for.
 *
 * Like the raise and the repair-path resolve, it cannot fail its caller.
 */
export async function resolveResetIncidents(): Promise<string[]> {
  try {
    const head = await changeHeadFor(FLOW_ID);
    const from = Math.max(1, head - INCIDENT_LOOKBACK + 1);
    const records = await readChangesFor(FLOW_ID, { from, limit: INCIDENT_LOOKBACK });
    const bodies = records.map((record) => {
      try {
        return JSON.parse(record.body) as ChangeBody;
      } catch {
        return null;
      }
    });

    const resolved: string[] = [];
    for (const incident of closableIncidents(bodies, () => false)) {
      const active = await activeIncidentsOn(incident.dataset);
      if (!active.includes(incident.urn)) continue;
      await resolveIncident({
        urn: incident.urn,
        dataset: incident.dataset,
        message: "obsel: the board was reset, and every mark this incident described went with it",
      });
      emit(
        "write",
        `resolved the DataHub incident on ${tableLabel(incident.dataset)}`,
        "board reset: the marks it named no longer exist",
      );
      resolved.push(tableLabel(incident.dataset));
    }
    return resolved.sort();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    emit("write", "could not resolve a DataHub incident after the reset", message);
    return [];
  }
}

/**
 * Take a mark off a task the redo proved sound, in both places it exists.
 *
 * The inverse of `markStale`, in the inverse order: the tag comes off first and
 * the properties second, so at no moment does DataHub's UI show a task obsel's
 * own record already calls sound — the exact disagreement `recordCompletion`
 * documents refusing to leave behind. `finishedAt`, `fingerprints` and `run`
 * are untouched on purpose: this task's work was never redone, and its record
 * of that work is still true. Only the mark was wrong, in hindsight.
 *
 * Unlike a mark's reason, which lives on the task's properties and is shown when
 * the task is opened, a clear leaves nothing behind **on the task** to carry its
 * reason — absence of a mark is the record of what is currently true, the same as
 * after a task's own redo. A cleared task keeping a stale reason would read as a
 * standing flag, so that part of the rule stands and this function still strips
 * every stale property.
 *
 * What changed: that used to be the whole rule, and it left the *history*
 * nowhere. The trace is process-local and gone on restart by its own
 * declaration, and the completion reply reaches one caller once, so a board that
 * had been changed and repaired read exactly like one where nothing ever
 * happened. `change-ledger.ts` now records the decision — cause, path, what was
 * flagged, what a redo closed — as an append-only ledger record beside the
 * erasure evidence chain. Nothing reads it back to decide anything: a clear is
 * still derived by `restoredBy` from task properties alone, and no route or tool
 * can append to, edit or request one.
 */
export async function clearRestored(entry: RestoredTask): Promise<void> {
  const { task, reason } = entry;

  await removeStaleTag([task.urn]);

  await updateTaskProperties(task.urn, {
    [PROP.status]: "complete",
    ...NO_MARK,
  });

  emit("write", `cleared ${label(task)}`, reason);
}

/**
 * Store what the finishing task produced, and clear its own stale mark.
 *
 * A task that was stale and has now re-run is trustworthy again, so the mark and
 * the DataHub tag both come off. Leaving either behind means the dashboard and
 * DataHub disagree about the same task.
 *
 * Fingerprints are merged rather than replaced: a run that reported only one of
 * its outputs must not erase the baseline for the others, because a missing
 * baseline reads as a first run and suppresses the next comparison.
 */
export async function recordCompletion(
  finishing: TaskRecord,
  report: CompletionReport,
): Promise<void> {
  const fingerprints = { ...finishing.fingerprints, ...report.fingerprints };

  /*
   * Keep the version each changed output is replacing, one slot per dataset.
   * This is what lets `classifyObservation` tell a reader that straddled this
   * re-report apart from a silent edit: the straddling reader's observation
   * matches exactly this superseded fingerprint. An identical re-report keeps
   * the existing entry — replacing it would make "previous" equal "current"
   * and the distinction meaningless.
   */
  const previous = { ...finishing.previousFingerprints };
  for (const [dataset, next] of Object.entries(report.fingerprints)) {
    const current = finishing.fingerprints[dataset];
    if (current && compareFingerprints(current, next) !== null) {
      previous[dataset] = current;
    }
  }

  // A fresh completion supersedes any reader observation of the datasets it
  // reports: the producer has now said what its output is, so the noticed
  // version is no longer the latest word. Entries for unreported datasets stay.
  const observed = { ...finishing.observed };
  for (const dataset of Object.keys(report.fingerprints)) delete observed[dataset];

  // Replaced wholesale, never merged, and cleared when a run reports nothing.
  // Merging would let an old runner name or row count survive beside a new one
  // and describe a run that never happened. Absent reads as "not reported" in
  // the dashboard, which is the truthful rendering of having not been told.
  const run = report.run;

  await updateTaskProperties(finishing.urn, {
    [PROP.status]: "complete",
    [PROP.finishedAt]: report.finishedAt,
    [PROP.fingerprints]: JSON.stringify(fingerprints),
    [PROP.previousFingerprints]: Object.keys(previous).length > 0 ? JSON.stringify(previous) : null,
    [PROP.observed]: Object.keys(observed).length > 0 ? JSON.stringify(observed) : null,
    // Each field independently, not gated on the object. A report can carry the
    // shape and no duration — a person at the table form typed the table, so there is
    // no run to time — and writing "0" or the runner's name in its place would
    // record a measurement nobody took.
    [PROP.runRunner]: run?.runner ?? null,
    [PROP.runMs]: run?.ms == null ? null : String(Math.round(run.ms)),
    [PROP.runOutputs]: run ? JSON.stringify(run.outputs) : null,
    // Written when the report carried one, left alone when it did not. Unlike
    // the `run` fields above, this is NOT cleared on a report without it: those
    // describe the run being recorded now, while this records which client has
    // spoken to obsel about this task, and a worker completing a redo of a task
    // an MCP client declared has not made that earlier fact untrue.
    ...(report.client ? { [PROP.clientReported]: clientProperty(report.client) } : {}),
    ...NO_MARK,
  });

  // Keyed on the mark itself, not on `status`. By the time a completion arrives
  // the task has already been moved to `running` by startTask, so a status check
  // here can never be true and the tag would stay on a task obsel now calls
  // complete — its properties and DataHub's UI disagreeing about the same task,
  // which is the one thing this function promises will not happen.
  if (finishing.stale) {
    await removeStaleTag([finishing.urn]);
  }
}

/**
 * Write a whole cascade's marks, with ONE tag call for all of them.
 *
 * The properties are per task and go to GMS over HTTP, so they are written
 * together. The tag does not: `applyStaleTag` speaks to `mcp-server-datahub`
 * over a single stdio pipe, and firing one call per task down it puts a whole
 * cascade's worth of round trips through a single-threaded child process.
 * `mcp.ts:177` has always taken an array; nothing was passing one. A cascade's
 * cost is now one round trip regardless of how wide it is.
 *
 * No timing figure is quoted here on purpose. An earlier version of this comment
 * carried one, taken from a review summary rather than from a run of obsel, and
 * `docs/verification.md` records its withdrawal. The argument for batching does
 * not need a number: it is one round trip against N.
 *
 * The ordering rule survives the batching: every task's properties are written
 * and confirmed before any tag is applied, so a tag never points at a task with
 * no recorded cause.
 */
export async function markAllStale(entries: AffectedTask[]): Promise<void> {
  if (entries.length === 0) return;

  await Promise.all(entries.map(writeStaleProperties));
  await applyStaleTag(entries.map((entry) => entry.task.urn));

  for (const { task, mark } of entries) {
    // After the tag, not before: by here both halves of the mark have landed and
    // been confirmed, so the step is reporting something that is true in DataHub
    // rather than something that has been requested.
    /*
     * The outcome is the distance, not the reason sentence.
     *
     * The reason is a dozen words, and it is already carried on the mark, written
     * into DataHub, and shown verbatim when the task is opened. Repeating it here
     * would put the trace's longest line beside the one place it adds nothing, in
     * the panel whose whole purpose is being scannable.
     */
    emit("mark", `marked ${label(task)} out of date`, `${hops(mark.hops)} from the change`);
  }
}

async function writeStaleProperties(entry: AffectedTask): Promise<void> {
  const { task, mark } = entry;

  /*
   * Merged against whatever this task already carried, not written over it.
   *
   * `entry.task` came from the snapshot read at the top of this completion, so
   * it still holds the mark standing before this cascade. A second cascade
   * reaching an already-flagged task used to overwrite the whole record, and the
   * first cause was then gone: repairing the second one left a flag standing
   * with nothing on file to explain it. The primary fields still take the new
   * cascade's values, which is what the board has always shown.
   */
  const merged = mergeMark(task.stale, mark);

  await updateTaskProperties(task.urn, {
    [PROP.status]: "stale",
    [PROP.staleCausedBy]: mark.causedBy,
    [PROP.staleCausedByTask]: mark.causedByTask ?? "",
    [PROP.staleCauses]: JSON.stringify(merged.causes),
    // Written when there is a diff to write, cleared when there is not, so a
    // content-only change can never inherit the column names from a schema
    // change that marked the same task earlier.
    [PROP.staleColumns]: mark.columns ? JSON.stringify(mark.columns) : null,
    [PROP.staleHops]: String(mark.hops),
    [PROP.staleChangeKind]: mark.changeKind,
    [PROP.staleReason]: mark.reason,
    [PROP.staleSince]: mark.since,
    // Cleared, not left alone. `updateTaskProperties` MERGES, and the real
    // figure is stamped by a second write further down that is deliberately
    // deferred so a bookkeeping failure cannot stop the flags landing. Without
    // this line a task marked by a second, later cascade keeps the FIRST
    // cascade's measurement in the meantime — and the dashboard would report a
    // millisecond figure measured for a different change, which is precisely
    // the "number nobody measured" obsel refuses to display. Null removes the
    // property, so the gap reads "not measured" until the real one lands.
    [PROP.staleDetectedMs]: null,
  });
}
