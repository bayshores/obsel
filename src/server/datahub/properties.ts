/**
 * The `customProperties` keys obsel owns on a DataJob, under an `obsel.` prefix.
 *
 * There is no local database: everything obsel knows about a task beyond its
 * lineage edges is carried here. Everything else on the aspect is left alone.
 */
export const PROP = {
  status: "obsel.status",
  /**
   * The task's short human name, e.g. "Orders cleaner" for `clean_orders`.
   *
   * A property rather than the DataJob's `name`, which is the code identifier the
   * URN is built from and which every assertion, test and traversal keys on.
   * Display only: nothing obsel decides reads this.
   */
  title: "obsel.title",
  finishedAt: "obsel.finishedAt",
  startedAt: "obsel.startedAt",
  fingerprints: "obsel.fingerprints",
  /**
   * The fingerprint each output held before the current one, kept when a
   * completion replaces it. One slot per dataset, written by the engine and
   * read by `classifyObservation`, which uses it to tell a reader that
   * straddled a re-report apart from a silent edit in a concurrent swarm.
   */
  previousFingerprints: "obsel.fingerprints.previous",
  /**
   * Reader-observed fingerprints of this task's outputs, kept only while they
   * disagree with `fingerprints`. Written when a completing task reports having
   * read a version of this output that was never recorded — the unreported
   * change — so the next reader of the same bytes compares clean instead of
   * re-flagging the cascade. Cleared when this task completes, and by reset.
   */
  observed: "obsel.observed",
  runRunner: "obsel.run.runner",
  runMs: "obsel.run.ms",
  runOutputs: "obsel.run.outputs",
  staleCausedBy: "obsel.stale.causedBy",
  staleCausedByTask: "obsel.stale.causedByTask",
  staleHops: "obsel.stale.hops",
  staleChangeKind: "obsel.stale.changeKind",
  /**
   * Which columns moved, as `{"added":[…],"removed":[…]}`.
   *
   * Describes the change `staleChangeKind` names, so the page can show
   * `order_total` leaving and `order_total_usd` arriving instead of a sha256.
   * Display only, like `title`: nothing obsel decides reads it, and staleness is
   * settled by `fingerprints` alone. Absent on a content-only change and on every
   * mark written before obsel recorded it.
   */
  staleColumns: "obsel.stale.columns",
  staleReason: "obsel.stale.reason",
  staleSince: "obsel.stale.since",
  staleDetectedMs: "obsel.stale.detectedMs",
  /**
   * Every cause, as JSON, including the one the properties above repeat.
   *
   * Separate from the fields beside it rather than replacing them: those are
   * what DataHub's own UI shows and what every existing reader parses, and the
   * nearest cause is the right thing to lead with. This is the rest of the
   * record, so a repaired cause does not leave a flag standing with no
   * explanation on file.
   */
  staleCauses: "obsel.stale.causes",
} as const;

/** `null` clears a key. Undefined keys are left untouched. */
export type PropertyPatch = Record<string, string | null>;
