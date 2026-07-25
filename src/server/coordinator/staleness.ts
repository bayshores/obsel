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
  InputObservation,
  OutputFingerprint,
  RestoredTask,
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
  /**
   * Set when this change was noticed by a reader rather than reported by the
   * task that wrote the dataset — the unreported change. The author is unknown,
   * so marks descending from it carry `causedByTask: null` instead of blaming
   * the producer for bytes it never wrote, and the hop-1 reason says the change
   * was never reported, naming the task whose read exposed it.
   */
  noticedBy?: TaskRecord | null;
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

/**
 * What a completing task's input observation means, against everything the
 * producer's record holds.
 *
 * This exists for concurrent swarms, where "what this task read" and "what is
 * currently true" can legitimately differ without anything having gone
 * unreported: a reader loads a table, the producer re-reports it while the
 * reader is still working, and the reader's completion then carries an
 * observation of bytes that are one version old. Before this function, that
 * benign race was indistinguishable from a silent edit — the reader's own
 * staleness went unflagged, and a false "nothing reported this change" cascade
 * fired against a change that was reported in full, overwriting correct marks
 * with a wrong story.
 *
 * The verdicts, in the order they are checked:
 *
 * - **current** — the observation matches the version that stands: the
 *   reader-noticed entry when one is standing, the recorded fingerprint
 *   otherwise. Nothing new to say.
 * - **superseded, by report** — the observation matches the fingerprint the
 *   producer's own re-report replaced. The reader read the previous version
 *   and finished after the replacement landed, so the reader's finished work
 *   is stale, with the producer named as the cause. No unreported-change alarm:
 *   the change was reported, just not before this reader loaded its input.
 * - **superseded, by notice** — a reader-noticed entry is standing (someone
 *   already caught an unreported edit) and this observation matches the
 *   producer's recorded fingerprint: the version the silent edit replaced.
 *   Same conclusion for the reader, but the author is unknown, exactly as it
 *   is for every mark descending from that notice.
 * - **unknown** — matches nothing on record. The unreported-change path: the
 *   only remaining explanation is bytes nothing ever reported.
 *
 * One version of memory, deliberately. A run long enough to straddle two
 * re-reports of one input classifies as unknown and raises the alarm with an
 * unknown author — imprecise attribution, never a false all-clear, which is
 * the direction every rule in this file falls.
 */
export type ObservationVerdict =
  { kind: "current" } | { kind: "superseded"; by: "report" | "notice" } | { kind: "unknown" };

export function classifyObservation(
  producer: TaskRecord,
  dataset: string,
  observation: InputObservation,
): ObservationVerdict {
  const matches = (record: OutputFingerprint | undefined): boolean =>
    record !== undefined &&
    record.schema === observation.schema &&
    record.content === observation.content;

  const noticed = producer.observed?.[dataset];
  const standing = noticed ?? producer.fingerprints[dataset];

  if (matches(standing)) return { kind: "current" };
  if (noticed && matches(producer.fingerprints[dataset])) {
    return { kind: "superseded", by: "notice" };
  }
  if (matches(producer.previousFingerprints?.[dataset])) {
    return { kind: "superseded", by: "report" };
  }
  return { kind: "unknown" };
}

/**
 * The mark a task earns by finishing on an input that was replaced mid-run.
 *
 * Carried by the FINISHING task itself, which is the one place `affectedBy`
 * can never reach it: the cascade excludes the reporter, and rightly, because
 * an observation normally proves the reporter read the current version. Here
 * the observation proves the opposite, and the proof is the same sha256
 * comparison every other mark rests on — the observed pair matches the
 * superseded record and differs from the standing one.
 *
 * `changeKind` is the difference between what was read and what now stands,
 * because that is the change this task's finished work is on the wrong side
 * of. The caller only reaches this after a superseded verdict, so the two
 * fingerprints are known to differ; a null comparison here means the call
 * order was violated, and that is raised rather than papered over with a
 * fabricated kind.
 */
export function supersededMark(
  dataset: string,
  producer: TaskRecord,
  verdict: { kind: "superseded"; by: "report" | "notice" },
  observation: InputObservation,
  now: string,
): StaleMark {
  const standing = producer.observed?.[dataset] ?? producer.fingerprints[dataset];
  const kind = compareFingerprints(
    { schema: observation.schema, content: observation.content },
    standing,
  );
  if (kind === null) {
    throw new Error(
      `supersededMark(${dataset}): the observation matches the standing record, ` +
        "so nothing was superseded; classifyObservation decides this, and it was not asked",
    );
  }

  const table = tableLabel(dataset);
  const reported = verdict.by === "report";
  return {
    causedBy: dataset,
    // A reported replacement has an author; a noticed one has whoever made the
    // silent edit, which is nobody on record. Blaming the producer for bytes
    // it never wrote is the mistake the unreported path already refuses.
    causedByTask: reported ? producer.urn : null,
    hops: 1,
    changeKind: kind,
    columns: reported
      ? columnChange(observation.columns, producer.run?.outputs[dataset]?.columns)
      : null,
    reason: reported
      ? `read ${table}, and ${taskLabel(producer)} replaced it before this finished; ` +
        `${describe(kind)} between the version read and the version now standing`
      : `read ${table}, and an unreported change replaced it before this finished; ` +
        `${describe(kind)} between the version read and the version now standing`,
    since: now,
    detectedMs: null,
  };
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
  noticedBy: TaskRecord | null,
): string {
  const table = tableLabel(changedDataset);
  if (hops === 1) {
    const base = `read ${table}, and ${describe(kind)} after this finished`;
    // The unreported case earns a longer sentence, because the usual mental
    // model — the producer re-ran — is exactly wrong here, and a reader acting
    // on that model would go ask the wrong agent what it did.
    return noticedBy
      ? `${base}. Nothing reported that change; obsel noticed it when ${taskLabel(noticedBy)} read the table`
      : base;
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
    /** Carried like `columns`: whether the ORIGIN's change was unreported. */
    noticedBy: TaskRecord | null;
  }

  const seenDatasets = new Set<string>(changes.map((c) => c.dataset));
  const seenTasks = new Set<string>(excluded);
  const affected: AffectedTask[] = [];

  let frontier: Pending[] = changes.map((c) => ({
    dataset: c.dataset,
    origin: c.dataset,
    kind: c.kind,
    columns: c.columns ?? null,
    noticedBy: c.noticedBy ?? null,
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
          // An unreported change has no known author. Naming the producer here
          // would blame it for bytes it never wrote, and someone acting on the
          // mark would go interrogate the wrong agent.
          causedByTask: pending.noticedBy ? null : (producerOf.get(pending.origin)?.urn ?? null),
          hops,
          changeKind: pending.kind,
          columns: pending.columns,
          reason: reasonFor(
            hops,
            pending.origin,
            hops > 1 ? (producerOf.get(pending.dataset) ?? null) : null,
            pending.kind,
            pending.noticedBy,
          ),
          since: now,
          // Filled in by the engine once every mark from this change has been
          // written and confirmed. Deciding is pure and does not know how long
          // the writes will take, and guessing a number here would be the
          // unmeasured timing claim obsel's rules forbid.
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
            noticedBy: pending.noticedBy,
          });
        }
      }
    }

    frontier = next;
  }

  return affected;
}

/**
 * Which stale tasks a redo has just proven still sound.
 *
 * When a stale task re-runs and its output comes out byte-identical, the tasks
 * downstream of that output were flagged for ground that never actually moved.
 * This function finds them, so a repair can redo one task instead of every
 * flagged one. The inverse of `affectedBy`, and held to the inverse standard:
 * `affectedBy` may over-mark and be forgiven, but a wrong answer here declares
 * broken work sound, so **every rule below prefers keeping a flag to clearing
 * one**. A task this function refuses to clear is cleared the ordinary way, by
 * its own redo.
 *
 * A stale, finished task S clears only when every dataset E it reads is proven
 * still the version S was built on:
 *
 * - **No producer in the swarm** — nothing here has ever written E, so there is
 *   no recorded claim for the current bytes to contradict.
 * - Otherwise the producer must be `complete` (the task that just reported and
 *   tasks cleared earlier in this same pass count), because a stale producer is
 *   itself standing on moved ground and a running one has not settled what E is.
 * - **No standing reader observation of E.** An `observed` entry means someone
 *   has already read bytes the producer never reported writing; the unreported
 *   change is live and nothing about this redo answers for it.
 * - **S's own mark must not name E as the table that moved.** A hop-one mark is
 *   the record saying E changed after S finished, and no amount of soundness in
 *   S's other inputs argues with it.
 * - **The producer's previous report must predate S's finish.** The recorded
 *   fingerprint of E is whatever the producer last reported; that is what S
 *   read only if nothing re-reported E after S finished. The snapshot is read
 *   before the triggering completion lands, so for the finishing task this is
 *   its previous run's time — which is exactly what stops an identical re-run
 *   of the *changed* table from clearing its own direct readers: their ground
 *   really did move, and the re-report that moved it postdates their work.
 *   The comparison is between two agent-stamped finish times; where they are
 *   missing or unreadable the answer is refusal, not a guess.
 *
 * Runs to a fixpoint: clearing S makes S count as `complete` for the tasks
 * built on S's output, whose bytes were never re-reported and so stand exactly
 * as read. Each round either clears a task or stops, so a cyclic graph
 * terminates after at most one round per task.
 *
 * Fires only for a redo that proved something: the finishing task carried a
 * mark, and at least one output it reported came back identical. A first run,
 * a plain re-run of unmarked work, and a redo that changed its output all
 * return nothing — the last one because a changed output is new ground, and
 * `affectedBy` is already marking what stands on it.
 */
export function restoredBy(
  snapshot: SwarmSnapshot,
  finishing: TaskRecord,
  unchangedOutputs: readonly string[],
): RestoredTask[] {
  if (finishing.stale === null || unchangedOutputs.length === 0) return [];

  const producerOf = new Map<string, TaskRecord>();
  for (const task of snapshot.tasks) {
    for (const output of task.writes) producerOf.set(output, task);
  }

  const finishedAtOf = (task: TaskRecord): number => {
    if (task.finishedAt === null) return Number.NaN;
    return Date.parse(task.finishedAt);
  };

  const cleared = new Set<string>();

  const sound = (input: string, reader: TaskRecord): boolean => {
    const producer = producerOf.get(input);
    if (!producer) return true;

    const settled =
      producer.urn === finishing.urn || cleared.has(producer.urn) || producer.status === "complete";
    if (!settled) return false;

    if (producer.observed?.[input]) return false;
    if (reader.stale?.causedBy === input) return false;

    const wrote = finishedAtOf(producer);
    const read = finishedAtOf(reader);
    if (Number.isNaN(wrote) || Number.isNaN(read)) return false;
    return wrote <= read;
  };

  // Sorted once so the output order cannot depend on registration order.
  const candidates = [...snapshot.tasks].sort((a, b) => a.urn.localeCompare(b.urn));
  const reason = restoredReason(finishing, unchangedOutputs);
  const restored: RestoredTask[] = [];

  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const task of candidates) {
      if (task.status !== "stale" || task.stale === null) continue;
      if (task.urn === finishing.urn || cleared.has(task.urn)) continue;
      if (task.finishedAt === null) continue;

      if (task.reads.every((input) => sound(input, task))) {
        cleared.add(task.urn);
        restored.push({ task, reason });
        progressed = true;
      }
    }
  }

  return restored;
}

/** The one sentence every task cleared by the same redo carries. */
function restoredReason(finishing: TaskRecord, unchangedOutputs: readonly string[]): string {
  const tables = unchangedOutputs.map(tableLabel).sort().join(", ");
  const came = unchangedOutputs.length === 1 ? "it came out identical" : "they came out identical";
  return `${taskLabel(finishing)} redid ${tables} and ${came}, so everything this was built on still stands`;
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
