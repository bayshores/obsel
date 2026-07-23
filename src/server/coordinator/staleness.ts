/**
 * Deciding what a change breaks.
 *
 * Pure functions over a snapshot: no network, no clock, no DataHub. Every rule
 * obsel's trustworthiness rests on is decided here, so all of it is testable
 * without standing anything up. The IO lives in `engine.ts`.
 */

import type {
  AffectedTask,
  ChangeKind,
  ColumnChange,
  OutputFingerprint,
  StaleMark,
  SwarmSnapshot,
  TaskRecord,
} from "./types";

/** One upstream output that moved, as `affectedBy` is told about it. */
export interface DatasetChange {
  dataset: string;
  kind: ChangeKind;
  /** Which columns moved, when known. Described, never used to decide. */
  columns?: ColumnChange | null;
}

/**
 * What moved between two fingerprints, or null when nothing did.
 *
 * The null case is the one that matters: a task that re-runs and produces
 * exactly what it produced before must not raise anything. Without this,
 * every scheduled re-run marks the whole pipeline stale and the tool becomes
 * noise people mute.
 */
export function compareFingerprints(
  before: OutputFingerprint | undefined,
  after: OutputFingerprint,
): ChangeKind | null {
  // Never seen before: this is a first run, not a change to something existing.
  if (!before) return null;

  const schemaMoved = before.schema !== after.schema;
  const contentMoved = before.content !== after.content;

  if (schemaMoved && contentMoved) return "both";
  if (schemaMoved) return "schema";
  if (contentMoved) return "content";
  return null;
}

/**
 * Which columns left and which arrived between two runs of the same output.
 *
 * Set difference, sorted, and null whenever there is nothing nameable to show.
 * The null cases are the interesting ones:
 *
 * - **Either list unknown.** `OutputShape` is optional on a completion report,
 *   and a mark written before obsel recorded shapes has neither side. Absent is
 *   reported as absent rather than as "no columns changed", which would be a
 *   claim obsel cannot support.
 * - **Equal sets.** `agents/fingerprint.py:58` hashes the *sorted* column names,
 *   so two runs whose column sets match have byte-identical schema fingerprints.
 *   This function returning null therefore lines up exactly with
 *   `compareFingerprints` declining to report a schema change: a pure reordering
 *   is invisible to both, and neither invents a difference the other denies.
 *
 * Pure set logic, so a column moving position, appearing twice, or the lists
 * arriving in different orders cannot change the answer.
 */
export function columnChange(
  before: readonly string[] | undefined,
  after: readonly string[] | undefined,
): ColumnChange | null {
  if (before === undefined || after === undefined) return null;

  const had = new Set(before);
  const has = new Set(after);
  const removed = [...had].filter((column) => !has.has(column)).sort();
  const added = [...has].filter((column) => !had.has(column)).sort();

  if (removed.length === 0 && added.length === 0) return null;
  return { added, removed };
}

function describe(kind: ChangeKind): string {
  switch (kind) {
    case "schema":
      return "its columns changed";
    case "content":
      return "its rows changed";
    case "both":
      return "its columns and rows changed";
  }
}

function reasonFor(
  hops: number,
  changedDataset: string,
  viaTask: TaskRecord | null,
  kind: ChangeKind,
): string {
  const table = tableLabel(changedDataset);
  if (hops === 1) {
    return `read ${table}, and ${describe(kind)} after this finished`;
  }
  const via = viaTask ? taskLabel(viaTask) : "an upstream task";
  return `built on work from ${via}, which is itself out of date because ${table} changed`;
}

/** Last dotted segment of a dataset URN, for readable messages. */
export function shortName(datasetUrn: string): string {
  const parts = datasetUrn.split(",");
  const path = parts.length > 1 ? parts[1] : datasetUrn;
  const segments = path.split(".");
  return segments[segments.length - 1];
}

/**
 * What to call a table in a sentence a person reads.
 *
 * `clean_orders` → `clean orders`. Underscores are how the table is spelled in
 * a warehouse, not how it is spelled in English, and this string ends up in the
 * one sentence on the board that has to land with someone who has never seen the
 * pipeline: the reason a mark exists.
 *
 * Changed here rather than at render time on purpose. The ledger prints the
 * stored reason verbatim, precisely so there is one authoritative wording of
 * each fact instead of a stored form and a prettier displayed form that could
 * disagree. Nothing machine-readable is lost: which dataset changed is carried
 * exactly on `obsel.stale.causedBy` as a URN, and which task it came through on
 * `obsel.stale.causedByTask`. This is the prose, and prose is for reading.
 */
export function tableLabel(datasetUrn: string): string {
  return shortName(datasetUrn).replace(/_/g, " ");
}

/**
 * What to call a task in a sentence a person reads: its registered human name.
 *
 * Falls back to the de-underscored identifier, so a pipeline registered without
 * titles still reads as words rather than as code.
 */
export function taskLabel(task: Pick<TaskRecord, "name" | "title">): string {
  const title = task.title;
  return title !== undefined && title !== null && title !== ""
    ? title
    : task.name.replace(/_/g, " ");
}

/**
 * Which finished tasks a set of changed datasets invalidates.
 *
 * Walks outward from the change, alternating between "who read this data" and
 * "what did that task write", so a task is reached even when it never touched
 * the original change — only something built on it.
 *
 * Three rules are enforced here, each preventing a specific wrong answer:
 *
 * - **Only finished work is eligible.** A task that is still running will read
 *   the new data itself, so it is not stale, and its outputs are not final —
 *   which is why the walk also stops at it rather than propagating through.
 *   That subtree gets judged when the task reports its own completion.
 * - **Shortest distance wins.** A task reachable by several paths is reported
 *   once, at its closest hop, so the explanation names the nearest cause.
 * - **Traversal terminates.** Datasets and tasks each carry a visited set, so a
 *   cycle ends instead of looping.
 */
export function affectedBy(
  snapshot: SwarmSnapshot,
  changes: DatasetChange[],
  now: string,
  options: { excludeTasks?: string[] } = {},
): AffectedTask[] {
  if (changes.length === 0) return [];

  const excluded = new Set(options.excludeTasks ?? []);
  const producerOf = new Map<string, TaskRecord>();
  const readersOf = new Map<string, TaskRecord[]>();

  for (const task of snapshot.tasks) {
    for (const output of task.writes) producerOf.set(output, task);
    for (const input of task.reads) {
      const readers = readersOf.get(input);
      if (readers) readers.push(task);
      else readersOf.set(input, [task]);
    }
  }

  // Each frontier entry remembers the original change it descends from, so a
  // task five hops out can still name the table that actually moved.
  interface Pending {
    dataset: string;
    origin: string;
    kind: ChangeKind;
    /**
     * The ORIGIN's column change, carried unchanged however far the walk goes.
     *
     * A task five hops out is stale because of what happened to the origin, and
     * its mark names the origin on `causedBy`, so the columns it reports must be
     * the origin's too. Re-deriving them at each hop would describe the wrong
     * table.
     */
    columns: ColumnChange | null;
  }

  const seenDatasets = new Set<string>(changes.map((c) => c.dataset));
  const seenTasks = new Set<string>(excluded);
  const affected: AffectedTask[] = [];

  let frontier: Pending[] = changes.map((c) => ({
    dataset: c.dataset,
    origin: c.dataset,
    kind: c.kind,
    columns: c.columns ?? null,
  }));
  let hops = 0;

  while (frontier.length > 0) {
    hops += 1;
    const next: Pending[] = [];

    for (const pending of frontier) {
      // Sorted so the output is deterministic regardless of registration order.
      const readers = [...(readersOf.get(pending.dataset) ?? [])].sort((a, b) =>
        a.urn.localeCompare(b.urn),
      );

      for (const task of readers) {
        if (seenTasks.has(task.urn)) continue;

        // Work that has not finished cannot be stale, and its outputs are not
        // final, so the walk does not continue through it.
        if (task.status !== "complete" && task.status !== "stale") continue;

        seenTasks.add(task.urn);

        const mark: StaleMark = {
          causedBy: pending.origin,
          causedByTask: producerOf.get(pending.origin)?.urn ?? null,
          hops,
          changeKind: pending.kind,
          columns: pending.columns,
          reason: reasonFor(
            hops,
            pending.origin,
            hops > 1 ? (producerOf.get(pending.dataset) ?? null) : null,
            pending.kind,
          ),
          since: now,
          // Filled in by the engine once every mark from this change has been
          // written and confirmed. Deciding is pure and does not know how long
          // the writes will take, and guessing a number here would be the
          // unmeasured timing claim CLAUDE.md forbids.
          detectedMs: null,
        };
        affected.push({ task, mark });

        for (const output of task.writes) {
          if (seenDatasets.has(output)) continue;
          seenDatasets.add(output);
          next.push({
            dataset: output,
            origin: pending.origin,
            kind: pending.kind,
            columns: pending.columns,
          });
        }
      }
    }

    frontier = next;
  }

  return affected;
}

/**
 * Which tasks may start: every input either has no producer, or its producer
 * has finished. A task whose input is still being written waits.
 *
 * Stale producers count as finished — their output exists, it is just known to
 * be out of date, which is a decision for a human rather than a reason to block.
 */
export function readyToStart(snapshot: SwarmSnapshot): TaskRecord[] {
  const producerOf = new Map<string, TaskRecord>();
  for (const task of snapshot.tasks) {
    for (const output of task.writes) producerOf.set(output, task);
  }

  return snapshot.tasks
    .filter((task) => task.status === "registered")
    .filter((task) =>
      task.reads.every((input) => {
        const producer = producerOf.get(input);
        if (!producer) return true; // supplied from outside the swarm
        return producer.status === "complete" || producer.status === "stale";
      }),
    )
    .sort((a, b) => a.urn.localeCompare(b.urn));
}

/** Tasks that cannot start yet, with what each is waiting on. */
export function blocked(snapshot: SwarmSnapshot): { task: TaskRecord; waitingOn: string[] }[] {
  const producerOf = new Map<string, TaskRecord>();
  for (const task of snapshot.tasks) {
    for (const output of task.writes) producerOf.set(output, task);
  }

  const result: { task: TaskRecord; waitingOn: string[] }[] = [];
  for (const task of snapshot.tasks) {
    if (task.status !== "registered") continue;
    const waitingOn = task.reads
      .map((input) => producerOf.get(input))
      .filter((producer): producer is TaskRecord => {
        if (!producer) return false;
        return producer.status !== "complete" && producer.status !== "stale";
      })
      .map((producer) => producer.name);
    if (waitingOn.length > 0) result.push({ task, waitingOn });
  }
  return result.sort((a, b) => a.task.urn.localeCompare(b.task.urn));
}
