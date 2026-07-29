import "server-only";

/**
 * What one completion invalidates, and the writing of that answer back.
 *
 * Every decision here is made by the pure functions in `staleness.ts` — this
 * file only moves data. Nothing in obsel's staleness reasoning is a model call;
 * it is graph traversal over recorded fingerprints, so the same inputs always
 * give the same answer and the whole of it is testable without a network.
 */

import { applyStaleTag, removeStaleTag } from "@/src/server/datahub/mcp";
import { PROP, readSnapshot, updateTaskProperties } from "@/src/server/datahub/client";
import {
  affectedBy,
  classifyObservation,
  columnChange,
  compareFingerprints,
  hopLabel as hops,
  mergeMark,
  producersOf,
  restoredBy,
  supersededMark,
  tableLabel,
  taskLabel as label,
} from "./staleness";
import type { DatasetChange } from "./staleness";
import { emit } from "./trace";
import type {
  AffectedTask,
  ChangeKind,
  CompletionReport,
  CoordinationResult,
  OutputFingerprint,
  RestoredTask,
  StaleMark,
  TaskRecord,
} from "./types";

/**
 * A task finished. Decide what that invalidates, and record it.
 *
 * The no-change path matters as much as the change path: a task that re-runs and
 * produces exactly what it produced before marks nothing, and `affected` comes
 * back empty. Without that, a scheduled re-run screams at the whole pipeline and
 * the marks stop meaning anything.
 *
 * `elapsedMs` covers the whole call — reading the graph, deciding, and writing
 * every mark back including the DataHub tag — because that is the number a
 * person actually waits for. It is measured, never rounded to "instant".
 */
export async function coordinateCompletion(report: CompletionReport): Promise<CoordinationResult> {
  const startedAt = Date.now();
  const release = await acquireCoordinationLock();
  try {
    return await decideCompletion(report, startedAt);
  } finally {
    release();
  }
}

/**
 * One completion is decided at a time, process-wide.
 *
 * Every completion reads its own snapshot and then writes marks derived from
 * it, and the two halves were not atomic. Two agents finishing at once each read
 * the graph before the other's marks landed, so a clear computed from a snapshot
 * that predated a mark could be written after it — taking the flag off work that
 * had just been correctly flagged. A false clear is the one answer obsel must
 * never give, so the read-decide-write triple is serialized rather than made
 * cleverer.
 *
 * `startedAt` is stamped before the wait, not after, because the number obsel
 * reports is what the agent that called actually waited for. Under contention
 * that figure now includes time queued behind another completion, and it says so
 * on the board rather than quietly excluding it.
 *
 * Process-wide is the honest scope. It holds because obsel is one server; two
 * obsel processes against one DataHub would need a lock DataHub does not offer,
 * and that limit belongs written down rather than papered over.
 */
let coordinationLock: Promise<void> = Promise.resolve();

function acquireCoordinationLock(): Promise<() => void> {
  const previous = coordinationLock;
  let release: () => void = () => {};
  coordinationLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Settled either way: a completion that threw must not wedge the queue behind
  // it, because the next one is a different agent's work and is still valid.
  return previous.then(
    () => release,
    () => release,
  );
}

async function decideCompletion(
  report: CompletionReport,
  startedAt: number,
): Promise<CoordinationResult> {
  const snapshot = await readSnapshot();
  const finishing = snapshot.tasks.find((task) => task.urn === report.taskUrn);
  if (!finishing) {
    throw new Error(`completion reported for ${report.taskUrn}, which is not a registered agent`);
  }

  emit("read", `${label(finishing)} finished`, `read ${snapshot.tasks.length} tasks from DataHub`);

  const changedOutputs: DatasetChange[] = [];
  // Outputs that came back byte-identical to the recorded baseline. Only these
  // can restore anything: a first run has no baseline to have matched, so it
  // proves nothing about work built on "the previous version".
  const unchangedOutputs: string[] = [];
  for (const dataset of Object.keys(report.fingerprints).sort()) {
    const previous = finishing.fingerprints[dataset];
    const kind = compareFingerprints(previous, report.fingerprints[dataset]);
    if (previous && kind === null) unchangedOutputs.push(dataset);
    if (kind) {
      /*
       * Named here because this is the only moment both column lists exist.
       *
       * `finishing` came from the snapshot read at the top of this function, so
       * it still holds the PREVIOUS run's shapes; `report` carries the new ones;
       * and `recordCompletion` below overwrites the former with the latter. A
       * later pass could not reconstruct this, which is why the description is
       * computed now and carried on the mark rather than derived at render time.
       *
       * It describes the change. It does not decide it: `kind` above is already
       * settled, from the sha256 pair alone.
       */
      changedOutputs.push({
        dataset,
        kind,
        columns: columnChange(
          finishing.run?.outputs[dataset]?.columns,
          report.run?.outputs[dataset]?.columns,
        ),
        // What this comparison ignored, taken from the producer's own
        // registration. Carried so the mark's sentence can say so; the
        // comparison above already happened, under exactly this list.
        excluded: finishing.volatile?.[dataset],
      });
    }
    // The comparison is the whole decision, so it is narrated whichever way it
    // goes. A step that only spoke up when something changed would leave the
    // quiet case, which is the one obsel's credibility rests on, invisible.
    emit(
      "compare",
      `compared ${tableLabel(dataset)}`,
      previous === undefined ? "first version, nothing to compare" : verdict(kind),
    );
  }

  /*
   * The reader-side check: what this task read, against what each producer
   * recorded writing. This is the only way obsel can notice a change made by
   * something that never reports — the producer's own fingerprints cannot catch
   * it, because the producer never sent any for the new bytes. An honest
   * reader's completion carries the evidence instead.
   *
   * The comparison baseline is the producer's `observed` entry when one exists,
   * falling back to its recorded output fingerprint. That ordering is what
   * stops the same silent change being flagged once per reader: the first
   * reader to see it triggers the cascade and the observation is written down,
   * so the second reader's identical observation compares clean. A dataset with
   * no producer in the swarm, or whose producer has not finished, has no
   * recorded claim to contradict, and is skipped with the reason narrated.
   */
  const observedChanges: DatasetChange[] = [];
  const observationsFor = new Map<TaskRecord, Record<string, OutputFingerprint>>();
  // The finishing task's own marks, earned by finishing on inputs that were
  // replaced while it ran. Collected rather than capped at one: they become the
  // causes of a single mark below, whose primary is the first in sorted order.
  const supersededMarks: StaleMark[] = [];
  const producers = producersOf(snapshot);
  for (const dataset of Object.keys(report.inputs ?? {}).sort()) {
    const observation = (report.inputs ?? {})[dataset];
    // A dataset this task also reported writing was already compared above.
    if (report.fingerprints[dataset]) continue;

    const writers = producers.get(dataset) ?? [];
    const onRecord = writers.filter(
      (writer) => writer.observed?.[dataset] || writer.fingerprints[dataset],
    );
    if (onRecord.length === 0) {
      emit(
        "compare",
        `checked ${tableLabel(dataset)}, which this task read`,
        writers.length > 0
          ? "its writer has not finished, nothing to compare"
          : "nothing here writes it",
      );
      continue;
    }

    /*
     * Four-way, not two-way, and the two middle verdicts exist for concurrent
     * swarms: an observation can be stale without anything having gone
     * unreported, when this task read its input before the producer's re-report
     * (or before a noticed silent edit) and finished after. Calling that case
     * "unreported" fired a false alarm with a wrong author AND left the one
     * task that really is stale — this one — unflagged, because the cascade
     * excludes the reporter. `classifyObservation` owns the distinction.
     */
    /*
     * Checked against EVERY writer that has something on record, not one.
     *
     * Two tasks writing one table is legal, and which of them wrote the bytes
     * now standing is recorded nowhere. Asking a single writer picked by
     * registration order would raise an unreported-change alarm against bytes
     * the other writer reported in full. So the verdicts are ranked
     * current > superseded > unknown, and the alarm fires only when NO writer
     * on record can account for what this task read.
     */
    const verdicts = onRecord.map((writer) => ({
      producer: writer,
      verdict: classifyObservation(writer, dataset, observation),
    }));
    const decided =
      verdicts.find((entry) => entry.verdict.kind === "current") ??
      verdicts.find((entry) => entry.verdict.kind === "superseded") ??
      verdicts[0];
    const producer = decided.producer;
    const verdict = decided.verdict;
    emit(
      "compare",
      `checked ${tableLabel(dataset)}, which this task read`,
      verdict.kind === "current"
        ? "matches what was recorded"
        : verdict.kind === "superseded"
          ? verdict.by === "report"
            ? `${label(producer)} replaced it while this task was still running`
            : "an unreported change replaced it while this task was still running"
          : "does not match what was recorded, and nothing reported a change",
    );

    if (verdict.kind === "superseded") {
      /*
       * Every superseded input, not just the first.
       *
       * This kept only one because two marks on one task overwrote each other's
       * properties, so a second replaced input was narrated and then thrown
       * away. A mark now carries several causes, so each one is recorded; the
       * first in sorted order becomes the primary below, which is the sentence
       * the board leads with.
       */
      supersededMarks.push(
        supersededMark(dataset, producer, verdict, observation, new Date().toISOString()),
      );
      continue;
    }

    if (verdict.kind === "unknown") {
      const recorded = producer.observed?.[dataset] ?? producer.fingerprints[dataset];
      const kind = compareFingerprints(recorded, observation);
      if (kind) {
        observedChanges.push({
          dataset,
          kind,
          columns: columnChange(producer.run?.outputs[dataset]?.columns, observation.columns),
          excluded: producer.volatile?.[dataset],
          noticedBy: finishing,
        });
        // Written onto every writer on record, not just the one consulted for
        // the verdict. These bytes contradict all of their claims equally, and
        // an entry missing from one of them lets the next reader raise the same
        // silent change a second time against that writer.
        for (const writer of onRecord) {
          const patch = observationsFor.get(writer) ?? {};
          patch[dataset] = { schema: observation.schema, content: observation.content };
          observationsFor.set(writer, patch);
        }
      }
    }
  }

  const changes: DatasetChange[] = [...changedOutputs, ...observedChanges];
  const affected =
    changes.length === 0
      ? []
      : affectedBy(snapshot, changes, new Date().toISOString(), {
          // The reporter is excluded from both cascades for two different
          // reasons: its own outputs were just compared, and an input it
          // observed is the version its work was built on — the current one.
          excludeTasks: [report.taskUrn],
        });

  if (changes.length > 0) {
    emit(
      "walk",
      `walked lineage from ${changes.map((c) => tableLabel(c.dataset)).join(", ")}`,
      affected.length === 0
        ? "nothing finished downstream"
        : affected
            .map((entry) => `${label(entry.task)} (${hops(entry.mark.hops)})`)
            .sort()
            .join(", "),
    );
  }

  /*
   * Marks first, and the baseline only after they have landed.
   *
   * `recordCompletion` and the observation writes below are what MOVE the
   * baseline this whole decision was computed against: the new fingerprints
   * become the recorded ones, and a noticed version becomes the standing one.
   * Advancing the baseline first meant a cascade that failed halfway — one
   * unreachable tag, one GMS timeout — was lost permanently, because the retry
   * of that same completion report now compared the new bytes against
   * themselves, found no change, and answered `affected: 0`. The work
   * downstream stayed unmarked with nothing left in the record to notice it.
   *
   * In this order every write is idempotent under retry: the marks are recomputed
   * identically from an unmoved baseline and rewritten with the same values, and
   * the baseline advances only once nothing is left that could fail and lose them.
   * The cost is a window where downstream tasks carry marks while the task that
   * caused them still reads `running`. That window is the length of one write,
   * and the alternative is silence about work that is genuinely out of date.
   */
  await markAllStale(affected);

  await recordCompletion(finishing, report);

  // Remember what was observed, on the producer whose record it contradicts.
  // One write per producer, not per dataset, so two observations cannot race
  // each other's merge of the same property.
  await Promise.all(
    [...observationsFor.entries()].map(([producer, patch]) =>
      updateTaskProperties(producer.urn, {
        [PROP.observed]: JSON.stringify({ ...producer.observed, ...patch }),
      }),
    ),
  );

  /*
   * The finishing task's own mark, when it finished on inputs that moved under
   * it. One mark carrying one cause per replaced input: the first in sorted
   * order leads, and `mergeMark` folds the rest in as causes.
   *
   * After recordCompletion, deliberately: that call just recorded this task's
   * outputs and cleared any old mark, and this one writes the new mark it
   * earned. The other order would let the completion bookkeeping wipe the mark
   * it is supposed to leave standing. `mergeMark` is called against null rather
   * than against the standing mark for the same reason — recordCompletion has
   * already cleared it, and this task's own redo is exactly the event that
   * retires its previous causes.
   */
  const superseded: AffectedTask | null =
    supersededMarks.length > 0
      ? {
          task: finishing,
          // `mergeMark(next, carried)`, not the other way round: the second
          // argument becomes the primary, and the one that leads must stay the
          // first input in sorted order rather than whichever was folded in last.
          mark: supersededMarks.reduce((carried, next) => mergeMark(next, carried)),
        }
      : null;
  if (superseded) await markAllStale([superseded]);
  const marked = superseded ? [...affected, superseded] : affected;

  /*
   * The other direction: a redo that came out identical proves the flags
   * downstream of that output were standing on ground that never moved.
   * `restoredBy` owns every rule about which of them the records genuinely
   * prove, including refusing the whole question unless the finishing task was
   * itself flagged. This is the ONLY path that clears a flag on a task other
   * than the one reporting, and it is derived, never requested: no HTTP route
   * and no MCP tool can name a task to clear, because a tool to declare work
   * fresh would be a tool for silencing the one thing obsel is for.
   */
  const restored = restoredBy(snapshot, finishing, unchangedOutputs);
  await Promise.all(restored.map(clearRestored));

  const elapsedMs = Date.now() - startedAt;

  const outcomes: string[] = [];
  if (marked.length > 0) outcomes.push(`marked ${marked.length} out of date`);
  if (restored.length > 0) outcomes.push(`cleared ${restored.length} the redo proved sound`);
  emit(
    "done",
    outcomes.length === 0 ? "nothing marked" : outcomes.join(", "),
    `${elapsedMs} ms end to end`,
  );

  // Recorded onto the marks now that the real end-to-end figure is known, so the
  // dashboard can state a measured number instead of subtracting two timestamps
  // that were stamped in different processes and bracket neither end of the work.
  // Deliberately after the marks are already visible: this is bookkeeping, and a
  // failure here must not stop the flags from having landed.
  if (marked.length > 0) {
    await Promise.all(
      marked.map((entry) => {
        entry.mark.detectedMs = elapsedMs;
        return updateTaskProperties(entry.task.urn, {
          [PROP.staleDetectedMs]: String(elapsedMs),
        });
      }),
    );
  }

  return {
    taskUrn: report.taskUrn,
    changedOutputs,
    observedChanges: observedChanges.map(({ dataset, kind }) => ({ dataset, kind })),
    // Includes the finishing task's own superseded-input mark when it earned
    // one: it is finished work invalidated by a change, the change just landed
    // under it rather than upstream of somebody else.
    affected: marked,
    restored,
    elapsedMs,
  };
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
 * Unlike a mark's reason, which lives on the task's properties and is shown
 * when the task is opened, a clear leaves nothing behind to carry its reason —
 * absence of a mark is the record, the same as after a task's own redo. So the
 * traced step carries the full sentence: the trace and the completion reply
 * are the only places this decision speaks.
 */
async function clearRestored(entry: RestoredTask): Promise<void> {
  const { task, reason } = entry;

  await removeStaleTag([task.urn]);

  await updateTaskProperties(task.urn, {
    [PROP.status]: "complete",
    [PROP.staleCausedBy]: null,
    [PROP.staleCausedByTask]: null,
    [PROP.staleHops]: null,
    [PROP.staleChangeKind]: null,
    [PROP.staleColumns]: null,
    [PROP.staleReason]: null,
    [PROP.staleSince]: null,
    [PROP.staleDetectedMs]: null,
    [PROP.staleCauses]: null,
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
async function recordCompletion(finishing: TaskRecord, report: CompletionReport): Promise<void> {
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
    [PROP.staleCausedBy]: null,
    [PROP.staleCausedByTask]: null,
    [PROP.staleHops]: null,
    [PROP.staleChangeKind]: null,
    [PROP.staleColumns]: null,
    [PROP.staleReason]: null,
    [PROP.staleSince]: null,
    [PROP.staleDetectedMs]: null,
    [PROP.staleCauses]: null,
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

/** How a comparison came out, in words rather than in the enum's spelling. */
function verdict(kind: ChangeKind | null): string {
  if (kind === null) return "identical, nothing to do";
  if (kind === "schema") return "columns changed, values did not";
  if (kind === "content") return "values changed, columns did not";
  return "columns and values both changed";
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
async function markAllStale(entries: AffectedTask[]): Promise<void> {
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
