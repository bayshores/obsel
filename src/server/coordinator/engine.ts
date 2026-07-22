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
import { affectedBy, blocked, compareFingerprints, readyToStart } from "./staleness";
import type {
  AffectedTask,
  ChangeKind,
  CompletionReport,
  CoordinationResult,
  SwarmSnapshot,
  TaskRecord,
} from "./types";

/** Declare a task and what it will touch. */
export async function registerTask(
  name: string,
  reads: string[],
  writes: string[],
): Promise<TaskRecord> {
  return await writeTask(name, reads, writes);
}

/**
 * Move a task to `running`.
 *
 * Recorded fingerprints are deliberately left in place. They are the baseline
 * this run will be compared against, and clearing them would make every re-run
 * look like a first run — which reports no change and marks nothing stale.
 */
export async function startTask(urn: string): Promise<TaskRecord> {
  const task = await readTask(urn);
  if (!task) throw new Error(`cannot start ${urn}: no such task in DataHub`);
  if (task.status === "running") throw new Error(`task ${task.name} is already running`);

  return await updateTaskProperties(urn, { [PROP.status]: "running" });
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

  const changedOutputs: { dataset: string; kind: ChangeKind }[] = [];
  for (const dataset of Object.keys(report.fingerprints).sort()) {
    const kind = compareFingerprints(finishing.fingerprints[dataset], report.fingerprints[dataset]);
    if (kind) changedOutputs.push({ dataset, kind });
  }

  await recordCompletion(finishing, report);

  const affected =
    changedOutputs.length === 0
      ? []
      : affectedBy(snapshot, changedOutputs, new Date().toISOString(), {
          excludeTasks: [report.taskUrn],
        });

  // Independent per task, so they are written together rather than in a queue
  // whose length would show up in the reported latency.
  await Promise.all(affected.map(markStale));

  const elapsedMs = Date.now() - startedAt;

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

  await updateTaskProperties(finishing.urn, {
    [PROP.status]: "complete",
    [PROP.finishedAt]: report.finishedAt,
    [PROP.fingerprints]: JSON.stringify(fingerprints),
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
        [PROP.fingerprints]: null,
        [PROP.staleCausedBy]: null,
        [PROP.staleCausedByTask]: null,
        [PROP.staleHops]: null,
        [PROP.staleChangeKind]: null,
        [PROP.staleReason]: null,
        [PROP.staleSince]: null,
      }),
    ),
  );

  return {
    reset: snapshot.tasks.map((task) => task.name).sort(),
    tagsCleared: tagged.map((task) => task.name).sort(),
  };
}

/** Convenience for callers that hold a short task name rather than a URN. */
export { taskUrn };
