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

/** What one output table turned out to be, as the agent that wrote it counted it. */
export interface OutputShape {
  rows: number;
  /** Column names in the order the agent wrote them. */
  columns: string[];
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
  /** Short human name, e.g. "build_revenue". */
  name: string;
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
}

/** Everything obsel knows about one swarm, as read out of DataHub. */
export interface SwarmSnapshot {
  /** DataFlow URN the tasks belong to. */
  flow: string;
  tasks: TaskRecord[];
  /** ISO timestamp this snapshot was taken. */
  at: string;
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
}

/** The outcome of one completion, for the dashboard and for `examples/`. */
export interface CoordinationResult {
  /** The task that just finished. */
  taskUrn: string;
  /** Outputs whose fingerprint differs from the previous run, with what moved. */
  changedOutputs: { dataset: string; kind: ChangeKind }[];
  /** Finished work invalidated by those changes. Empty when nothing moved. */
  affected: AffectedTask[];
  /** Wall-clock milliseconds from receiving the report to having the answer. */
  elapsedMs: number;
}
