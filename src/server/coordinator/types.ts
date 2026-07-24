/**
 * The shapes obsel reasons about.
 *
 * All of this lives in DataHub, not in a local database: a task is a `DataJob`,
 * its reads and writes are `Consumes`/`Produces` lineage edges, and everything
 * below that is not an edge is carried in the DataJob's `customProperties`.
 * See `src/server/datahub/` for the mapping.
 */

/**
 * A record of what a task produced, taken when it finished.
 *
 * Split in two on purpose. A column rename changes `schema` but can leave
 * `content` identical, and a nightly refresh changes `content` while `schema`
 * stays put. Reporting which one moved is the difference between "something
 * changed" and an explanation someone can act on.
 */
export interface OutputFingerprint {
  /** sha256 over the sorted column names. Catches renames, additions, removals. */
  schema: string;
  /** sha256 over the rows. Catches value changes under a stable schema. */
  content: string;
}

export type ChangeKind = "schema" | "content" | "both";

/**
 * What one input table looked like when the reporting task read it.
 *
 * The same two hashes as an `OutputFingerprint`, computed by the reader over
 * the bytes it actually consumed. This is the writer-independent half of
 * detection: a process that rewrites a table and never tells obsel cannot be
 * caught through its own fingerprints, because it never sent any — but the next
 * honest reader of that table carries evidence of what the table holds now, and
 * comparing that against what the producer recorded exposes the unreported
 * change. `columns` rides along when the reader knew them, so a mismatch can
 * name what moved instead of showing two hashes.
 */
export interface InputObservation {
  /** sha256 over the sorted column names, as read. */
  schema: string;
  /** sha256 over the rows, as read. */
  content: string;
  /** Column names as read, when the observer knew them. Display only. */
  columns?: string[];
}

/**
 * Which columns left and which arrived, when a schema moved.
 *
 * This is a *description* of a change, never the detection of one. Staleness is
 * decided by `compareFingerprints` on the sha256 pair above and by nothing else;
 * this exists because `changeKind: "schema"` is unreadable to a person, while
 * "`order_total` left, `order_total_usd` arrived" explains obsel's entire point
 * at a glance. Both lists are derived from `OutputShape.columns`, which obsel
 * already records under `obsel.run.outputs`, so no new evidence is collected.
 *
 * Deliberately NOT called a rename. A column leaving and another arriving is
 * indistinguishable from a drop plus an unrelated addition, and obsel reports
 * what it observed rather than the intent it would take to guess. Rendered as a
 * diff, which lets the reader draw the obvious conclusion without obsel
 * asserting it.
 */
export interface ColumnChange {
  /** Present after, absent before. Sorted. */
  added: string[];
  /** Present before, absent after. Sorted. */
  removed: string[];
}

/** What one output table turned out to be, as the agent that wrote it counted it. */
export interface OutputShape {
  rows: number;
  /** Column names in the order the agent wrote them. */
  columns: string[];
  /**
   * Where the file lives, as the writing agent reported it. Display only, and
   * machine-specific by nature — a path from one machine means nothing on
   * another, which is why it is optional and never part of any decision. It
   * exists so the board can point at the actual file instead of asking a
   * viewer to take "table" on faith.
   */
  path?: string;
}

/**
 * What actually happened during a run, reported by the agent that did it.
 *
 * Separate from `fingerprints` on purpose. A fingerprint is what obsel *decides*
 * on; this is what a person needs in order to believe the decision — which
 * runner did the work, how long it took, and what came out. obsel never reasons
 * about any of it.
 *
 * `ms` is the agent's own measurement of its own run, taken in one process.
 * The cockpit reports it verbatim rather than subtracting `finishedAt` from
 * `startedAt`: those two are stamped on different clocks, which is the mistake
 * `timing.ts` already documents having made once.
 */
export interface RunDetail {
  /** What did the work, with its version, e.g. `codex-cli 0.144.4`. */
  runner: string;
  /** Milliseconds the runner took, measured by the agent in a single process. */
  ms: number;
  /** Shape of each output dataset URN this run produced. */
  outputs: Record<string, OutputShape>;
}

export type TaskStatus =
  /** Declared what it will touch, not started. */
  | "registered"
  /** Working. Its outputs are not final, so nothing downstream can be judged yet. */
  | "running"
  /** Finished, and everything it was built on is still true. */
  | "complete"
  /** Finished, but something it read has changed since. */
  | "stale";

/** Why a finished task is no longer trustworthy. */
export interface StaleMark {
  /** The dataset whose change started this, e.g. the renamed table. */
  causedBy: string;
  /** The task that produced `causedBy`, when one is known. */
  causedByTask: string | null;
  /** Distance from the change. 1 means this task read the changed data itself. */
  hops: number;
  /** Which part of the upstream output moved. */
  changeKind: ChangeKind;
  /**
   * Which columns moved, when `changeKind` involved the schema and both column
   * lists were known.
   *
   * Optional in both directions: absent on a content-only change, and absent on
   * every mark written before obsel recorded this, so an older mark still reads
   * correctly rather than rendering an empty diff. Never consulted when deciding
   * anything; it exists so the board can name the change instead of showing a
   * hash of it.
   */
  columns?: ColumnChange | null;
  /** Plain-English sentence for the dashboard and the DataHub property. */
  reason: string;
  /** ISO timestamp of when the mark was applied. */
  since: string;
  /**
   * Measured milliseconds from the upstream agent's completion report arriving to
   * every mark from it being written and confirmed in DataHub.
   *
   * Recorded on the mark rather than derived by subtracting timestamps in the UI.
   * Those timestamps are stamped in different processes and bracket neither end of
   * the real work, and their difference goes negative as soon as the upstream task
   * runs again — which silently deletes the number at the worst possible moment.
   *
   * Null on a mark written before this was recorded.
   */
  detectedMs: number | null;
}

/** One agent's unit of work. */
export interface TaskRecord {
  /** DataJob URN. Stable identity across runs. */
  urn: string;
  /** Code identifier, e.g. "build_revenue". The URN is built from it. */
  name: string;
  /**
   * The task's short human name, e.g. "Daily revenue" for `build_revenue`.
   *
   * Separate from `name` because that one is a code identifier the URN, every
   * test and every traversal depend on, and renaming it would repoint the
   * entity. This is what the board leads with; `name` stays visible beside it,
   * because these being real DataHub entities is half the point.
   *
   * Optional as well as nullable for the same reason as `description`: captures
   * taken before the field existed lack the key entirely. Consumers fall back to
   * a humanised `name`.
   */
  title?: string | null;
  /**
   * The task's standing job in one sentence, registered into the DataJob's own
   * description field — so DataHub's UI and obsel's board show the same words.
   *
   * Optional as well as nullable, deliberately: artifacts captured before this
   * field existed lack the key entirely and remain valid records of what was
   * read at the time. Null when a task registered without one.
   */
  description?: string | null;
  /** Dataset URNs this task reads. `Consumes` edges. */
  reads: string[];
  /** Dataset URNs this task writes. `Produces` edges. */
  writes: string[];
  status: TaskStatus;
  /** Fingerprint per output dataset URN, recorded when the task finished. */
  fingerprints: Record<string, OutputFingerprint>;
  /** ISO timestamp of the most recent completion, if it has ever finished. */
  finishedAt: string | null;
  /**
   * ISO timestamp of when obsel moved this task to `running`, stamped by obsel.
   *
   * Deliberately obsel's own clock rather than the agent's. It exists so the
   * cockpit can say how long work in flight has been in flight, and it is
   * subtracted from `SwarmSnapshot.at` — which the same process stamps on the
   * same clock, so the difference is a real interval and not two machines
   * disagreeing about what time it is.
   *
   * Null on a task that has never started, and left in place after completion so
   * a finished run still shows when it began.
   */
  startedAt: string | null;
  /**
   * What the last completed run reported about itself, when it reported anything.
   *
   * Null for a task that has never finished, and for one finished by an agent
   * that sent no detail — obsel shows nothing rather than a zero in that case.
   */
  run: RunDetail | null;
  /**
   * An unresolved stale mark, when the task carries one.
   *
   * Usually paired with `status: "stale"`, but deliberately outlives that: a
   * stale task being re-run to fix it sits at `running` with its mark still
   * attached, because the mark is only earned back by a run that succeeds. That
   * is what lets completion know there is a DataHub tag to take off.
   */
  stale: StaleMark | null;
  /**
   * Every tag DataHub reports on this job right now, sorted.
   *
   * **Never an input to any decision.** `compareFingerprints` decides staleness, on
   * sha256 and nothing else; this is read back purely so the board can show that
   * obsel's write landed rather than assert it. It exists because the one thing
   * obsel contributes to DataHub that a human can see is a tag, and until now
   * obsel's own board could not report whether that tag was actually there.
   *
   * Rendered in full in the details panel, which doubles as evidence that obsel's
   * writes are additive: a human-authored tag appears beside `obsel-stale` rather
   * than being replaced by it.
   *
   * Optional as well as nullable, for the same reason as `title` and
   * `description`: artifacts captured before this field existed lack the key
   * entirely and remain valid records of what was read at the time.
   */
  tags?: string[];
  /**
   * The latest reader-observed fingerprint of a dataset this task writes, kept
   * only while it disagrees with `fingerprints`.
   *
   * Written by the engine when a completing task reports having read a version
   * of this task's output that was never recorded — the unreported change. It
   * exists so the SECOND reader of the same changed bytes compares against what
   * has already been noticed and marks nothing again; without it, every later
   * reader would re-flag the same cascade with a fresh timestamp. Cleared for a
   * dataset the moment this task completes and reports it, because a fresh
   * completion is a fresh record of what the output really is.
   *
   * Optional as well as omitted-when-empty, like `tags`: records captured
   * before this existed lack the key and stay valid.
   */
  observed?: Record<string, OutputFingerprint>;
  /**
   * Whether `urn:li:tag:obsel-stale` is among `tags`.
   *
   * Derived here rather than in the browser on purpose. Browser code must never
   * import from `src/server/`, so a client-side check would need its own copy of
   * the tag URN — a second spelling of the one string that DataHub, the MCP writer
   * and the reset path all key on. If the two ever drifted, the board would
   * silently count fewer confirmed writes than there were, which is precisely the
   * quiet under-reporting this field exists to catch. One boolean is cheaper than
   * that risk.
   *
   * Deliberately independent of `stale`. The two disagreeing is a real state worth
   * seeing, not an impossible one: obsel writes the mark before the tag, so during
   * the asynchronous write window a marked task legitimately has no tag yet, and a
   * tag surviving with no mark is the reset-by-hand fault the demo
   * warns about.
   */
  staleTagged?: boolean;
}

/** Everything obsel knows about one swarm, as read out of DataHub. */
export interface SwarmSnapshot {
  /** DataFlow URN the tasks belong to. */
  flow: string;
  tasks: TaskRecord[];
  /** ISO timestamp this snapshot was taken. */
  at: string;
}

/**
 * What kind of work one traced step was. Drives nothing but the colour it is
 * shown in.
 */
export type TracePhase =
  /** Reading state out of DataHub. */
  | "read"
  /** Comparing an output against the fingerprint recorded last time. */
  | "compare"
  /** Walking the lineage graph to find what was built on a change. */
  | "walk"
  /** Writing a stale mark and its tag back into DataHub. */
  | "mark"
  /** Any other write: a registration, a status change, a reset. */
  | "write"
  /** The end of one piece of coordination, with its measured duration. */
  | "done";

/**
 * One step the coordinator actually took, in plain language.
 *
 * This exists because obsel's most interesting work is invisible: an agent
 * posts a completion, and somewhere inside that one request obsel reads the
 * graph, compares two hashes, walks the lineage, and writes marks back — and
 * all a viewer ever saw was the result appearing. The board now narrates it.
 *
 * **Narration, never a decision.** Nothing reads these events back; removing
 * every emit would change no outcome. Each one states what the code just did,
 * with the values it did it with, so a step here can never claim more than
 * happened.
 */
export interface TraceEvent {
  /** Monotonic within a server process. Orders events that share a timestamp. */
  seq: number;
  /** ISO timestamp, stamped by the coordinator on its own clock. */
  at: string;
  phase: TracePhase;
  /** What obsel did, as a sentence. */
  message: string;
  /** What came of it — a comparison verdict, a count, a duration. */
  outcome: string | null;
}

/** A task the coordinator decided is stale, before the mark is written. */
export interface AffectedTask {
  task: TaskRecord;
  mark: StaleMark;
}

/** What a completing agent reports back. */
export interface CompletionReport {
  taskUrn: string;
  /** Fingerprint per output dataset URN. */
  fingerprints: Record<string, OutputFingerprint>;
  finishedAt: string;
  /**
   * What the run was like, for the cockpit. Optional, and nothing obsel decides
   * on: an agent that omits it still gets a correct staleness answer.
   */
  run?: RunDetail;
  /**
   * Fingerprint per input dataset URN, as the reporting task read it.
   *
   * Optional and purely additive: an agent that omits it gets exactly the old
   * behaviour. When present, each observation is compared against what that
   * dataset's producer recorded writing. A mismatch means the table changed and
   * nothing reported the change — the case an honest report from the writer
   * would have caught, caught instead by the next honest read.
   */
  inputs?: Record<string, InputObservation>;
}

/** The outcome of one completion, for the dashboard and for `examples/`. */
export interface CoordinationResult {
  /** The task that just finished. */
  taskUrn: string;
  /** Outputs whose fingerprint differs from the previous run, with what moved. */
  changedOutputs: { dataset: string; kind: ChangeKind }[];
  /**
   * Inputs whose observed fingerprint contradicted the recorded one — tables
   * changed by something that never reported. Empty when every read matched,
   * and for reports that carried no input observations at all.
   */
  observedChanges: { dataset: string; kind: ChangeKind }[];
  /** Finished work invalidated by those changes. Empty when nothing moved. */
  affected: AffectedTask[];
  /** Wall-clock milliseconds from receiving the report to having the answer. */
  elapsedMs: number;
}
