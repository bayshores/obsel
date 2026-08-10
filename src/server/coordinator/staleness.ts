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
  StaleCause,
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
   * Columns the producer registered as volatile, which the comparison behind
   * this change excluded.
   *
   * Described in the hop-one sentence, never used to decide anything: the
   * decision was already made, by hashes taken under this exact list. It is in
   * the sentence because a reader who knows the table carries a `loaded_at`
   * otherwise cannot tell a real change from the clock moving, and those demand
   * opposite responses.
   */
  excluded?: readonly string[];
  /**
   * Present when this change was never reported by the task that wrote the
   * dataset, whoever noticed it. The author is unknown either way, so marks
   * descending from it carry `causedByTask: null` rather than blaming the
   * producer for bytes it never wrote.
   *
   * `noticedBy` names the task whose read exposed it, and is null when an
   * outside observer reported the table's contents directly. Presence and inner
   * null are different facts, which is why this is an object rather than a bare
   * task: `noticedBy: null` on its own could not tell "reported by the producer"
   * apart from "unreported, and nobody in the swarm found it".
   */
  unreported?: { noticedBy: TaskRecord | null };
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
  unreported: { noticedBy: TaskRecord | null } | null,
  excluded: readonly string[] = [],
): string {
  const table = tableLabel(changedDataset);
  if (hops === 1) {
    /*
     * When the producer registered volatile columns, the sentence says so.
     *
     * Otherwise a reader who knows the table has a `loaded_at` in it cannot tell
     * whether obsel is reporting a real change or the clock moving, and the two
     * demand opposite responses. Appended only when a list exists, so every
     * ordinary mark reads exactly as it always has.
     */
    const aside =
      excluded.length > 0
        ? `, comparing everything except ${[...excluded].sort().join(" and ")}, which it registered as changing every run`
        : "";
    const base = `read ${table}, and ${describe(kind)} after this finished${aside}`;
    if (unreported === null) return base;
    /*
     * The unreported case earns a longer sentence, because the usual mental
     * model — the producer re-ran — is exactly wrong here, and a reader acting
     * on that model would go ask the wrong agent what it did.
     *
     * Two shapes of it. A reader in the swarm exposed the change by reading the
     * table, and naming that reader tells somebody where to look. An outside
     * observer reported the contents directly, and there is no reader to name;
     * saying so is more honest than leaving the sentence to imply a swarm member
     * found it.
     */
    return unreported.noticedBy
      ? `${base}. Nothing reported that change; obsel noticed it when ${taskLabel(unreported.noticedBy)} read the table`
      : `${base}. Nothing reported that change; an outside observer reported the table's contents`;
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

/** `1 hop`, `2 hops`. One place, so nothing obsel writes says "1 hops" again. */
export function hopLabel(count: number): string {
  return `${count} ${count === 1 ? "hop" : "hops"}`;
}

/**
 * Every task that writes each dataset, not one of them.
 *
 * Two tasks writing the same table is legal and happens: a backfill beside a
 * daily build, two agents appending to one export. The three call sites that
 * each resolved a producer their own way disagreed about which one counted —
 * one kept the last registered, one kept the first — and the disagreement was
 * reachable: a flag could be cleared because the wrong writer of the same table
 * looked settled. The map holds all of them so each caller states its own rule
 * out loud, and every rule below is the conservative one.
 */
export function producersOf(snapshot: SwarmSnapshot): Map<string, TaskRecord[]> {
  const producers = new Map<string, TaskRecord[]>();
  for (const task of snapshot.tasks) {
    for (const output of task.writes) {
      const writers = producers.get(output);
      if (writers) writers.push(task);
      else producers.set(output, [task]);
    }
  }
  return producers;
}

/**
 * The producer to name in a sentence, or nobody.
 *
 * Attribution needs certainty. With two writers on one table obsel cannot know
 * which of them wrote the bytes that moved, and naming either one sends whoever
 * acts on the mark to interrogate an agent that may have written nothing — the
 * same wrong turn the unreported-change path already refuses to cause. The mark
 * still fires; it just declines to guess an author.
 */
function soleProducer(producers: Map<string, TaskRecord[]>, dataset: string): TaskRecord | null {
  const writers = producers.get(dataset);
  return writers !== undefined && writers.length === 1 ? writers[0] : null;
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
  const producers = producersOf(snapshot);
  const readersOf = new Map<string, TaskRecord[]>();

  for (const task of snapshot.tasks) {
    for (const input of task.reads) {
      const readers = readersOf.get(input);
      if (readers) readers.push(task);
      else readersOf.set(input, [task]);
    }
  }

  /*
   * One walk per change, not one walk from all of them.
   *
   * The distinction is the whole of this function's shape. Two PATHS from one
   * origin to a task is one reason that task is broken, reported at the shorter
   * distance — that is what the per-walk visited set gives, and it is unchanged.
   * Two ORIGINS reaching the same task are two independent reasons, and a shared
   * visited set silently discarded the second: whichever change was listed first
   * claimed the task, and the other left no record at all.
   *
   * That mattered when the first cause was repaired. The flag stayed, correctly,
   * because the second cause was still unrepaired — and the sentence beside it
   * still named the table that had just been fixed. Somebody checking whether to
   * trust obsel found a flag whose stated reason was demonstrably no longer true.
   */
  const perTask = new Map<string, { task: TaskRecord; marks: StaleMark[] }>();

  for (const change of changes) {
    for (const found of walkFrom(change)) {
      const existing = perTask.get(found.task.urn);
      if (existing) existing.marks.push(found.mark);
      else perTask.set(found.task.urn, { task: found.task, marks: [found.mark] });
    }
  }

  /** Everything one change reaches, at that change's own shortest distances. */
  function walkFrom(change: DatasetChange): { task: TaskRecord; mark: StaleMark }[] {
    const origin = change.dataset;
    const kind = change.kind;
    const columns = change.columns ?? null;
    const unreported = change.unreported ?? null;

    // Per walk, so one origin's reach cannot hide another's. Excluded tasks are
    // seeded into every walk: the reporter is out of all of them.
    const seenDatasets = new Set<string>([origin]);
    const seenTasks = new Set<string>(excluded);
    const found: { task: TaskRecord; mark: StaleMark }[] = [];

    let frontier: string[] = [origin];
    let hops = 0;

    while (frontier.length > 0) {
      hops += 1;
      const next: string[] = [];

      for (const dataset of frontier) {
        // Sorted so the output is deterministic regardless of registration order.
        const readers = [...(readersOf.get(dataset) ?? [])].sort((a, b) =>
          a.urn.localeCompare(b.urn),
        );

        for (const task of readers) {
          if (seenTasks.has(task.urn)) continue;

          // Work that has not finished cannot be stale, and its outputs are not
          // final, so the walk does not continue through it.
          if (task.status !== "complete" && task.status !== "stale") continue;

          seenTasks.add(task.urn);

          found.push({
            task,
            mark: {
              causedBy: origin,
              // An unreported change has no known author. Naming the producer
              // here would blame it for bytes it never wrote, and someone acting
              // on the mark would go interrogate the wrong agent.
              causedByTask: unreported ? null : (soleProducer(producers, origin)?.urn ?? null),
              hops,
              changeKind: kind,
              columns,
              reason: reasonFor(
                hops,
                origin,
                hops > 1 ? soleProducer(producers, dataset) : null,
                kind,
                unreported,
                change.excluded ?? [],
              ),
              since: now,
              // Filled in by the engine once every mark from this change has been
              // written and confirmed. Deciding is pure and does not know how long
              // the writes will take, and guessing a number here would be the
              // unmeasured timing claim obsel's rules forbid.
              detectedMs: null,
            },
          });

          for (const output of task.writes) {
            if (seenDatasets.has(output)) continue;
            seenDatasets.add(output);
            next.push(output);
          }
        }
      }

      frontier = next;
    }

    return found;
  }

  /*
   * One mark per task, carrying every cause that reached it.
   *
   * The primary — the fields the board and DataHub's properties have always
   * read — is the nearest cause, so the sentence a person sees still names the
   * closest thing that broke this. Ties go to the lexicographically smaller
   * origin URN, which is arbitrary and is stated out loud so the answer is
   * deterministic rather than dependent on the order changes arrived in.
   */
  const affected: AffectedTask[] = [];
  for (const { task, marks } of perTask.values()) {
    const ordered = [...marks].sort(
      (a, b) => a.hops - b.hops || a.causedBy.localeCompare(b.causedBy),
    );
    affected.push({ task, mark: { ...ordered[0], causes: ordered.map(causeOf) } });
  }
  affected.sort((a, b) => a.mark.hops - b.mark.hops || a.task.urn.localeCompare(b.task.urn));

  return affected;
}

/** The machine-readable half of a mark. The prose stays on the primary. */
function causeOf(mark: StaleMark): StaleCause {
  return {
    causedBy: mark.causedBy,
    causedByTask: mark.causedByTask,
    hops: mark.hops,
    changeKind: mark.changeKind,
    since: mark.since,
  };
}

/**
 * The mark to write when a task that is ALREADY flagged is flagged again.
 *
 * Two cascades reaching one task is ordinary: a second table changes while the
 * first repair has not happened yet. The old behavior overwrote the whole mark,
 * so the first cause vanished from the record — and then a repair of the second
 * cause left a task whose only remaining reason had already been forgotten.
 *
 * The incoming mark becomes the primary, which preserves what the board has
 * always shown: the newest cascade is what a person is watching happen. The
 * causes are the union, deduped on the pair that identifies a cause, with the
 * newer entry winning so a re-detection of the same cause updates its distance
 * and timestamp rather than appearing twice.
 *
 * **Never drops a recorded cause.** Every rule in this file falls toward keeping
 * a flag and keeping its reasons; forgetting one is how a flag ends up standing
 * with nothing left to explain it.
 */
export function mergeMark(existing: StaleMark | null, incoming: StaleMark): StaleMark {
  const causes = new Map<string, StaleCause>();

  /*
   * `\0` as the separator because it cannot occur in either half, so two causes
   * cannot collide by one's suffix meeting the other's prefix.
   *
   * Written as the escape, not as a literal NUL byte. It was a literal one, and
   * the cost was not in the running code: a raw NUL makes the whole file read as
   * binary, so `grep` reported nothing in it and silently skipped the module
   * every search of this codebase most needs to find.
   */
  const key = (cause: StaleCause): string => `${cause.causedBy}\0${cause.causedByTask ?? ""}`;

  // Existing first, incoming second, so the incoming copy of a repeated cause
  // overwrites the older one rather than being discarded by it.
  for (const cause of causesOf(existing)) causes.set(key(cause), cause);
  for (const cause of causesOf(incoming)) causes.set(key(cause), cause);

  const ordered = [...causes.values()].sort(
    (a, b) => a.hops - b.hops || a.causedBy.localeCompare(b.causedBy),
  );
  return { ...incoming, causes: ordered };
}

/**
 * A mark's causes, including marks written before the list existed.
 *
 * An older mark has no `causes` and is not causeless: its primary fields ARE its
 * one cause. Reading absence as an empty list would quietly discard the reason a
 * pre-existing flag was raised the first time a new cascade touched it.
 */
export function causesOf(mark: StaleMark | null): StaleCause[] {
  if (mark === null) return [];
  return mark.causes && mark.causes.length > 0 ? mark.causes : [causeOf(mark)];
}

/**
 * Which stale tasks a redo has just proven still sound.
 *
 * When a stale task re-runs and its output comes out identical, the tasks
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
 * - Otherwise EVERY producer of E must pass every rule below, not one of them.
 *   Which writer wrote the bytes now standing is not recorded anywhere, so a
 *   rule that consulted a single writer would be picking one at random; if the
 *   one it happened to pick looks settled while the other is stale, the flag
 *   comes off work built on ground that did move.
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

  const producers = producersOf(snapshot);

  const finishedAtOf = (task: TaskRecord): number => {
    if (task.finishedAt === null) return Number.NaN;
    return Date.parse(task.finishedAt);
  };

  const cleared = new Set<string>();

  const provenBy = (producer: TaskRecord, input: string, reader: TaskRecord): boolean => {
    const settled =
      producer.urn === finishing.urn || cleared.has(producer.urn) || producer.status === "complete";
    if (!settled) return false;

    if (producer.observed?.[input]) return false;
    /*
     * EVERY cause the reader's mark records, not only the one it leads with.
     *
     * A hop-one cause naming this input is the record saying the input changed
     * after the reader finished, and no amount of soundness elsewhere argues
     * with it. Once a mark can carry several causes, checking only the primary
     * means a cause demoted out of that slot by a nearer one stops being
     * consulted — so a redo could clear a flag over a recorded reason that is
     * still standing. Consulting all of them is strictly more conservative,
     * which is the direction every rule in this function falls.
     */
    if (causesOf(reader.stale).some((cause) => cause.causedBy === input)) return false;

    const wrote = finishedAtOf(producer);
    const read = finishedAtOf(reader);
    if (Number.isNaN(wrote) || Number.isNaN(read)) return false;
    return wrote <= read;
  };

  const sound = (input: string, reader: TaskRecord): boolean => {
    const writers = producers.get(input);
    if (writers === undefined) return true;
    // `every`, not `find`: see the rule about multiple producers above.
    return writers.every((producer) => provenBy(producer, input, reader));
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
  const producers = producersOf(snapshot);

  return snapshot.tasks
    .filter((task) => task.status === "registered")
    .filter((task) =>
      task.reads.every((input) => {
        const writers = producers.get(input);
        if (writers === undefined) return true; // supplied from outside the swarm
        // Every writer, not one: a table two tasks write is finished when both
        // are, and starting on it while the second is mid-write reads a version
        // that is about to be replaced.
        return writers.every(
          (producer) => producer.status === "complete" || producer.status === "stale",
        );
      }),
    )
    .sort((a, b) => a.urn.localeCompare(b.urn));
}

/** Tasks that cannot start yet, with what each is waiting on. */
export function blocked(snapshot: SwarmSnapshot): { task: TaskRecord; waitingOn: string[] }[] {
  const producers = producersOf(snapshot);

  const result: { task: TaskRecord; waitingOn: string[] }[] = [];
  for (const task of snapshot.tasks) {
    if (task.status !== "registered") continue;
    // Every unfinished writer is named, so a task waiting on two of them says
    // so rather than reporting one and looking nearly ready.
    const waitingOn = task.reads
      .flatMap((input) => producers.get(input) ?? [])
      .filter((producer) => producer.status !== "complete" && producer.status !== "stale")
      .map((producer) => producer.name);
    if (waitingOn.length > 0) result.push({ task, waitingOn });
  }
  return result.sort((a, b) => a.task.urn.localeCompare(b.task.urn));
}
