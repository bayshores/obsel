/**
 * The counterexample table from `docs/erasure-coverage.md`, as tests.
 *
 * Two earlier drafts of this rule were unsound, and both were written as prose
 * that read convincingly before anybody tried to break it. So the table was
 * walked by hand before the kernel existed, and every row of it is a named test
 * here. A row that stops passing is a row of the specification that stopped
 * being true.
 *
 * The dangerous wrong answer in this file is `ATTESTED`. Telling a regulator
 * that a person's data is gone from an asset it is still in is worse than any
 * amount of over-reporting, so the refusals lead and there are more of them.
 */

import { describe, expect, it } from "vitest";

import { coverageFor, summarize } from "@/src/server/coordinator/erasure";
import type {
  Coverage,
  CoverageInput,
  DirectAttestation,
  RebuildAttestation,
} from "@/src/server/coordinator/erasure";

const REQUEST = "dsr-2026-0417";
const SUBJECT = ["cust_88213"];

/** A real foreign URN shape, because this kernel exists to reason about those. */
function ds(platform: string, path: string): string {
  return `urn:li:dataset:(urn:li:dataPlatform:${platform},${path},PROD)`;
}

const CUSTOMERS = ds("snowflake", "order_entry.customers");
const ORDERS = ds("snowflake", "order_entry.orders");
const DETAILS = ds("snowflake", "analytics.order_details");
const DASHBOARD = ds("looker", "analytics.revenue_by_region");

function direct(over: Partial<DirectAttestation> = {}): DirectAttestation {
  return {
    kind: "direct",
    request: REQUEST,
    asset: CUSTOMERS,
    version: "v1",
    predicate: {
      identifiers: SUBJECT,
      expression: "customer_id = 'cust_88213'",
      columns: ["customer_id"],
    },
    scope: { kind: "whole" },
    result: "absent",
    attestor: "warehouse-adapter@acme",
    signatureVerified: true,
    at: "2026-07-26T09:00:00.000Z",
    ...over,
  };
}

function rebuild(over: Partial<RebuildAttestation> = {}): RebuildAttestation {
  return {
    kind: "rebuild",
    request: REQUEST,
    asset: DETAILS,
    version: "v1",
    materialization: "full",
    soleProducer: true,
    inputs: [{ asset: CUSTOMERS, version: "v1" }],
    attestor: "dbt-runner@acme",
    signatureVerified: true,
    at: "2026-07-26T09:05:00.000Z",
    ...over,
  };
}

function input(over: Partial<CoverageInput> = {}): CoverageInput {
  return {
    request: REQUEST,
    identifiers: SUBJECT,
    currentVersion: { [CUSTOMERS]: "v1", [DETAILS]: "v1" },
    recordedUpstream: { [CUSTOMERS]: [], [DETAILS]: [CUSTOMERS] },
    attestations: [],
    ...over,
  };
}

function stateOf(coverage: Coverage[], asset: string): string {
  const found = coverage.find((entry) => entry.asset === asset);
  expect(found, `no coverage returned for ${asset}`).toBeDefined();
  return found?.state ?? "MISSING";
}

function residueKinds(coverage: Coverage[], asset: string): string[] {
  const found = coverage.find((entry) => entry.asset === asset);
  return (found?.residue ?? []).map((reason) => reason.kind).sort();
}

describe("the counterexample table, walked", () => {
  it("1. a MERGE over the prior version explains nothing, however honest the run", () => {
    /*
     * The case that killed draft 2. The real transformation is
     * `out = merge(prior_version(out), f(inputs))`, so the prior version is an
     * input carrying the subject that no catalog records as an edge. Every
     * declared input can be spotless and the output still holds the rows.
     */
    const coverage = coverageFor(
      input({
        attestations: [direct(), rebuild({ materialization: "merge" })],
      }),
    );

    expect(stateOf(coverage, CUSTOMERS)).toBe("ATTESTED");
    expect(stateOf(coverage, DETAILS)).toBe("UNPROVEN");
    expect(residueKinds(coverage, DETAILS)).toContain("not-total");
  });

  it("2. a partition overwrite reports 3 of 730 covered rather than a bare red", () => {
    // Graded output falls out of residue for free, and the second number is the
    // one an operator can act on.
    const partitions = Array.from({ length: 3 }, (_, i) => `2026-07-${20 + i}`);
    const coverage = coverageFor(
      input({
        attestations: [direct({ scope: { kind: "partitions", covered: partitions, total: 730 } })],
      }),
    );

    expect(stateOf(coverage, CUSTOMERS)).toBe("UNPROVEN");
    const found = coverage.find((entry) => entry.asset === CUSTOMERS);
    expect(found?.residue).toContainEqual({
      kind: "partitions-uncovered",
      covered: 3,
      total: 730,
    });
    expect(found?.explanation).toContain("3 of 730 partitions are covered");
  });

  it("3. an SCD2 snapshot stays unattested, because retaining history is it working correctly", () => {
    // Out of scope by design, and named in the report rather than quietly
    // mishandled: this asset needs crypto-shredding or physical deletion, and
    // no rebuild will ever make it absent.
    const coverage = coverageFor(
      input({ attestations: [direct(), rebuild({ materialization: "append" })] }),
    );

    expect(stateOf(coverage, DETAILS)).toBe("UNPROVEN");
    expect(residueKinds(coverage, DETAILS)).toContain("not-total");
  });

  it("4. an asset nobody has said anything about is unattested, not clean", () => {
    /*
     * The default flip. `staleness.ts` returns true for an input with no known
     * producer, correctly, because with no recorded claim there is nothing to
     * contradict. Here the same default would convert absence of information
     * into an affirmative certificate.
     */
    const coverage = coverageFor(input());

    expect(stateOf(coverage, CUSTOMERS)).toBe("UNPROVEN");
    expect(stateOf(coverage, DETAILS)).toBe("UNPROVEN");
    expect(residueKinds(coverage, CUSTOMERS)).toEqual(["no-attestation"]);
  });

  it("4b. a rebuild over an asset with no recorded lineage is refused, not trusted", () => {
    /*
     * The measurement that killed draft 2's second half. A universal quantifier
     * over an empty input set is vacuously true, so the rule certified a table
     * having examined nothing. Here there is nothing to cross-check the
     * declaration against, so the claim is refused.
     */
    const coverage = coverageFor(
      input({
        recordedUpstream: { [CUSTOMERS]: [], [DETAILS]: [] },
        attestations: [direct(), rebuild({ inputs: [] })],
      }),
    );

    expect(stateOf(coverage, DETAILS)).toBe("UNPROVEN");
    expect(residueKinds(coverage, DETAILS)).toContain("no-recorded-lineage");
  });

  it("5. a lineage cycle never talks itself into being covered", () => {
    /*
     * Under a greatest fixpoint, B is covered because A was and A is covered
     * because B was, with no direct check anywhere in the loop. A memoised walk
     * with a visited set returning "attested" on revisit computes exactly that,
     * and a visited set is this repo's existing termination idiom, which is why
     * the trap is worth a test rather than a comment.
     */
    const a = ds("snowflake", "cycle.a");
    const b = ds("snowflake", "cycle.b");
    const coverage = coverageFor(
      input({
        currentVersion: { [a]: "v1", [b]: "v1" },
        recordedUpstream: { [a]: [b], [b]: [a] },
        attestations: [
          rebuild({ asset: a, inputs: [{ asset: b, version: "v1" }] }),
          rebuild({ asset: b, inputs: [{ asset: a, version: "v1" }] }),
        ],
      }),
    );

    expect(stateOf(coverage, a)).toBe("UNPROVEN");
    expect(stateOf(coverage, b)).toBe("UNPROVEN");
    // And it terminated, which is the other half of the requirement.
  });

  it("6. two writers of one version means no single run rewrote all of it", () => {
    // The two-writer problem falls out of totality, provided "produced the
    // current version" is read as SOLELY produced. If the other run's rows are
    // in this version, they are unexplained.
    const coverage = coverageFor(
      input({ attestations: [direct(), rebuild({ soleProducer: false })] }),
    );

    expect(stateOf(coverage, DETAILS)).toBe("UNPROVEN");
    expect(residueKinds(coverage, DETAILS)).toContain("not-sole-producer");
  });

  it("7. a later write reopens an attested asset even when the bytes are identical", () => {
    /*
     * The inverted write rule, and the one place this kernel deliberately
     * contradicts `CLAUDE.md`'s first correctness rule. `compareFingerprints`
     * returns null on identical content so a re-run marks nothing stale, which
     * is right for staleness and catastrophic here: an attestation binds to a
     * version, and a new version has no attestation regardless of its bytes.
     */
    const attested = coverageFor(input({ attestations: [direct()] }));
    expect(stateOf(attested, CUSTOMERS)).toBe("ATTESTED");

    const rewritten = coverageFor(
      input({
        // Same bytes, new commit. Version identity is not fingerprint identity.
        currentVersion: { [CUSTOMERS]: "v2", [DETAILS]: "v1" },
        attestations: [direct()],
      }),
    );

    expect(stateOf(rewritten, CUSTOMERS)).toBe("UNPROVEN");
    const found = rewritten.find((entry) => entry.asset === CUSTOMERS);
    expect(found?.residue).toContainEqual({
      kind: "attested-other-version",
      attestedVersion: "v1",
    });
    // And it says which problem this is: somebody looked and then it moved, not
    // nobody ever looked.
    expect(found?.explanation).toContain("has been written since");
  });

  it("8. a total, closed, attributed rebuild over attested inputs is attested", () => {
    const coverage = coverageFor(input({ attestations: [direct(), rebuild()] }));

    expect(stateOf(coverage, CUSTOMERS)).toBe("ATTESTED");
    expect(stateOf(coverage, DETAILS)).toBe("ATTESTED");
    expect(coverage.find((entry) => entry.asset === DETAILS)?.residue).toEqual([]);
  });

  it("9. a direct check against the standing version is attested", () => {
    const coverage = coverageFor(input({ attestations: [direct()] }));

    const found = coverage.find((entry) => entry.asset === CUSTOMERS);
    expect(found?.state).toBe("ATTESTED");
    // The vocabulary the specification requires, enforced in the output itself.
    expect(found?.explanation).toContain("attested absent over version v1");
    expect(found?.explanation).not.toContain("proven");
    expect(found?.explanation).not.toContain("clean");
  });

  it("10. an attestation reporting the subject present contradicts, and nothing argues with it", () => {
    const coverage = coverageFor(
      input({
        attestations: [
          direct({ result: "present" }),
          // A rebuild claim over the same asset must not talk it back to green.
          rebuild({ asset: CUSTOMERS, inputs: [] }),
        ],
      }),
    );

    expect(stateOf(coverage, CUSTOMERS)).toBe("CONTRADICTED");
    expect(coverage.find((entry) => entry.asset === CUSTOMERS)?.explanation).toContain(
      "still present",
    );
  });
});

describe("the cases the table does not list", () => {
  it("holds an asset whose upstream was covered at a version it never read", () => {
    /*
     * Snapshot isolation, worked through in the specification. An adapter opens
     * a session at 02:58 and pins snapshot v1 for its lifetime, counts zero,
     * and signs `version = v1`. A backfill commits v2 at 03:00 reintroducing
     * twelve rows. The attestation for v1 stands and is correct; v1 really was
     * clean. But the standing version is v2 and nothing explains it.
     *
     * Version-keyed state gets this right with no special case, which is the
     * reason state is keyed to a version rather than to an asset.
     */
    const coverage = coverageFor(
      input({
        currentVersion: { [CUSTOMERS]: "v2", [DETAILS]: "v1" },
        attestations: [direct({ version: "v1" }), rebuild()],
      }),
    );

    expect(stateOf(coverage, CUSTOMERS)).toBe("UNPROVEN");
    const found = coverage.find((entry) => entry.asset === CUSTOMERS);
    expect(found?.residue).toContainEqual({
      kind: "attested-other-version",
      attestedVersion: "v1",
    });

    /*
     * The derived asset does NOT fall, and that is the point rather than a
     * leak. Details v1 was rebuilt in full from customers v1, which really was
     * clean, and a later commit to customers cannot put rows into a version of
     * details that was fixed before it. What the backfill created is a fresh
     * obligation on customers v2, which is open above, and on anything built
     * from it — which is the next test.
     */
    expect(stateOf(coverage, DETAILS)).toBe("ATTESTED");
  });

  it("falls when the rebuild consumed the version the backfill created", () => {
    // Same board, one difference: the run read v2, which nobody has attested.
    const coverage = coverageFor(
      input({
        currentVersion: { [CUSTOMERS]: "v2", [DETAILS]: "v1" },
        attestations: [
          direct({ version: "v1" }),
          rebuild({ inputs: [{ asset: CUSTOMERS, version: "v2" }] }),
        ],
      }),
    );

    expect(stateOf(coverage, DETAILS)).toBe("UNPROVEN");
    expect(residueKinds(coverage, DETAILS)).toContain("unattested-input");
  });

  it("keeps a downstream covered when its upstream is merely superseded", () => {
    /*
     * The other side of the same coin, and the distinction the plan requires be
     * written down: SUPERSEDED is not RETRACTED. The rebuild consumed
     * customers at v1 and v1 was attested. Customers has since moved to v2,
     * which is unattested. That does not reach back and invalidate work
     * genuinely derived from v1.
     */
    const coverage = coverageFor(
      input({
        currentVersion: { [CUSTOMERS]: "v2", [DETAILS]: "v1" },
        attestations: [
          direct({ version: "v1" }),
          direct({ version: "v2", result: "present" }),
          rebuild({ inputs: [{ asset: CUSTOMERS, version: "v1" }] }),
        ],
      }),
    );

    expect(stateOf(coverage, CUSTOMERS)).toBe("CONTRADICTED");
    // Wait for it: the DERIVED asset is still covered, because it was built
    // from the version that really was clean. This is the case that would be
    // wrong under a rule keyed to assets rather than to versions.
    expect(stateOf(coverage, DETAILS)).toBe("ATTESTED");
  });

  it("drops the transitive closure when an attestation is retracted", () => {
    // RETRACTED means it was never true, so everything derived from it falls.
    // No special traversal: the least fixpoint recomputes it.
    const coverage = coverageFor(input({ attestations: [direct({ retracted: true }), rebuild()] }));

    expect(stateOf(coverage, CUSTOMERS)).toBe("UNPROVEN");
    expect(stateOf(coverage, DETAILS)).toBe("UNPROVEN");
    expect(residueKinds(coverage, DETAILS)).toContain("unattested-input");
  });

  it("refuses a rebuild that left out an upstream DataHub records", () => {
    /*
     * The cross-check that makes this stronger than draft 2 rather than weaker.
     * Draft 2 took the input set from whatever the catalog happened to record
     * and quantified over it, so an attestor could not under-declare because it
     * did not declare at all. Here the declaration is the attestor's, and it is
     * verified against an independent source, so dropping an unclean upstream
     * to make the quantifier pass is detectable.
     */
    const coverage = coverageFor(
      input({
        recordedUpstream: { [CUSTOMERS]: [], [DETAILS]: [CUSTOMERS, ORDERS] },
        attestations: [direct(), rebuild({ inputs: [{ asset: CUSTOMERS, version: "v1" }] })],
      }),
    );

    expect(stateOf(coverage, DETAILS)).toBe("UNPROVEN");
    const found = coverage.find((entry) => entry.asset === DETAILS);
    expect(found?.residue).toContainEqual({ kind: "closure-mismatch", undeclared: [ORDERS] });
    expect(found?.explanation).toContain("orders");
  });

  it("allows a rebuild to declare more than the catalog knows, and holds it to all of it", () => {
    // Declaring an input DataHub has no edge for is honest and is stricter, not
    // looser: that input must itself be attested.
    const withExtra = coverageFor(
      input({
        attestations: [
          direct(),
          rebuild({
            inputs: [
              { asset: CUSTOMERS, version: "v1" },
              { asset: ORDERS, version: "v1" },
            ],
          }),
        ],
      }),
    );
    expect(stateOf(withExtra, DETAILS)).toBe("UNPROVEN");
    expect(residueKinds(withExtra, DETAILS)).toContain("unattested-input");

    const bothAttested = coverageFor(
      input({
        attestations: [
          direct(),
          direct({ asset: ORDERS }),
          rebuild({
            inputs: [
              { asset: CUSTOMERS, version: "v1" },
              { asset: ORDERS, version: "v1" },
            ],
          }),
        ],
      }),
    );
    expect(stateOf(bothAttested, DETAILS)).toBe("ATTESTED");
  });

  it("refuses an attestation whose signature was not verified", () => {
    /*
     * The kernel refuses rather than assumes, so until the attestation layer
     * exists nothing reaches ATTESTED outside a test. That is the correct
     * behaviour for a system whose entire claim rests on the signatures being
     * real: presence of a signature is not verification of one.
     */
    const coverage = coverageFor(input({ attestations: [direct({ signatureVerified: false })] }));

    expect(stateOf(coverage, CUSTOMERS)).toBe("UNPROVEN");
    expect(residueKinds(coverage, CUSTOMERS)).toContain("unverified-signature");
  });

  it("refuses an unsigned rebuild claim too, not only an unsigned direct check", () => {
    /*
     * Added because a mutation survived. Deleting the signature check from the
     * rebuild path passed all twenty-four tests: the case above only ever
     * exercised the direct path, so ATTRIBUTED was enforced on one of the two
     * explanations and unenforced on the other. An unsigned rebuild claim over
     * attested inputs would have been accepted, and a rebuild claim is the one
     * an attacker has the most reason to forge, since it covers a whole table
     * without anybody looking inside it.
     */
    const coverage = coverageFor(
      input({ attestations: [direct(), rebuild({ signatureVerified: false })] }),
    );

    expect(stateOf(coverage, CUSTOMERS)).toBe("ATTESTED");
    expect(stateOf(coverage, DETAILS)).toBe("UNPROVEN");
    expect(residueKinds(coverage, DETAILS)).toContain("unverified-signature");
  });

  it("refuses an attestation that searched for fewer identifiers than the request covers", () => {
    /*
     * The only defence available to a system that cannot ask the question
     * itself. A count of zero from a predicate over one of three identifiers is
     * a correct answer to a narrower question, and is structurally
     * indistinguishable from a correct answer to this one unless the question
     * is recorded.
     */
    const coverage = coverageFor(
      input({
        identifiers: ["cust_88213", "guest_hash_9f2a", "legacy_id_4471"],
        attestations: [direct()],
      }),
    );

    expect(stateOf(coverage, CUSTOMERS)).toBe("UNPROVEN");
    const found = coverage.find((entry) => entry.asset === CUSTOMERS);
    expect(found?.residue).toContainEqual({
      kind: "predicate-gap",
      missing: ["guest_hash_9f2a", "legacy_id_4471"],
    });
  });

  it("keeps one request's answer out of another's", () => {
    // State is per request, never per asset. Bob's request being open must not
    // be answered by Alice's attestation, and an asset-keyed store would.
    const coverage = coverageFor(input({ attestations: [direct({ request: "dsr-2026-0999" })] }));

    expect(stateOf(coverage, CUSTOMERS)).toBe("UNPROVEN");
  });

  it("propagates coverage three hops, which is the whole reason the graph is involved", () => {
    const coverage = coverageFor(
      input({
        currentVersion: { [CUSTOMERS]: "v1", [DETAILS]: "v1", [DASHBOARD]: "v1" },
        recordedUpstream: {
          [CUSTOMERS]: [],
          [DETAILS]: [CUSTOMERS],
          [DASHBOARD]: [DETAILS],
        },
        attestations: [
          direct(),
          rebuild(),
          rebuild({ asset: DASHBOARD, inputs: [{ asset: DETAILS, version: "v1" }] }),
        ],
      }),
    );

    expect(stateOf(coverage, DASHBOARD)).toBe("ATTESTED");

    // And one break at the root takes the whole chain with it.
    const broken = coverageFor(
      input({
        currentVersion: { [CUSTOMERS]: "v1", [DETAILS]: "v1", [DASHBOARD]: "v1" },
        recordedUpstream: {
          [CUSTOMERS]: [],
          [DETAILS]: [CUSTOMERS],
          [DASHBOARD]: [DETAILS],
        },
        attestations: [
          rebuild(),
          rebuild({ asset: DASHBOARD, inputs: [{ asset: DETAILS, version: "v1" }] }),
        ],
      }),
    );
    expect(broken.every((entry) => entry.state === "UNPROVEN")).toBe(true);
  });
});

describe("what the report leads with", () => {
  it("counts covered and unattested separately, and never rounds one into the other", () => {
    const coverage = coverageFor(
      input({
        currentVersion: { [CUSTOMERS]: "v1", [DETAILS]: "v1", [DASHBOARD]: "v1" },
        recordedUpstream: { [CUSTOMERS]: [], [DETAILS]: [CUSTOMERS], [DASHBOARD]: [DETAILS] },
        attestations: [direct(), rebuild(), direct({ asset: DASHBOARD, result: "present" })],
      }),
    );

    expect(summarize(coverage)).toEqual({
      total: 3,
      attested: 2,
      unproven: 0,
      contradicted: 1,
    });
  });

  it("gives every unattested asset a reason somebody could act on", () => {
    // A mark with no traceable cause is not actionable, which is the standard
    // every stale mark in this repo is already held to.
    const coverage = coverageFor(input({ attestations: [rebuild({ materialization: "merge" })] }));

    for (const entry of coverage) {
      if (entry.state === "ATTESTED") continue;
      expect(entry.residue.length, `${entry.asset} has no residue`).toBeGreaterThan(0);
      expect(entry.explanation.length, `${entry.asset} has no explanation`).toBeGreaterThan(20);
    }
  });

  it("returns an answer for every asset it was given, and only those", () => {
    const coverage = coverageFor(input());
    expect(coverage.map((entry) => entry.asset).sort()).toEqual([CUSTOMERS, DETAILS].sort());
  });
});
