/**
 * Erasure coverage: which assets somebody has attested the subject is absent
 * from, and — the part that matters — which ones nobody has.
 *
 * The specification this implements is `docs/erasure-coverage.md`, written
 * before this file because two earlier attempts at the rule were unsound and
 * both were caught only after being written down as prose. Every case in that
 * document's table is a named test in `tests/erasure.test.ts`.
 *
 * **What this does not do.** obsel holds no warehouse credentials and never
 * reads warehouse data, so it cannot and does not prove absence. It derives the
 * causal chain deterministically from graph structure, verifies attestations
 * that are each local to one asset at one version, and composes them into a
 * picture no single attestor is positioned to assert. The words "proof" and
 * "proven clean" do not appear in this file's output, deliberately; the
 * vocabulary table in the specification is enforced here.
 *
 * **Pure, and no model calls**, the same rule as `staleness.ts`. Data in, a
 * decision out, no network. A model may route work and explain blockers
 * elsewhere; nothing about what is covered is ever inference.
 *
 * Two things in here look like bugs to anyone who knows `staleness.ts`, and
 * both are deliberate. They are documented at `UNPROVEN` and at
 * `recordedUpstream` respectively, because the next reader will otherwise
 * "fix" them back into unsoundness.
 */

/**
 * A warehouse-native commit identifier: an Iceberg snapshot id, a Delta commit
 * version, a table revision.
 *
 * **Never a content hash.** Two versions with identical bytes are still two
 * versions, and that is what makes the inverted write rule work: an attestation
 * binds to a version, so a rewrite that produced the same bytes has no
 * attestation covering it. `staleness.ts` decides on sha256 pairs and is right
 * to; importing that habit here would let an asset stay green through a write
 * nobody attested to.
 */
export type Version = string;

/**
 * The three answers, and the default is the middle one.
 *
 * `UNPROVEN` is not "probably fine". It is the honest state of an asset nobody
 * has said anything about, and the report leads with the count of them because
 * that list is the thing a data protection officer has never been handed.
 */
export type ErasureState =
  /** A valid attestation covers the whole of this version for this request. */
  | "ATTESTED"
  /** Anything else. No attestation, partial coverage, an unattested input. */
  | "UNPROVEN"
  /** An attestation reports the subject is still present. */
  | "CONTRADICTED";

/**
 * What an attestor was actually asked, recorded because obsel cannot ask it.
 *
 * Everything downstream of resolving a person into concrete key values is
 * unsigned and unverifiable here. If the organization resolves a subject to one
 * `customer_id` while guest-checkout rows sit under an email hash, every
 * attestation that follows is structurally valid and wrong, and their
 * completeness is exactly what makes them persuasive.
 *
 * Recording the question is the only defence available to a system that cannot
 * ask it itself: two attestors answering different questions can at least be
 * detected afterwards. A count of zero from `WHERE customer_id = '88213'`
 * against a column holding `'C-88213'` is otherwise indistinguishable from a
 * correct answer.
 */
export interface Predicate {
  /** The subject key values searched for. */
  identifiers: string[];
  /** The predicate as executed, verbatim. */
  expression: string;
  /** The columns the attestor searched. */
  columns: string[];
}

/**
 * How much of a version one attestation speaks for.
 *
 * `partitions` exists so a partial answer reports as a partial answer. An
 * overwrite of 3 of 730 daily partitions is not a failure to say anything; it
 * is a covered 3 and an uncovered 727, and an operator can act on the second
 * number. Collapsing it to a bare red would throw away the only part of the
 * answer that tells them how much work is left.
 */
export type Scope = { kind: "whole" } | { kind: "partitions"; covered: string[]; total: number };

/** How a run wrote its output, which is the whole of the TOTAL condition. */
export type Materialization =
  /** Rewrote the entirety of the asset. The only one that can explain a version. */
  | "full"
  /** `out = merge(prior_version(out), f(inputs))`. The prior version is an input no catalog records. */
  | "merge"
  /** Added rows and kept the rest. */
  | "append"
  /** Rewrote some partitions and kept the others. */
  | "partition";

interface AttestationBase {
  /** The erasure request this speaks to. State is per request, never per asset. */
  request: string;
  /** Dataset URN, which may be a foreign one obsel did not create. */
  asset: string;
  /** The exact version this speaks for. */
  version: Version;
  /** Who signed it. */
  attestor: string;
  /**
   * Whether the signature over this record's canonical bytes verified.
   *
   * Set by the attestation layer, never by the attestor and never here. The
   * kernel refuses anything where this is false, so until that layer exists
   * nothing reaches `ATTESTED` outside a test — which is the correct behavior
   * for a system whose whole claim rests on the signatures being real. Presence
   * of a signature is not verification of one, and this field is named for what
   * it means rather than for what was supplied.
   */
  signatureVerified: boolean;
  /**
   * Withdrawn because it was invalid when it was made, as opposed to merely
   * superseded by a later version.
   *
   * The two look identical in an append-only ledger and mean opposite things. A
   * SUPERSEDED attestation is still true of the version it named, so work
   * derived from that version stays covered. A RETRACTED one was never true, so
   * everything derived from it must fall. Retracted records are ignored
   * entirely, and because derived coverage requires each input to be `ATTESTED`
   * at a named version, the least fixpoint below recomputes the whole
   * transitive closure as `UNPROVEN` without any special traversal.
   */
  retracted?: boolean;
  /** ISO timestamp the attestation was made. */
  at: string;
}

/** Somebody looked in the asset itself and reported what they found. */
export interface DirectAttestation extends AttestationBase {
  kind: "direct";
  predicate: Predicate;
  scope: Scope;
  /** `present` is what makes an asset `CONTRADICTED`. */
  result: "absent" | "present";
}

/** Somebody rebuilt the asset and declares what went into it. */
export interface RebuildAttestation extends AttestationBase {
  kind: "rebuild";
  materialization: Materialization;
  /**
   * Whether this run alone produced this version.
   *
   * "Was one of the producers of" is not enough. If two runs both contributed
   * rows to the version standing now, then no single run rewrote all of it and
   * the other's rows are unexplained. The two-writer problem falls out of
   * totality rather than needing a rule of its own, provided this is read as
   * SOLELY produced.
   */
  soleProducer: boolean;
  /** The complete input set the attestor declares, each at the version consumed. */
  inputs: { asset: string; version: Version }[];
}

export type Attestation = DirectAttestation | RebuildAttestation;

/** Why some part of a version has nothing explaining it. */
export type ResidueReason =
  | { kind: "no-attestation" }
  | { kind: "not-total"; materialization: Materialization }
  | { kind: "partitions-uncovered"; covered: number; total: number }
  | { kind: "not-sole-producer" }
  | { kind: "no-recorded-lineage" }
  | { kind: "closure-mismatch"; undeclared: string[] }
  | { kind: "unattested-input"; input: string; version: Version }
  | { kind: "predicate-gap"; missing: string[] }
  | { kind: "unverified-signature"; attestor: string }
  | { kind: "attested-other-version"; attestedVersion: Version };

/** What obsel can say about one asset, for one request, at one version. */
export interface Coverage {
  request: string;
  asset: string;
  version: Version;
  state: ErasureState;
  /** Empty exactly when `state` is `ATTESTED`. */
  residue: ResidueReason[];
  /** One sentence naming the cause, in the voice a stale mark's reason uses. */
  explanation: string;
}

/** Everything the kernel needs, and nothing it could reach out for. */
export interface CoverageInput {
  /** The request identifier. */
  request: string;
  /**
   * The subject key values this request covers.
   *
   * A direct attestation counts only if its predicate searched for all of them.
   * An attestor that looked for one of three identifiers answered a narrower
   * question than the one being asked, and the difference is recorded rather
   * than rounded off.
   */
  identifiers: string[];
  /** Current version per asset URN. An asset absent from here is not evaluated. */
  currentVersion: Record<string, Version>;
  /**
   * Upstream dataset URNs DataHub records for each asset, from `GET
   * /relationships`, never the search-backed lineage surface.
   *
   * This is the independent source the CLOSED condition is checked against, and
   * binding to it rather than to a producing `DataJob` is a correction that
   * Phase 0b measurement forced. Under the earlier form, 22 of 23 assets
   * reachable from a real PII-bearing table were permanently uncoverable,
   * because DataHub records dataset-to-dataset lineage richly and rarely
   * records the job: `snowflake analytics.order_details` carries 109 upstream
   * edges resolving to 12 distinct datasets and zero producing jobs. The job
   * was only ever a proxy for "something built this from those inputs", which
   * the edges carry directly.
   */
  recordedUpstream: Record<string, string[]>;
  attestations: Attestation[];
}

function key(asset: string, version: Version): string {
  return `${asset} ${version}`;
}

/** Last dotted segment of a dataset URN, for a sentence a person reads. */
export function assetLabel(urn: string): string {
  const parts = urn.split(",");
  const path = parts.length > 1 ? parts[1] : urn;
  const segments = path.split(".");
  return segments[segments.length - 1].replace(/_/g, " ");
}

/**
 * Coverage for every asset named in `currentVersion`, as a least fixpoint.
 *
 * **Least, not greatest, and this is the whole of case 5.** Start with nothing
 * attested and promote only on evidence. The obvious implementation — a
 * memoised recursive walk with a visited set that returns "attested" on revisit
 * — computes the greatest fixpoint instead, and on a cycle `A → B → A` it
 * concludes that B is covered because A was and A is covered because B was,
 * with no direct check anywhere in the loop. A visited set is this repo's
 * existing termination idiom, which is exactly why the trap is worth naming: on
 * revisit the answer must be the CURRENT value, and the current value starts at
 * `UNPROVEN`.
 *
 * Terminates because each round either promotes at least one asset to
 * `ATTESTED` or changes nothing, and no asset is ever demoted, so there are at
 * most as many rounds as there are assets.
 */
export function coverageFor(input: CoverageInput): Coverage[] {
  const state = new Map<string, ErasureState>();
  const residues = new Map<string, ResidueReason[]>();

  // Usable attestations only: retracted records were never true, so they are
  // dropped here rather than reasoned around anywhere below.
  const usable = input.attestations.filter(
    (record) => record.request === input.request && !record.retracted,
  );

  /*
   * Every asset-version pair the rule needs an answer for, which is more than
   * the versions standing now.
   *
   * A rebuild is covered by the versions it CONSUMED, not by whatever stands
   * upstream today, and those are routinely different: a run reads customers at
   * v1, a backfill commits v2, and the run's work is still built on the version
   * that really was clean. Evaluating only current versions made every such
   * downstream fall, which is the difference between SUPERSEDED and RETRACTED
   * collapsing — the exact distinction the plan requires be kept.
   *
   * It also picks up inputs a rebuild declared that the catalog records no edge
   * for. Declaring one is allowed and is stricter rather than looser, because
   * the declared input must then be attested in its own right; it can only be
   * held to that if it is evaluated.
   */
  const targets = new Map<string, { asset: string; version: Version }>();
  for (const [asset, version] of Object.entries(input.currentVersion)) {
    targets.set(key(asset, version), { asset, version });
  }
  for (const record of usable) {
    if (record.kind !== "rebuild") continue;
    for (const entry of record.inputs) {
      const at = key(entry.asset, entry.version);
      if (!targets.has(at)) targets.set(at, { asset: entry.asset, version: entry.version });
    }
  }
  // Sorted so the answer cannot depend on the order attestations arrived in.
  const ordered = [...targets.values()].sort(
    (a, b) => a.asset.localeCompare(b.asset) || a.version.localeCompare(b.version),
  );

  /*
   * Contradiction first, and it is not subject to the fixpoint: an attestation
   * saying the subject is still present is a finding about the asset itself,
   * and no amount of upstream coverage argues with it. It is also the one state
   * that never needs promoting, so settling it up front keeps the loop below
   * concerned with a single question.
   */
  for (const { asset, version } of ordered) {
    const found = usable.find(
      (record) =>
        record.kind === "direct" &&
        record.asset === asset &&
        record.version === version &&
        record.signatureVerified &&
        record.result === "present",
    );
    if (found) {
      state.set(key(asset, version), "CONTRADICTED");
      residues.set(key(asset, version), []);
    }
  }

  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const { asset, version } of ordered) {
      const at = key(asset, version);
      if (state.get(at) === "ATTESTED" || state.get(at) === "CONTRADICTED") continue;

      const residue = residueFor(input, usable, asset, version, state);
      residues.set(at, residue);
      if (residue.length === 0) {
        state.set(at, "ATTESTED");
        progressed = true;
      }
    }
  }

  /*
   * Only the versions standing now are reported. The historical ones above were
   * evaluated because the rule needs them, but an operator's board is about
   * what is true of the estate today, and listing a superseded version beside
   * its successor would read as two assets rather than one asset's history.
   */
  return Object.keys(input.currentVersion)
    .sort()
    .map((asset) => {
      const version = input.currentVersion[asset];
      const at = key(asset, version);
      const settled = state.get(at) ?? "UNPROVEN";
      const residue =
        settled === "ATTESTED" ? [] : (residues.get(at) ?? [{ kind: "no-attestation" }]);
      return {
        request: input.request,
        asset,
        version,
        state: settled,
        residue,
        explanation: explain(asset, version, settled, residue, usable),
      };
    });
}

/**
 * The portion of this version that nothing explains, as a list of reasons.
 *
 * Empty means covered. Each entry names one specific thing that is missing, so
 * the report can say what would close the gap rather than only that a gap
 * exists — an unattested mark with no traceable cause is not actionable, the
 * same standard every stale mark in this repo is held to.
 *
 * Direct and rebuild explanations are tried in that order and do not compose
 * with each other, deliberately. A partial direct check plus a partial rebuild
 * covering "the rest" would require obsel to know that the two partitions are
 * disjoint and together exhaustive, and it knows neither. Several direct
 * partition attestations DO compose, because partitions are named and a union
 * of named partitions is checkable.
 */
function residueFor(
  input: CoverageInput,
  usable: Attestation[],
  asset: string,
  version: Version,
  state: Map<string, ErasureState>,
): ResidueReason[] {
  const forAsset = usable.filter((record) => record.asset === asset);
  const forVersion = forAsset.filter((record) => record.version === version);

  if (forVersion.length === 0) {
    // An attestation exists, but for a version that is no longer standing. This
    // is the inverted write rule doing its work, and it is worth naming
    // separately: "nobody has looked at this" and "somebody looked, then it was
    // rewritten" are different problems with different next steps.
    const other = forAsset.find((record) => record.version !== version);
    return other
      ? [{ kind: "attested-other-version", attestedVersion: other.version }]
      : [{ kind: "no-attestation" }];
  }

  const direct = residueFromDirect(input, forVersion, version);
  if (direct !== null && direct.length === 0) return [];

  const rebuild = residueFromRebuild(input, forVersion, asset, state);
  if (rebuild !== null && rebuild.length === 0) return [];

  // Both paths were tried; report whichever was attempted. When both were,
  // report both, because either could be the one the owner intends to close.
  const reasons = [...(direct ?? []), ...(rebuild ?? [])];
  return reasons.length > 0 ? reasons : [{ kind: "no-attestation" }];
}

/** Null when no direct attestation was offered at all. */
function residueFromDirect(
  input: CoverageInput,
  forVersion: Attestation[],
  version: Version,
): ResidueReason[] | null {
  const directs = forVersion.filter(
    (record): record is DirectAttestation => record.kind === "direct" && record.result === "absent",
  );
  if (directs.length === 0) return null;

  const reasons: ResidueReason[] = [];

  const unverified = directs.filter((record) => !record.signatureVerified);
  const verified = directs.filter((record) => record.signatureVerified);
  if (verified.length === 0) {
    return unverified.map((record) => ({
      kind: "unverified-signature" as const,
      attestor: record.attestor,
    }));
  }

  /*
   * Every identifier the request covers must have been searched for, and by
   * ONE record — the specification's Direct check names a single attestation
   * `D` satisfying the predicate condition and the scope condition together.
   *
   * **Do not read the two halves off different records.** The union of the
   * identifiers everybody searched for, checked against the scope of whoever
   * happened to claim the whole table, lets a record that looked for one
   * identifier in 1 of 730 partitions borrow the whole-table scope of a record
   * that never looked for that identifier at all. Both conditions then pass and
   * the asset reports as attested absent over ground nobody covered, which is
   * counterexample case 2 arriving through the predicate rather than through
   * the scope.
   */
  const asked = input.identifiers;
  const qualifying = verified.filter((record) => {
    const searched = new Set(record.predicate.identifiers);
    return asked.every((id) => searched.has(id));
  });

  if (qualifying.length === 0) {
    // Nobody answered the whole question. The smallest gap any single attestor
    // left is the shortest route to closing this, so that is the one named;
    // sorted so the sentence cannot depend on the order records arrived in.
    const gaps = verified
      .map((record) => {
        const searched = new Set(record.predicate.identifiers);
        return asked.filter((id) => !searched.has(id)).sort();
      })
      .sort((a, b) => a.length - b.length || a.join().localeCompare(b.join()));
    reasons.push({ kind: "predicate-gap", missing: gaps[0] });
    return reasons;
  }

  const whole = qualifying.some((record) => record.scope.kind === "whole");
  if (!whole) {
    // Named partitions union, because a union of names is checkable — and only
    // across the records that each answered the whole question, for the reason
    // above. The total is taken from the attestations themselves; they
    // disagreeing about it is itself uncovered ground, so the largest claim is
    // used.
    const covered = new Set<string>();
    let total = 0;
    for (const record of qualifying) {
      if (record.scope.kind !== "partitions") continue;
      for (const part of record.scope.covered) covered.add(part);
      total = Math.max(total, record.scope.total);
    }
    if (covered.size < total || total === 0) {
      reasons.push({ kind: "partitions-uncovered", covered: covered.size, total });
    }
  }

  void version;
  return reasons;
}

/** Null when no rebuild attestation was offered at all. */
function residueFromRebuild(
  input: CoverageInput,
  forVersion: Attestation[],
  asset: string,
  state: Map<string, ErasureState>,
): ResidueReason[] | null {
  const rebuilds = forVersion.filter(
    (record): record is RebuildAttestation => record.kind === "rebuild",
  );
  if (rebuilds.length === 0) return null;

  // Each rebuild claim is judged on its own; the asset is covered if any single
  // one of them explains the whole version. Two half-explanations do not add up
  // to one whole one.
  let best: ResidueReason[] | null = null;
  for (const record of rebuilds) {
    const reasons = residueFromOneRebuild(input, record, asset, state);
    if (reasons.length === 0) return [];
    if (best === null || reasons.length < best.length) best = reasons;
  }
  return best ?? [];
}

function residueFromOneRebuild(
  input: CoverageInput,
  record: RebuildAttestation,
  asset: string,
  state: Map<string, ErasureState>,
): ResidueReason[] {
  const reasons: ResidueReason[] = [];

  // ATTRIBUTED.
  if (!record.signatureVerified) {
    reasons.push({ kind: "unverified-signature", attestor: record.attestor });
  }

  // TOTAL. A merge, an append and a partition overwrite each leave a portion of
  // the version standing that this run did not write, and for a merge that
  // portion is the prior version — a real input that no catalog records as an
  // edge, which is what killed the previous draft of this rule.
  if (record.materialization !== "full") {
    reasons.push({ kind: "not-total", materialization: record.materialization });
  }
  if (!record.soleProducer) {
    reasons.push({ kind: "not-sole-producer" });
  }

  /*
   * A SELF-REBUILD: this version was built from exactly one input, an earlier
   * version of this same asset. Compaction, vacuum, optimize — the maintenance a
   * table format performs on itself.
   *
   * **This looks like a hole and is not.** The CLOSED check below exists to stop
   * an attestor narrowing its declared inputs to dodge an unclean upstream. A
   * self-rebuild declares that nothing entered this version except the previous
   * version of the same asset, which is the strongest claim about inputs
   * available, not the weakest. Upstream accounting is inherited rather than
   * skipped: `V_prev` must itself be ATTESTED, recursively, down to a direct
   * check — enforced by the per-input loop below, which needs no exception.
   *
   * What it does skip is the cross-check against `recordedUpstream`, and only
   * because that describes how this asset is normally built FROM OTHER TABLES,
   * which is a claim about a different write than this one. DataHub rarely
   * records a self-edge, so demanding one would refuse every honest compaction
   * on a real catalog and leave an estate under ordinary maintenance permanently
   * unattested. `docs/erasure-coverage.md` walks the six cases.
   *
   * **The predicate is deliberately narrow, and this is the line a future reader
   * will want to move.** Do not. A rebuild declaring the prior version PLUS
   * fresh inputs is an ordinary rebuild and gets the full cross-check, with the
   * self-edge as one more input that must be attested. And `version !== record.version`
   * is what stops an attestation explaining itself: an input naming its own
   * version can only be promoted by evidence requiring it to already be
   * promoted, which the least fixpoint below never does.
   */
  const selfRebuild =
    record.inputs.length === 1 &&
    record.inputs[0].asset === asset &&
    record.inputs[0].version !== record.version;

  if (!selfRebuild) {
    // CLOSED, checked against DataHub's recorded lineage rather than taken on
    // trust. Declaring MORE than the catalog knows is allowed and is in fact
    // stricter, because every declared input must then itself be attested;
    // declaring LESS is a detectable inconsistency and is refused. Without this,
    // an attestor could drop an unclean upstream from its declaration and the
    // universal quantifier below would pass over a set chosen to make it pass.
    const recorded = input.recordedUpstream[asset] ?? [];
    if (recorded.length === 0) {
      // Nothing to cross-check against. A rebuild claim over an asset whose
      // lineage the catalog does not record cannot be verified as closed, and
      // accepting it would be trusting the declaration on its own word.
      reasons.push({ kind: "no-recorded-lineage" });
    } else {
      const declared = new Set(record.inputs.map((entry) => entry.asset));
      const undeclared = recorded.filter((upstream) => !declared.has(upstream)).sort();
      if (undeclared.length > 0) reasons.push({ kind: "closure-mismatch", undeclared });
    }
  }

  // Every declared input must itself be covered, at the version this run
  // consumed — not at whatever version stands now. That distinction is what
  // makes a superseded upstream harmless: a later version of an input does not
  // invalidate work derived from the earlier one, because the earlier one was
  // genuinely covered and this run genuinely read it.
  for (const entry of record.inputs) {
    if (state.get(key(entry.asset, entry.version)) !== "ATTESTED") {
      reasons.push({ kind: "unattested-input", input: entry.asset, version: entry.version });
    }
  }

  return reasons;
}

/** The one sentence the report leads with, for one asset. */
function explain(
  asset: string,
  version: Version,
  state: ErasureState,
  residue: ResidueReason[],
  usable: Attestation[],
): string {
  const table = assetLabel(asset);

  if (state === "CONTRADICTED") {
    const record = usable.find(
      (entry) => entry.asset === asset && entry.kind === "direct" && entry.result === "present",
    );
    return `${record?.attestor ?? "an attestor"} reports the subject is still present in ${table} at version ${version}`;
  }

  if (state === "ATTESTED") {
    const record = usable.find((entry) => entry.asset === asset && entry.version === version);
    return `${table} is attested absent over version ${version} by ${record?.attestor ?? "an attestor"}`;
  }

  const first = residue[0];
  const rest = residue.length > 1 ? `, and ${residue.length - 1} more` : "";
  return `${table} at version ${version} is unattested: ${reasonSentence(first, table)}${rest}`;
}

/**
 * One residue reason as a sentence, exported so the dashboard says it in these
 * words rather than in its own.
 *
 * `explain` above puts only the FIRST reason in the leading sentence and counts
 * the rest, which is right for a one-line summary and leaves a reader who opens
 * the asset with "and 3 more" and no way to see them. The erasure tab lists
 * every reason, and it calls this rather than writing a second vocabulary for
 * the same ten cases. Exporting a formatter changes no decision: `coverageFor`
 * settles what is covered, and this only says why in English.
 */
export function reasonSentence(reason: ResidueReason | undefined, table: string): string {
  if (!reason) return "nothing explains it";
  switch (reason.kind) {
    case "no-attestation":
      return "nobody has attested to it";
    case "attested-other-version":
      return `the attestation covers version ${reason.attestedVersion}, and ${table} has been written since`;
    case "not-total":
      return `the run that wrote it was a ${reason.materialization}, so it left the rest of the table standing`;
    case "partitions-uncovered":
      return `${reason.covered} of ${reason.total} partitions are covered`;
    case "not-sole-producer":
      return "more than one run contributed to this version, so no single one rewrote all of it";
    case "no-recorded-lineage":
      return "DataHub records no upstream lineage for it, so a rebuild claim has nothing to be checked against";
    case "closure-mismatch":
      return `the rebuild did not declare ${reason.undeclared.map(assetLabel).join(", ")}, which DataHub records as feeding it`;
    case "unattested-input":
      /*
       * A self-rebuild names the asset as its own input, and the generic
       * sentence then reads "clean orders was built from clean orders", which
       * looks like a bug in obsel rather than the fact it is. Both callers pass
       * this asset's own label as `table`, so the two cases are distinguishable
       * here without the formatter needing to know about rebuild kinds.
       */
      return assetLabel(reason.input) === table
        ? `it was rewritten from its own version ${reason.version}, which is itself unattested`
        : `it was built from ${assetLabel(reason.input)} at version ${reason.version}, which is itself unattested`;
    case "predicate-gap":
      return `nobody searched for ${reason.missing.join(", ")}`;
    case "unverified-signature":
      return `the attestation from ${reason.attestor} has no verified signature`;
  }
}

/**
 * The number a report leads with: how much of the reachable graph nobody has
 * spoken for.
 *
 * Deliberately not a percentage on its own. "96% covered" invites the reader to
 * round up to done, and the four assets in the remainder are the entire point
 * of the exercise. The counts are returned raw and the caller states them as
 * "N of M covered, K unattested", the phrasing the specification's vocabulary
 * table requires.
 */
export function summarize(coverage: Coverage[]): {
  total: number;
  attested: number;
  unproven: number;
  contradicted: number;
} {
  return {
    total: coverage.length,
    attested: coverage.filter((entry) => entry.state === "ATTESTED").length,
    unproven: coverage.filter((entry) => entry.state === "UNPROVEN").length,
    contradicted: coverage.filter((entry) => entry.state === "CONTRADICTED").length,
  };
}

/**
 * What every report says about its own reach, verbatim and unconditionally.
 *
 * These travel in the report's JSON because the counts beside them are the part
 * a reader quotes onward, and "22 of 23 covered" reads as a statement about an
 * estate unless something says what it was measured over. Both sentences are
 * already committed to in `docs/erasure-coverage.md` under "What the rule does
 * not catch"; this is the same claim, carried where the numbers go rather than
 * in a document the numbers can outrun.
 *
 * Fixed text, never computed from the run. They describe the shape of the
 * method, so a report that varied them would be describing something other than
 * the rule it implements.
 *
 * Here in the kernel rather than in the engine because this is part of what
 * obsel claims, and what obsel claims is decided in this file. It also keeps
 * the sentences importable by the browser and by the browser suite's fixtures
 * without either reaching into a module that holds DataHub credentials.
 *
 * The vocabulary table is enforced on these by `tests/erasure-limits.test.ts`,
 * which is why neither sentence says "proof", "proven" or "complete".
 */
export const ASSURANCE_LIMITS: readonly string[] = [
  "coverage is computed over the lineage DataHub records, as of this walk. An export, " +
    "spreadsheet or pipeline that nobody catalogued is not represented here, and is not counted " +
    "in any number above.",
  "an attestation is a signed claim by a named attestor, not a measurement obsel took. obsel " +
    "holds no warehouse credentials and reads no warehouse data, so it cannot itself establish " +
    "that a subject is absent from any asset.",
];
