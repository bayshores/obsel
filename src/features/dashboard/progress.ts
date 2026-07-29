/**
 * What an agent is doing, and what it did — derived from a snapshot.
 *
 * The dashboard could already say *that* a task was working. It could not say for
 * how long, what did the work, or what came out, so a run that had hung and a
 * run that was fine looked identical for as long as the agent took. Everything
 * here exists to close that gap, and none of it is used to decide staleness.
 *
 * Two rules shape every function below.
 *
 * **One clock per measurement.** An in-flight elapsed is `SwarmSnapshot.at`
 * minus `TaskRecord.startedAt`, both stamped by obsel's own process. A finished
 * run's duration is the agent's own `run.ms`, measured inside the agent. Neither
 * figure is ever obtained by subtracting one process's timestamp from another's
 * — `timing.ts` documents what happened the last time this codebase did that.
 *
 * **Nothing is invented.** Every function returns null when the measurement is
 * missing, and the caller renders nothing at all. A zero would read as a
 * measurement of zero rather than as an absence.
 */

import type { TaskRecord } from "@/src/server/coordinator/types";

/**
 * Milliseconds a task has been in flight, or null when that is not knowable.
 *
 * Null rather than a number whenever: the task is not running, obsel never
 * stamped a start, either timestamp is unparseable, or the arithmetic comes out
 * negative. The negative case is real — a snapshot can be stamped fractionally
 * before the `startedAt` write it raced — and a clamp to zero would present a
 * contradiction as a reading.
 */
export function inFlightMs(task: TaskRecord, snapshotAt: string | null): number | null {
  if (task.status !== "running") return null;
  if (task.startedAt === null || snapshotAt === null) return null;

  const started = Date.parse(task.startedAt);
  const now = Date.parse(snapshotAt);
  if (Number.isNaN(started) || Number.isNaN(now)) return null;

  const elapsed = now - started;
  return elapsed < 0 ? null : elapsed;
}

/**
 * A duration a person can read at a glance, from milliseconds.
 *
 * Three bands, because one format cannot serve both a 60 ms coordinator round
 * trip and a 51-second agent. Sub-second keeps whole milliseconds; seconds get
 * one decimal, which is the precision the agent actually reports; past a minute
 * the decimal is noise and the minutes matter more.
 */
export function formatDuration(ms: number): string {
  // Matches the dashboard's BLANK placeholder: a withheld measurement, not a zero.
  if (!Number.isFinite(ms) || ms < 0) return "··";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;

  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)} m ${String(totalSeconds % 60).padStart(2, "0")} s`;
}

/**
 * The columns a task's outputs turned out to have, deduplicated in order.
 *
 * A task usually writes one table, but the record permits several, and showing
 * one table's columns under a task that wrote two would be a quiet lie about
 * which table is being described.
 */
function columnsOf(task: TaskRecord): string[] {
  if (task.run === null) return [];
  const seen = new Set<string>();
  const columns: string[] = [];
  for (const dataset of Object.keys(task.run.outputs).sort()) {
    for (const column of task.run.outputs[dataset].columns) {
      if (seen.has(column)) continue;
      seen.add(column);
      columns.push(column);
    }
  }
  return columns;
}

/** Total rows across everything this run wrote, or null when nothing was reported. */
export function rowsWritten(task: TaskRecord): number | null {
  if (task.run === null) return null;
  const shapes = Object.values(task.run.outputs);
  if (shapes.length === 0) return null;
  return shapes.reduce((total, shape) => total + shape.rows, 0);
}

/**
 * What did the work and how long it took, or null when neither was reported.
 *
 * The runner and the duration are each carried only when they were reported, and
 * neither is stood in for. A completion can arrive with the output shape and no
 * duration: the dashboard table form reports a table a person typed, and there is no run
 * to time. `formatDuration(0)` would put "0 ms" on the board, which reads as a
 * measurement — the one thing obsel must never print about a figure nobody took.
 *
 * Shared rather than inlined because the table panel states the same stamp about
 * the run that wrote the table, and two spellings of one fact would eventually
 * disagree about which half is optional.
 */
export function runStamp(run: TaskRecord["run"]): string | null {
  if (run === null) return null;
  const parts = [run.runner, run.ms === null ? null : formatDuration(run.ms)].filter(
    (part): part is string => part !== null && part !== "",
  );
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * The activity line: one sentence of what is happening, or what happened.
 *
 * Null means the dashboard was told nothing worth showing, and the row renders
 * without this line rather than with an empty one. A task can be `complete` and
 * still return null here — an agent is not obliged to report its detail, and
 * obsel does not fill the gap in.
 */
export function activityNote(task: TaskRecord, snapshotAt: string | null): string | null {
  if (task.status === "running") {
    const elapsed = inFlightMs(task, snapshotAt);
    return elapsed === null ? null : `in flight for ${formatDuration(elapsed)}`;
  }

  if (task.run === null) return null;

  // The row falls back to the rows and columns when no stamp was reported.
  const parts: string[] = [];
  const stamp = runStamp(task.run);
  if (stamp !== null) parts.push(stamp);

  const rows = rowsWritten(task);
  if (rows !== null) parts.push(`${rows} ${rows === 1 ? "row" : "rows"}`);

  const columns = columnsOf(task);
  if (columns.length > 0) parts.push(columns.join(", "));

  // A run object carrying nothing worth printing renders as no line, the same
  // as having no run object at all.
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * The right-hand timestamp for a ledger row, already labelled.
 *
 * A running task shows when it started, not when it last finished. `finishedAt`
 * survives across runs by design — it is the previous completion — so a task
 * being re-run displayed "finished 23:38:47" while it was visibly working, which
 * dates live work to a moment in the past.
 */
export function stampLabel(task: TaskRecord, clock: (iso: string | null) => string): string {
  if (task.stale !== null) return `marked ${clock(task.stale.since)}`;
  if (task.status === "running" && task.startedAt !== null) {
    return `started ${clock(task.startedAt)}`;
  }
  if (task.finishedAt === null) return "";
  return `finished ${clock(task.finishedAt)}`;
}
