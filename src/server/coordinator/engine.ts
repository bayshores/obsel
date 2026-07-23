import "server-only";

/**
 * The coordinator's IO half: read DataHub, ask `staleness.ts` what a change
 * broke, write the answer back.
 *
 * Every decision here is made by the pure functions in `staleness.ts` — this
 * file only moves data. Nothing in obsel's staleness reasoning is a model call;
 * it is graph traversal over recorded fingerprints, so the same inputs always
 * give the same answer and the whole of it is testable without a network.
 */

import { applyStaleTag, removeStaleTag } from "@/src/server/datahub/mcp";
import {
  PROP,
  readSnapshot,
  readTask,
  registerTask as writeTask,
  updateTaskProperties,
} from "@/src/server/datahub/client";
import { taskUrn } from "@/src/server/datahub/urns";
import {
  affectedBy,
  blocked,
  compareFingerprints,
  readyToStart,
  tableLabel,
  taskLabel,
} from "./staleness";
import { clear as clearTrace, emit } from "./trace";
import type {
  AffectedTask,
  ChangeKind,
  CompletionReport,
  CoordinationResult,
  SwarmSnapshot,
  TaskRecord,
} from "./types";

/** Declare a task, what it will touch, its human name, and its one-sentence job. */
export async function registerTask(
  name: string,
  reads: string[],
  writes: string[],
  description?: string,
  title?: string,
): Promise<TaskRecord> {
  const task = await writeTask(name, reads, writes, description, title);
  emit(
    "write",
    `Registered ${label(task)} in DataHub as a job, wired to what it reads and writes.`,
    `${task.reads.length} in, ${task.writes.length} out`,
  );
  return task;
}

/*
 * A traced step names a task the way the stale reasons do — `taskLabel` from
 * `staleness.ts`, imported rather than reimplemented here. This file had its own
 * copy of that fallback briefly, which meant the trace and the mark could have
 * drifted into calling the same task two different things on one screen.
 */
const label = taskLabel;

/** `1 hop`, `2 hops`. One place, so no traced step says "1 hops" again. */
function hops(count: number): string {
  return `${count} ${count === 1 ? "hop" : "hops"}`;
}

/**
 * Move a task to `running`.
 *
 * Recorded fingerprints are deliberately left in place. They are the baseline
 * this run will be compared against, and clearing them would make every re-run
 * look like a first run — which reports no change and marks nothing stale.
 *
 * `startedAt` is stamped here, on obsel's clock, so the cockpit can say how long
 * work in flight has been in flight. Taken before the write rather than after:
 * `updateTaskProperties` polls until DataHub confirms, and billing that wait to
 * the agent would overstate every elapsed figure on screen by the confirmation
 * time.
 *
 * The previous run's detail is cleared in the same write. It described a run
 * that is over, and leaving it would caption work happening now with the row
 * count and duration of the last one.
 */
export async function startTask(urn: string): Promise<TaskRecord> {
  const task = await readTask(urn);
  if (!task) throw new Error(`cannot start ${urn}: no such task in DataHub`);
  if (task.status === "running") throw new Error(`task ${task.name} is already running`);

  const started = await updateTaskProperties(urn, {
    [PROP.status]: "running",
    [PROP.startedAt]: new Date().toISOString(),
    [PROP.runRunner]: null,
    [PROP.runMs]: null,
    [PROP.runOutputs]: null,
  });
  emit(
    "write",
    `${label(started)} says it has started. Marked it running in DataHub — work in flight is never judged.`,
  );
  return started;
}

/**
 * Put a task that announced a start back to `registered`, because its run died.
 *
 * This is the other half of announcing before the work rather than after it.
 * obsel excludes `running` work from the cascade — correctly, since work in
 * flight will pick up the new input itself — so a task left at `running` by a
 * crashed agent is invisible to every future traversal while the board still
 * shows a healthy swarm. That is a false negative, which is the one failure
 * obsel cannot afford.
 *
 * Restores the status the task held before it announced, which is NOT always
 * `registered`. A failed *re-run* was `complete` or `stale` beforehand, and
 * demoting it to `registered` would erase a completion that genuinely happened
 * — and since obsel skips `registered` work in the cascade for the same reason
 * it skips `running` work, that demotion would reintroduce the exact false
 * negative this function exists to prevent, one step further along.
 *
 * The previous status is derived rather than stored, from state a failed run
 * never touches: an unresolved mark means it was `stale`, a recorded completion
 * means it was `complete`, and neither means it had never run. Deriving beats
 * remembering here because a stashed value can outlive a reset that clears
 * everything around it.
 *
 * Recorded fingerprints are kept either way: they are the baseline the eventual
 * successful run is compared against, and dropping them would make that run look
 * like a first run and mark nothing.
 *
 * The display detail of the *earlier* successful run does not come back — it was
 * cleared when this run announced, so that live work could not be captioned with
 * the previous run's row count and duration. A restored task therefore shows its
 * status and its fingerprints but no activity line until it runs again. That is
 * the honest trade: obsel holds no current detail for it, and shows none, rather
 * than showing a number that describes a different run.
 *
 * A task that is not running is left alone and reported as untouched. The agent
 * calls this from a failure path, where the run may have died before it ever
 * announced anything, and turning that into a second error would bury the real
 * one.
 */
export async function abandonTask(urn: string): Promise<{ task: TaskRecord; reverted: boolean }> {
  const task = await readTask(urn);
  if (!task) throw new Error(`cannot abandon ${urn}: no such task in DataHub`);
  if (task.status !== "running") return { task, reverted: false };

  const restored = priorStatus(task);

  const reverted = await updateTaskProperties(urn, {
    [PROP.status]: restored,
    // Only cleared when the task goes back to never-having-run. On a restored
    // completion the stamp still describes the run that produced the recorded
    // fingerprints, and blanking it would leave a finished task claiming it
    // never started.
    [PROP.startedAt]: restored === "registered" ? null : task.startedAt,
    [PROP.runRunner]: null,
    [PROP.runMs]: null,
    [PROP.runOutputs]: null,
  });
  return { task: reverted, reverted: true };
}

/**
 * What a task's status was before it announced a start it never finished.
 *
 * Derived from what a dead run leaves untouched. Order matters: an unresolved
 * mark outranks a recorded completion, because a stale task being re-run keeps
 * its mark through the run and must get it back if the run dies.
 */
function priorStatus(task: TaskRecord): "registered" | "complete" | "stale" {
  if (task.stale !== null) return "stale";
  if (task.finishedAt !== null && Object.keys(task.fingerprints).length > 0) return "complete";
  return "registered";
}

/** Everything the dashboard shows in one read. */
export async function readSwarm(): Promise<{
  snapshot: SwarmSnapshot;
  ready: TaskRecord[];
  blocked: { task: TaskRecord; waitingOn: string[] }[];
}> {
  const snapshot = await readSnapshot();
  return { snapshot, ready: readyToStart(snapshot), blocked: blocked(snapshot) };
}

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

  const snapshot = await readSnapshot();
  const finishing = snapshot.tasks.find((task) => task.urn === report.taskUrn);
  if (!finishing) {
    throw new Error(`completion reported for ${report.taskUrn}, which is not in the swarm`);
  }

  emit(
    "read",
    `${label(finishing)} reported that it finished. Read the whole swarm out of DataHub.`,
    `${snapshot.tasks.length} tasks`,
  );

  const changedOutputs: { dataset: string; kind: ChangeKind }[] = [];
  for (const dataset of Object.keys(report.fingerprints).sort()) {
    const previous = finishing.fingerprints[dataset];
    const kind = compareFingerprints(previous, report.fingerprints[dataset]);
    if (kind) changedOutputs.push({ dataset, kind });
    // The comparison is the whole decision, so it is narrated whichever way it
    // goes — a step that only spoke up when something changed would leave the
    // quiet case, which is the one obsel's credibility rests on, invisible.
    emit(
      "compare",
      previous === undefined
        ? `Looked for a previous fingerprint of ${tableLabel(dataset)} to compare against.`
        : `Compared the new ${tableLabel(dataset)} against the fingerprint recorded last time.`,
      previous === undefined ? "none held — first version, nothing to compare" : verdict(kind),
    );
  }

  await recordCompletion(finishing, report);

  const affected =
    changedOutputs.length === 0
      ? []
      : affectedBy(snapshot, changedOutputs, new Date().toISOString(), {
          excludeTasks: [report.taskUrn],
        });

  if (changedOutputs.length > 0) {
    emit(
      "walk",
      `Walked DataHub's lineage graph outwards from ${changedOutputs.map((c) => tableLabel(c.dataset)).join(", ")} to find finished work built on it.`,
      affected.length === 0
        ? "nothing finished downstream"
        : affected
            .map((entry) => `${label(entry.task)} (${hops(entry.mark.hops)})`)
            .sort()
            .join(", "),
    );
  }

  // Independent per task, so they are written together rather than in a queue
  // whose length would show up in the reported latency.
  await Promise.all(affected.map(markStale));

  const elapsedMs = Date.now() - startedAt;

  emit(
    "done",
    affected.length === 0
      ? "Nothing was marked."
      : `Marked ${affected.length} ${affected.length === 1 ? "task" : "tasks"} out of date, in DataHub and on the board.`,
    `${elapsedMs} ms end to end`,
  );

  // Recorded onto the marks now that the real end-to-end figure is known, so the
  // dashboard can state a measured number instead of subtracting two timestamps
  // that were stamped in different processes and bracket neither end of the work.
  // Deliberately after the marks are already visible: this is bookkeeping, and a
  // failure here must not stop the flags from having landed.
  if (affected.length > 0) {
    await Promise.all(
      affected.map((entry) => {
        entry.mark.detectedMs = elapsedMs;
        return updateTaskProperties(entry.task.urn, {
          [PROP.staleDetectedMs]: String(elapsedMs),
        });
      }),
    );
  }

  return { taskUrn: report.taskUrn, changedOutputs, affected, elapsedMs };
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

  // Replaced wholesale, never merged, and cleared when a run reports nothing.
  // Merging would let an old runner name or row count survive beside a new one
  // and describe a run that never happened. Absent reads as "not reported" in
  // the cockpit, which is the truthful rendering of having not been told.
  const run = report.run;

  await updateTaskProperties(finishing.urn, {
    [PROP.status]: "complete",
    [PROP.finishedAt]: report.finishedAt,
    [PROP.fingerprints]: JSON.stringify(fingerprints),
    [PROP.runRunner]: run ? run.runner : null,
    [PROP.runMs]: run ? String(Math.round(run.ms)) : null,
    [PROP.runOutputs]: run ? JSON.stringify(run.outputs) : null,
    [PROP.staleCausedBy]: null,
    [PROP.staleCausedByTask]: null,
    [PROP.staleHops]: null,
    [PROP.staleChangeKind]: null,
    [PROP.staleReason]: null,
    [PROP.staleSince]: null,
    [PROP.staleDetectedMs]: null,
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
 * Write one mark, in both places it has to exist.
 *
 * The custom properties are what obsel reads back and what carries the reason;
 * the tag is what a person sees in DataHub's own UI without knowing obsel
 * exists. Properties are written first so a tag never points at a task with no
 * recorded cause.
 */
/** How a comparison came out, in words rather than in the enum's spelling. */
function verdict(kind: ChangeKind | null): string {
  if (kind === null) return "identical — nothing to do";
  if (kind === "schema") return "its columns changed; the values did not";
  if (kind === "content") return "its values changed; the columns did not";
  return "both its columns and its values changed";
}

async function markStale(entry: AffectedTask): Promise<void> {
  const { task, mark } = entry;

  await updateTaskProperties(task.urn, {
    [PROP.status]: "stale",
    [PROP.staleCausedBy]: mark.causedBy,
    [PROP.staleCausedByTask]: mark.causedByTask ?? "",
    [PROP.staleHops]: String(mark.hops),
    [PROP.staleChangeKind]: mark.changeKind,
    [PROP.staleReason]: mark.reason,
    [PROP.staleSince]: mark.since,
    // Cleared, not left alone. `updateTaskProperties` MERGES, and the real
    // figure is stamped by a second write further down that is deliberately
    // deferred so a bookkeeping failure cannot stop the flags landing. Without
    // this line a task marked by a second, later cascade keeps the FIRST
    // cascade's measurement in the meantime — and the cockpit would report a
    // millisecond figure measured for a different change, which is precisely
    // the "number nobody measured" obsel refuses to display. Null removes the
    // property, so the gap reads "not measured" until the real one lands.
    [PROP.staleDetectedMs]: null,
  });

  await applyStaleTag([task.urn]);

  // After the tag, not before: by here both halves of the mark have landed and
  // been confirmed, so the step is reporting something that is true in DataHub
  // rather than something that has been requested.
  emit(
    "mark",
    `${label(task)} is built on it, ${hops(mark.hops)} away. Wrote its reason and the stale tag into DataHub.`,
    mark.reason,
  );
}

/**
 * Put every task back to `registered`, as though the swarm had never run.
 *
 * Needed between demo takes, and it has to clear two separate things. The
 * `obsel.*` properties live on `dataJobInfo`; the stale tag lives on `globalTags`,
 * a different aspect that a re-registration does not touch. Clearing only the
 * properties leaves DataHub's UI showing a stale tag from the previous take on a
 * task obsel now calls registered — which is exactly the disagreement obsel
 * exists to catch, filmed on camera.
 *
 * Baseline fingerprints go too. A reset means the next run is genuinely a first
 * run, which reports no change and marks nothing.
 */
export async function resetSwarm(): Promise<{ reset: string[]; tagsCleared: string[] }> {
  const snapshot = await readSnapshot();

  const tagged = snapshot.tasks.filter((task) => task.stale !== null);
  if (tagged.length > 0) {
    await removeStaleTag(tagged.map((task) => task.urn));
  }

  await Promise.all(
    snapshot.tasks.map((task) =>
      updateTaskProperties(task.urn, {
        [PROP.status]: "registered",
        [PROP.finishedAt]: null,
        [PROP.startedAt]: null,
        [PROP.fingerprints]: null,
        [PROP.runRunner]: null,
        [PROP.runMs]: null,
        [PROP.runOutputs]: null,
        [PROP.staleCausedBy]: null,
        [PROP.staleCausedByTask]: null,
        [PROP.staleHops]: null,
        [PROP.staleChangeKind]: null,
        [PROP.staleReason]: null,
        [PROP.staleSince]: null,
      }),
    ),
  );

  // Cleared, not appended to. The steps in the buffer describe a run whose state
  // no longer exists, and leaving them would have the panel narrating the
  // previous take over a board that has been wiped.
  clearTrace();
  emit(
    "write",
    "Reset. Put every task back to registered and took obsel's marks and tags off in DataHub.",
    `${snapshot.tasks.length} tasks, ${tagged.length} ${tagged.length === 1 ? "tag" : "tags"} removed`,
  );

  return {
    reset: snapshot.tasks.map((task) => task.name).sort(),
    tagsCleared: tagged.map((task) => task.name).sort(),
  };
}

/** Convenience for callers that hold a short task name rather than a URN. */
export { taskUrn };
