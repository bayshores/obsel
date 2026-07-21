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
}

/** One agent's unit of work. */
export interface TaskRecord {
  /** DataJob URN. Stable identity across runs. */
  urn: string;
  /** Short human name, e.g. "build_revenue". */
  name: string;
  /** Dataset URNs this task reads. `Consumes` edges. */
  reads: string[];
  /** Dataset URNs this task writes. `Produces` edges. */
  writes: string[];
  status: TaskStatus;
  /** Fingerprint per output dataset URN, recorded when the task finished. */
  fingerprints: Record<string, OutputFingerprint>;
  /** ISO timestamp of the most recent completion, if it has ever finished. */
  finishedAt: string | null;
  /** Present only when `status` is "stale". */
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
