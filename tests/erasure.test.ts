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

  it("10b. keeps the contradiction when a later attestation names an older version", () => {
    /*
     * The rollback. An attestor reports customers absent at v1, then reports
     * the subject present at v2, and the board says CONTRADICTED. It then
     * re-signs the ORIGINAL absent record for v1 with a fresh timestamp. The
     * version a report is computed against is whatever the latest attestation
     * names, so the answer moves back to v1, where the present record is not
     * evaluated at all — and the finding leaves the report while sitting in the
     * ledger. Case 10 says nothing argues with a present report, and a record
     * naming an earlier version is still an argument.
     */
    const coverage = coverageFor(
      input({
        currentVersion: { [CUSTOMERS]: "v1", [DETAILS]: "v1" },
        attestations: [
          direct({ version: "v1", at: "2026-08-01T00:00:00.000Z" }),
          direct({ version: "v2", result: "present", at: "2026-08-05T00:00:00.000Z" }),
          direct({ version: "v1", at: "2026-08-09T00:00:00.000Z" }),
        ],
      }),
    );

    expect(stateOf(coverage, CUSTOMERS)).toBe("CONTRADICTED");
    expect(summarize(coverage).contradicted).toBe(1);
    // The sentence names the version the subject was found in, not the version
    // the row is keyed to, so the two cannot be confused for each other.
    expect(coverage.find((entry) => entry.asset === CUSTOMERS)?.explanation).toContain(
      "at version v2",
    );
  });

  it("10c. lets a version first seen after the contradiction answer it", () => {
    /*
     * The other direction, which must keep working: the subject was found in
     * v2, somebody deleted it, the warehouse committed v3, and the attestor
     * re-checked. v3 is a version obsel first heard of after the finding, so it
     * answers it. Without this the first present report would freeze the asset
     * red forever and there would be no way to record the erasure that followed.
     */
    const coverage = coverageFor(
      input({
        currentVersion: { [CUSTOMERS]: "v3", [DETAILS]: "v1" },
        attestations: [
          direct({ version: "v2", result: "present", at: "2026-08-05T00:00:00.000Z" }),
          direct({ version: "v3", at: "2026-08-09T00:00:00.000Z" }),
        ],
      }),
    );

    expect(stateOf(coverage, CUSTOMERS)).toBe("ATTESTED");
    expect(summarize(coverage).contradicted).toBe(0);
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
     * behavior for a system whose entire claim rests on the signatures being
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

  it("refuses a whole-scope record for one identifier stitched to a partition record for the other", () => {
    /*
     * The Direct check names ONE attestation that covers all of K and speaks
     * for the whole of V at the same time. Reading the two halves off
     * different records lets a search of 1 of 730 partitions for
     * `hash-9f2a` borrow the whole-table scope of a record that never looked
     * for `hash-9f2a` at all, and the asset comes out attested absent on
     * ground nobody covered. Composition across records is allowed only
     * between records that each answered the whole question.
     */
    const coverage = coverageFor(
      input({
        identifiers: ["cust_88213", "hash_9f2a"],
        attestations: [
          direct({
            predicate: {
              identifiers: ["cust_88213"],
              expression: "customer_id = 'cust_88213'",
              columns: ["customer_id"],
            },
            scope: { kind: "whole" },
          }),
          direct({
            predicate: {
              identifiers: ["hash_9f2a"],
              expression: "email_hash = 'hash_9f2a' and dt = '2026-01-01'",
              columns: ["email_hash"],
            },
            scope: { kind: "partitions", covered: ["2026-01-01"], total: 730 },
          }),
        ],
      }),
    );

    expect(stateOf(coverage, CUSTOMERS)).toBe("UNPROVEN");
    expect(residueKinds(coverage, CUSTOMERS)).toContain("predicate-split");
  });

  it("does not say nobody searched for an identifier somebody searched", () => {
    /*
     * The refusal above is right and the sentence beside it was not. Both
     * identifiers here were searched for; what is missing is a record that
     * searched both AND spoke for the whole version, and `hash_9f2a` was only
     * ever searched over 1 of 730 partitions. "nobody searched for cust_88213"
     * is a false statement about a named attestor's work, and an operator who
     * checks it finds the search and stops believing the board.
     */
    const coverage = coverageFor(
      input({
        identifiers: ["cust_88213", "hash_9f2a"],
        attestations: [
          direct({
            predicate: {
              identifiers: ["cust_88213"],
              expression: "customer_id = 'cust_88213'",
              columns: ["customer_id"],
            },
            scope: { kind: "whole" },
          }),
          direct({
            predicate: {
              identifiers: ["hash_9f2a"],
              expression: "email_hash = 'hash_9f2a' and dt = '2026-01-01'",
              columns: ["email_hash"],
            },
            scope: { kind: "partitions", covered: ["2026-01-01"], total: 730 },
          }),
        ],
      }),
    );

    const found = coverage.find((entry) => entry.asset === CUSTOMERS);
    expect(found?.explanation).toBe(
      "customers at version v1 is unattested: no single attestation searched for both " +
        "cust_88213 and hash_9f2a, and hash_9f2a was searched over 1 of 730 partitions",
    );
    expect(found?.residue).toContainEqual({
      kind: "predicate-split",
      identifiers: ["cust_88213", "hash_9f2a"],
      partial: [{ identifier: "hash_9f2a", covered: 1, total: 730 }],
    });
  });

  it("still says nobody searched when nobody did", () => {
    // The honest case keeps the honest sentence: an identifier no verified
    // record looked for at all is unexamined, and saying so is true.
    const coverage = coverageFor(
      input({
        identifiers: ["cust_88213", "hash_9f2a"],
        attestations: [direct()],
      }),
    );

    const found = coverage.find((entry) => entry.asset === CUSTOMERS);
    expect(found?.explanation).toBe(
      "customers at version v1 is unattested: nobody searched for hash_9f2a",
    );
  });

  it("composes named partitions only across records that each searched every identifier", () => {
    // The graded partition output stays: two records that each answered the
    // whole question and together name every partition do cover the version,
    // and one that leaves partitions out reports how many are left.
    const both = {
      identifiers: ["cust_88213", "hash_9f2a"],
      expression: "customer_id = 'cust_88213' or email_hash = 'hash_9f2a'",
      columns: ["customer_id", "email_hash"],
    };
    const covered = coverageFor(
      input({
        identifiers: ["cust_88213", "hash_9f2a"],
        attestations: [
          direct({ predicate: both, scope: { kind: "partitions", covered: ["p1"], total: 2 } }),
          direct({ predicate: both, scope: { kind: "partitions", covered: ["p2"], total: 2 } }),
        ],
      }),
    );
    expect(stateOf(covered, CUSTOMERS)).toBe("ATTESTED");

    const partial = coverageFor(
      input({
        identifiers: ["cust_88213", "hash_9f2a"],
        attestations: [
          direct({ predicate: both, scope: { kind: "partitions", covered: ["p1"], total: 2 } }),
        ],
      }),
    );
    expect(stateOf(partial, CUSTOMERS)).toBe("UNPROVEN");
    expect(partial.find((entry) => entry.asset === CUSTOMERS)?.residue).toContainEqual({
      kind: "partitions-uncovered",
      covered: 1,
      total: 2,
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

describe("self-rebuild: compaction, vacuum, and the churn they cause", () => {
  /*
   * The rule these exercise is in `docs/erasure-coverage.md` under "Self-rebuild".
   * It was written there first, and every case below is one of its rows.
   *
   * Why it exists: an attestation binds to a version, so every write reopens
   * every obligation — including the writes a table format performs on itself
   * for reasons that have nothing to do with the data. Under ordinary
   * maintenance an estate converges to everything-UNPROVEN and the report stops
   * being read, which is the same outcome as having no rule at all.
   */

  /** `DETAILS` at v2, rebuilt from nothing but its own v1. */
  function compaction(over: Partial<RebuildAttestation> = {}): RebuildAttestation {
    return rebuild({
      version: "v2",
      inputs: [{ asset: DETAILS, version: "v1" }],
      at: "2026-07-27T02:00:00.000Z",
      ...over,
    });
  }

  /** v1 of DETAILS explained the ordinary way, so a chain has ground to stand on. */
  function groundedAtV1(): RebuildAttestation[] {
    return [rebuild()];
  }

  it("11. carries coverage forward through an honest compaction", () => {
    /*
     * Total, sole producer, signed, and its one declared input is the version
     * that was attested. Nothing entered v2 that was not already accounted for
     * in v1, which is a stronger claim about inputs than any ordinary rebuild
     * makes — so refusing it would demand re-attestation of a fact already on
     * file, which is the fatigue the rule exists to reduce.
     */
    const coverage = coverageFor(
      input({
        currentVersion: { [CUSTOMERS]: "v1", [DETAILS]: "v2" },
        attestations: [direct(), ...groundedAtV1(), compaction()],
      }),
    );

    expect(stateOf(coverage, DETAILS)).toBe("ATTESTED");
    expect(residueKinds(coverage, DETAILS)).toEqual([]);
  });

  it("11b. does so without any recorded self-lineage, which no catalog holds", () => {
    // The carve-out's whole point. DataHub records how a table is built from
    // OTHER tables; demanding a self-edge would refuse every honest compaction.
    const coverage = coverageFor(
      input({
        currentVersion: { [CUSTOMERS]: "v1", [DETAILS]: "v2" },
        recordedUpstream: { [CUSTOMERS]: [], [DETAILS]: [CUSTOMERS] },
        attestations: [direct(), ...groundedAtV1(), compaction()],
      }),
    );

    expect(residueKinds(coverage, DETAILS)).not.toContain("closure-mismatch");
    expect(residueKinds(coverage, DETAILS)).not.toContain("no-recorded-lineage");
  });

  it("12. refuses a compaction that also merged new rows", () => {
    // Not TOTAL, so part of v2 is a portion this run did not write. The
    // exclusion from the closure check does not weaken any other condition.
    const coverage = coverageFor(
      input({
        currentVersion: { [CUSTOMERS]: "v1", [DETAILS]: "v2" },
        attestations: [direct(), ...groundedAtV1(), compaction({ materialization: "merge" })],
      }),
    );

    expect(stateOf(coverage, DETAILS)).toBe("UNPROVEN");
    expect(residueKinds(coverage, DETAILS)).toContain("not-total");
  });

  it("12b. holds a rebuild declaring fresh inputs beside itself to the full check", () => {
    /*
     * A mixed input set is NOT a self-rebuild. This is the line a future reader
     * will want to move, and moving it is how the carve-out becomes a hole: a
     * self-edge plus a narrowed set of real upstreams would dodge the very
     * cross-check CLOSED exists for.
     */
    const coverage = coverageFor(
      input({
        currentVersion: { [CUSTOMERS]: "v1", [DETAILS]: "v2" },
        // The catalog says ORDERS feeds it too, and the attestation omits it.
        recordedUpstream: { [CUSTOMERS]: [], [DETAILS]: [CUSTOMERS, ORDERS] },
        attestations: [
          direct(),
          ...groundedAtV1(),
          compaction({
            inputs: [
              { asset: DETAILS, version: "v1" },
              { asset: CUSTOMERS, version: "v1" },
            ],
          }),
        ],
      }),
    );

    expect(stateOf(coverage, DETAILS)).toBe("UNPROVEN");
    expect(residueKinds(coverage, DETAILS)).toContain("closure-mismatch");
  });

  it("13. refuses a self-rebuild whose prior version was never attested", () => {
    // Coverage is inherited through the prior version, so there has to be
    // something to inherit. Without v1's own explanation there is no ground.
    const coverage = coverageFor(
      input({
        currentVersion: { [CUSTOMERS]: "v1", [DETAILS]: "v2" },
        attestations: [direct(), compaction()],
      }),
    );

    expect(stateOf(coverage, DETAILS)).toBe("UNPROVEN");
    expect(residueKinds(coverage, DETAILS)).toContain("unattested-input");
  });

  it("13b. says the asset was rewritten from its own version, not built from itself", () => {
    // The generic sentence reads "order details was built from order details",
    // which looks like a defect in obsel rather than the fact it is.
    const coverage = coverageFor(
      input({
        currentVersion: { [CUSTOMERS]: "v1", [DETAILS]: "v2" },
        attestations: [direct(), compaction()],
      }),
    );

    const entry = coverage.find((row) => row.asset === DETAILS);
    expect(entry?.explanation).toContain("rewritten from its own version v1");
  });

  it("14. drops a chain whose grounding attestation was retracted", () => {
    /*
     * RETRACTED means the claim was never true, unlike SUPERSEDED. So v1's
     * explanation falls, and with it every later version that inherited from
     * it — recomputed by the least fixpoint rather than by a special traversal.
     */
    const coverage = coverageFor(
      input({
        currentVersion: { [CUSTOMERS]: "v1", [DETAILS]: "v3" },
        attestations: [
          direct(),
          rebuild({ retracted: true }),
          compaction(),
          compaction({ version: "v3", inputs: [{ asset: DETAILS, version: "v2" }] }),
        ],
      }),
    );

    expect(stateOf(coverage, DETAILS)).toBe("UNPROVEN");
  });

  it("14b. promotes a whole chain when its ground holds", () => {
    // The counterpart, and the reason 14 is evidence of anything: v1 direct,
    // v2 from v1, v3 from v2. Induction over versions, one round each.
    const coverage = coverageFor(
      input({
        currentVersion: { [CUSTOMERS]: "v1", [DETAILS]: "v3" },
        attestations: [
          direct(),
          ...groundedAtV1(),
          compaction(),
          compaction({ version: "v3", inputs: [{ asset: DETAILS, version: "v2" }] }),
        ],
      }),
    );

    expect(stateOf(coverage, DETAILS)).toBe("ATTESTED");
  });

  it("15. refuses a chain signed by a key whose signatures do not verify", () => {
    // Key invalidation happens before the kernel, arriving here as
    // `signatureVerified: false`. The chain has no verified ground, so it falls.
    const coverage = coverageFor(
      input({
        currentVersion: { [CUSTOMERS]: "v1", [DETAILS]: "v2" },
        attestations: [
          direct(),
          rebuild({ signatureVerified: false }),
          compaction({ signatureVerified: false }),
        ],
      }),
    );

    expect(stateOf(coverage, DETAILS)).toBe("UNPROVEN");
    expect(residueKinds(coverage, DETAILS)).toContain("unverified-signature");
  });

  it("15b. never promotes a rebuild that declares its own current version as input", () => {
    /*
     * The degenerate edge, and the one a greatest fixpoint would certify: the
     * attestation says v2 was built from v2. Its state starts UNPROVEN and can
     * only be promoted by evidence requiring it to already be promoted, so the
     * least fixpoint never moves it. Same failure as case 5, one level down.
     */
    const coverage = coverageFor(
      input({
        currentVersion: { [CUSTOMERS]: "v1", [DETAILS]: "v2" },
        attestations: [
          direct(),
          ...groundedAtV1(),
          compaction({ inputs: [{ asset: DETAILS, version: "v2" }] }),
        ],
      }),
    );

    expect(stateOf(coverage, DETAILS)).toBe("UNPROVEN");
  });
});
