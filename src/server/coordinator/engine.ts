import "server-only";

/**
 * The task lifecycle in DataHub: declare one, start one, take a dead one back,
 * read the swarm, and wipe it between takes.
 *
 * What a completion invalidates is decided next door in `completion.ts`, over
 * the same pure rules in `staleness.ts`. Nothing in obsel's staleness reasoning
 * is a model call.
 */

import { removeStaleTag } from "@/src/server/datahub/mcp";
import {
  PROP,
  readSnapshot,
  readTask,
  registerTask as writeTask,
  updateTaskProperties,
} from "@/src/server/datahub/client";
import { FLOW_URN, isTaskUrn } from "@/src/server/datahub/urns";
import { rerunPlan, type RerunPlan } from "./rerun";
import { blocked, readyToStart, taskLabel } from "./staleness";
import { clear as clearTrace, emit } from "./trace";
import type { SwarmSnapshot, TaskRecord } from "./types";

/** Declare a task, what it will touch, its human name, and its one-sentence job. */
export async function registerTask(
  name: string,
  reads: string[],
  writes: string[],
  description?: string,
  title?: string,
  volatile?: Record<string, string[]>,
): Promise<TaskRecord> {
  const task = await writeTask(name, reads, writes, description, title, volatile);
  emit("write", `registered ${label(task)}`, `${task.reads.length} in, ${task.writes.length} out`);
  return task;
}

/*
 * A traced step names a task the way the stale reasons do — `taskLabel` from
 * `staleness.ts`, imported rather than reimplemented here. This file had its own
 * copy of that fallback briefly, which meant the trace and the mark could have
 * drifted into calling the same task two different things on one screen.
 */
const label = taskLabel;

/**
 * Move a task to `running`.
 *
 * Recorded fingerprints are deliberately left in place. They are the baseline
 * this run will be compared against, and clearing them would make every re-run
 * look like a first run — which reports no change and marks nothing stale.
 *
 * `startedAt` is stamped here, on obsel's clock, so the dashboard can say how long
 * work in flight has been in flight. Taken before the write rather than after:
 * `updateTaskProperties` polls until DataHub confirms, and billing that wait to
 * the agent would overstate every elapsed figure on screen by the confirmation
 * time.
 *
 * The previous run's detail is left in place too, and clearing it here is the
 * mistake to avoid. `run.outputs` is the baseline `columnChange` diffs to name
 * which columns moved, so clearing it makes every mark come back with
 * `columns: null` and the page falls back to "the columns changed" instead of
 * naming them. It captions nothing in the meantime: `activityNote` in
 * `progress.ts` is the only reader, and it returns an in-flight elapsed for a
 * running task without consulting `run` at all.
 */
export async function startTask(urn: string): Promise<TaskRecord> {
  const task = await readTask(urn);
  if (!task) throw new Error(`cannot start ${urn}: no such task in DataHub`);
  if (task.status === "running") throw new Error(`task ${task.name} is already running`);

  const started = await updateTaskProperties(urn, {
    [PROP.status]: "running",
    [PROP.startedAt]: new Date().toISOString(),
  });
  emit("write", `started ${label(started)}`, "running, never judged in flight");
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
 * Recorded fingerprints and the earlier run's detail are both kept, for the same
 * reasons `startTask` records: they are the baselines the eventual successful run
 * is compared against and described by, and dropping either makes that run look
 * like a first run.
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
  /**
   * What to redo and in what order, derived from the same snapshot.
   *
   * Empty when nothing is flagged, which is most of the time. It is on this
   * envelope rather than behind a route of its own because it is a reading of
   * the snapshot the caller already has, exactly like `ready` and `blocked`.
   */
  rerun: RerunPlan;
  datahubUrl: string | null;
}> {
  const snapshot = await readSnapshot();
  return {
    snapshot,
    ready: readyToStart(snapshot),
    blocked: blocked(snapshot),
    rerun: rerunPlan(snapshot),
    datahubUrl: datahubUrl(),
  };
}

/**
 * Where DataHub's own UI is, so the board can link a task to its real entity page.
 *
 * On the envelope rather than on `SwarmSnapshot`, deliberately. The snapshot is a
 * domain value the coordinator writes and `examples/*.json` captures as a record of
 * what DataHub held; a browser's base URL is neither of those things and would
 * outlive its meaning the moment a capture were replayed on another machine.
 *
 * Null when `DATAHUB_FRONTEND_URL` is unset, which the dashboard renders as no link
 * at all. A guessed default would produce a link that looks live and goes nowhere,
 * which is worse than its absence.
 *
 * Port 9002 is the frontend proxy, not GMS. `DATAHUB_GMS_URL` is emphatically not a
 * substitute: 8080 answers the API and serves no entity pages.
 */
function datahubUrl(): string | null {
  const raw = process.env.DATAHUB_FRONTEND_URL?.trim();
  if (!raw) return null;
  // Trailing slash stripped here so every caller can join with a leading one.
  return raw.replace(/\/+$/, "");
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

  /*
   * Refuses outright if anything in the snapshot is not a task in obsel's own
   * flow, before a single tag comes off.
   *
   * This is the most destructive call in the codebase: it strips status,
   * fingerprints, run detail and every mark from everything it is handed. That
   * is correct between demo takes on entities obsel registered, and it would be
   * vandalism on somebody's real catalog. The membership read is already
   * flow-scoped, so today this can only fire if that scoping breaks — which is
   * exactly when it needs to, and it has broken once before: the integration
   * suite's flow override silently did nothing because ESM hoisted the import
   * ahead of the assignment, and the tests were resetting the demo's own board.
   * A guard whose job is to catch a scoping failure cannot be derived from the
   * same scoping it is checking, so it names the flow independently.
   */
  const foreign = snapshot.tasks.filter((task) => !isTaskUrn(task.urn));
  if (foreign.length > 0) {
    throw new Error(
      `refusing to reset: ${foreign.length} of ${snapshot.tasks.length} entities are not tasks ` +
        `in ${FLOW_URN} (${foreign[0].urn}). Reset strips every recorded fact from what it is ` +
        `given, and obsel never does that to an entity it did not create.`,
    );
  }

  /*
   * Filtered on the tag DataHub actually holds, not on obsel's own record of
   * having written one.
   *
   * `task.stale` is obsel's properties; `task.staleTagged` is `globalTags`, a
   * different aspect written by a different call. Trusting the properties meant
   * reset could only clean up after itself when the two already agreed — and a
   * task whose properties were cleared while its tag survived is precisely the
   * disagreement that needs clearing most. That state is reachable: an
   * interleaved write leaves it, and one was left behind in the integration
   * flow on 2026-07-26 by the run that measured the concurrency defect. Reset
   * walked straight past it and every later run started on a board carrying a
   * flag from a take that was over.
   */
  const tagged = snapshot.tasks.filter((task) => task.staleTagged || task.stale !== null);
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
        [PROP.previousFingerprints]: null,
        [PROP.observed]: null,
        [PROP.runRunner]: null,
        [PROP.runMs]: null,
        [PROP.runOutputs]: null,
        [PROP.staleCausedBy]: null,
        [PROP.staleCausedByTask]: null,
        [PROP.staleHops]: null,
        [PROP.staleChangeKind]: null,
        [PROP.staleColumns]: null,
        [PROP.staleReason]: null,
        [PROP.staleSince]: null,
        // `staleDetectedMs` was missing from this list. Harmless, because
        // `parseStale` returns null once `causedBy` and `since` are gone and so
        // never reads it, but it left one obsel property behind on a board the
        // reset reports as wiped. A reset that half-clears is a worse thing to
        // debug than one that does not exist.
        [PROP.staleDetectedMs]: null,
        // Same rule, and this one is not harmless: `parseCauses` throws on a
        // list it cannot read, so a causes property surviving a reset that
        // wiped the fields around it would fail every later snapshot read.
        [PROP.staleCauses]: null,
      }),
    ),
  );

  // Cleared, not appended to. The steps in the buffer describe a run whose state
  // no longer exists, and leaving them would have the panel narrating the
  // previous take over a board that has been wiped.
  clearTrace();
  emit(
    "write",
    "reset every task to waiting",
    `${snapshot.tasks.length} tasks, ${tagged.length} ${tagged.length === 1 ? "tag" : "tags"} removed`,
  );

  return {
    reset: snapshot.tasks.map((task) => task.name).sort(),
    tagsCleared: tagged.map((task) => task.name).sort(),
  };
}

export { coordinateCompletion, coordinateObservation } from "./completion";
