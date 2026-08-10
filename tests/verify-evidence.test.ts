/**
 * The offline verifier, run as a judge runs it: a real `node` process on the real
 * script, over a bundle on disk.
 *
 * **Real keypairs and real signatures**, the same rule `tests/attestation.test.ts`
 * keeps. A stand-in for a signature is a stand-in for the only thing this script
 * exists to check.
 *
 * The script is spawned rather than imported, because what is being checked is
 * partly not JavaScript: the exit code, the stdout a person reads, and that Node
 * can strip the types off `attestation.ts` and `erasure.ts` and run the kernel
 * with no build step and no dependency. Importing the module would test none of
 * those, and the zero-setup claim is the whole point of the artifact.
 *
 * Every case below is one edit to a bundle that verifies, so the failure it
 * produces is attributable to that edit and to nothing else.
 */

import { generateKeyPairSync, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { signAttestation } from "@/src/server/coordinator/attestation";
import type {
  Challenge,
  Envelope,
  RegisteredKey,
  SignedRecord,
} from "@/src/server/coordinator/attestation";

const SCRIPT = new URL("../scripts/verify-erasure-evidence.mjs", import.meta.url).pathname;

/** The same list `tests/erasure-limits.test.ts` holds every report to. */
const FORBIDDEN = /\b(proof|proven|proves|complete|completely)\b/i;

const CUSTOMERS = "urn:li:dataset:(urn:li:dataPlatform:snowflake,order_entry.customers,PROD)";
const MIRROR = "urn:li:dataset:(urn:li:dataPlatform:dbt,order_entry.customers,PROD)";
const ELSEWHERE = "urn:li:dataset:(urn:li:dataPlatform:snowflake,order_entry.addresses,PROD)";
const REQUEST = "dsr-2026-0417";
const IDENTIFIER = "cust_88213";

const WAREHOUSE = keypair();
const SECOND = keypair();

function keypair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

const KEYS: RegisteredKey[] = [
  {
    keyId: "warehouse-2026-07",
    attestor: "warehouse-adapter@acme",
    publicKeyPem: WAREHOUSE.publicKeyPem,
    notBefore: "2026-07-01T00:00:00.000Z",
    status: { state: "active" },
    scope: ["urn:li:dataset:*"],
  },
  {
    keyId: "spare-2026-07",
    attestor: "warehouse-adapter@acme",
    publicKeyPem: SECOND.publicKeyPem,
    notBefore: "2026-07-01T00:00:00.000Z",
    status: { state: "active" },
    scope: ["urn:li:dataset:*"],
  },
];

const DIRECT_CHALLENGE: Challenge = {
  nonce: "n-direct-6f21ab",
  request: REQUEST,
  asset: CUSTOMERS,
  issuedAt: "2026-07-26T11:55:00.000Z",
  expiresAt: "2026-07-26T12:10:00.000Z",
};

const REBUILD_CHALLENGE: Challenge = {
  nonce: "n-rebuild-91cc03",
  request: REQUEST,
  asset: MIRROR,
  issuedAt: "2026-07-26T11:59:00.000Z",
  expiresAt: "2026-07-26T12:14:00.000Z",
};

const DIRECT_AT = "2026-07-26T11:58:00.000Z";
const REBUILD_AT = "2026-07-26T12:00:00.000Z";

function directRecord(over: Partial<SignedRecord> = {}): SignedRecord {
  return {
    kind: "direct",
    request: REQUEST,
    asset: CUSTOMERS,
    version: "snapshot-7741",
    predicate: {
      identifiers: [IDENTIFIER],
      expression: `customer_id = '${IDENTIFIER}'`,
      columns: ["customer_id"],
    },
    scope: { kind: "whole" },
    result: "absent",
    attestor: "warehouse-adapter@acme",
    signatureVerified: false,
    at: DIRECT_AT,
    nonce: DIRECT_CHALLENGE.nonce,
    ...over,
  } as SignedRecord;
}

function rebuildRecord(over: Partial<SignedRecord> = {}): SignedRecord {
  return {
    kind: "rebuild",
    request: REQUEST,
    asset: MIRROR,
    version: "dbt-run-118",
    materialization: "full",
    soleProducer: true,
    inputs: [{ asset: CUSTOMERS, version: "snapshot-7741" }],
    attestor: "warehouse-adapter@acme",
    signatureVerified: false,
    at: REBUILD_AT,
    nonce: REBUILD_CHALLENGE.nonce,
    ...over,
  } as SignedRecord;
}

interface Bundle {
  formatVersion: number;
  capturedAt: string;
  request: {
    request: string;
    seeds: string[];
    hops: number;
    openedAt: string;
    identifierDigests: string[];
  };
  reachable: string[];
  upstreamOf: Record<string, string[]>;
  keys: RegisteredKey[];
  challenges: Challenge[];
  attestations: {
    asset: string;
    sequence: number;
    at: string;
    body: { envelope: Envelope; keyId: string; nonce: string };
  }[];
  report: {
    summary: { total: number; attested: number; unproven: number; contradicted: number };
    coverage: { asset: string; version: string; state: string }[];
    attestationsDroppedForKeys: { asset: string; attestor: string; reason: string }[];
  };
}

/**
 * A bundle that verifies, and whose recorded answer is the one the evidence
 * supports: two assets, both covered, the second only because the first is.
 *
 * The recorded report is written out by hand rather than computed, deliberately.
 * It is the claim under test, and a claim generated by the same kernel that
 * checks it would agree with itself no matter what either did.
 */
function soundBundle(): Bundle {
  return {
    formatVersion: 1,
    capturedAt: "2026-07-26T12:01:00.000Z",
    request: {
      request: REQUEST,
      seeds: [CUSTOMERS],
      hops: 2,
      openedAt: "2026-07-26T11:50:00.000Z",
      identifierDigests: [createHash("sha256").update(IDENTIFIER, "utf8").digest("hex")],
    },
    reachable: [MIRROR, CUSTOMERS].sort(),
    upstreamOf: { [CUSTOMERS]: [], [MIRROR]: [CUSTOMERS] },
    keys: KEYS,
    challenges: [DIRECT_CHALLENGE, REBUILD_CHALLENGE],
    attestations: [
      {
        asset: CUSTOMERS,
        sequence: 1,
        at: DIRECT_AT,
        body: {
          envelope: signAttestation(directRecord(), WAREHOUSE.privateKeyPem, "warehouse-2026-07"),
          keyId: "warehouse-2026-07",
          nonce: DIRECT_CHALLENGE.nonce,
        },
      },
      {
        asset: MIRROR,
        sequence: 1,
        at: REBUILD_AT,
        body: {
          envelope: signAttestation(rebuildRecord(), WAREHOUSE.privateKeyPem, "warehouse-2026-07"),
          keyId: "warehouse-2026-07",
          nonce: REBUILD_CHALLENGE.nonce,
        },
      },
    ],
    report: {
      summary: { total: 2, attested: 2, unproven: 0, contradicted: 0 },
      coverage: [
        { asset: MIRROR, version: "dbt-run-118", state: "ATTESTED" },
        { asset: CUSTOMERS, version: "snapshot-7741", state: "ATTESTED" },
      ],
      attestationsDroppedForKeys: [],
    },
  };
}

const workspace = mkdtempSync(join(tmpdir(), "obsel-evidence-"));
let written = 0;

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** Write a bundle and run the real script over it, as a person would. */
function verify(bundle: unknown): { code: number; stdout: string; stderr: string } {
  written += 1;
  const path = join(workspace, `bundle-${written}.json`);
  writeFileSync(path, JSON.stringify(bundle, null, 2));
  const run = spawnSync(process.execPath, [SCRIPT, path], {
    encoding: "utf8",
    // Vitest sets NODE_OPTIONS for its own workers, and inheriting it here would
    // load the runner into a process that is meant to be a bare `node`.
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  return { code: run.status ?? -1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

describe("a bundle whose evidence supports the answer recorded in it", () => {
  it("verifies every record and agrees with the recorded report", () => {
    const run = verify(soundBundle());
    expect(run.stdout).toContain("2 of 2 assets covered");
    expect(run.stdout).toContain("every record verified");
    expect(run.stdout).not.toContain("FAILED");
    expect(run.code, run.stdout).toBe(0);
  });

  it("says what it checked in the vocabulary the specification fixes", () => {
    const run = verify(soundBundle());
    // The sentence the kernel builds, arriving through a second process and a
    // file, which is the whole path a reader outside obsel travels.
    expect(run.stdout).toContain("attested absent over version snapshot-7741");
    for (const line of run.stdout.split("\n")) {
      expect(FORBIDDEN.test(line), `forbidden vocabulary in: ${line}`).toBe(false);
    }
    // And it states the limit rather than leaving the counts to speak alone.
    expect(run.stdout).toContain("holds no warehouse credentials");
  });

  it("runs on Node alone, with nothing installed and nothing built", () => {
    /*
     * The claim the artifact is for. The script imports the repository's own
     * `attestation.ts` and `erasure.ts` through Node's type stripping, so this
     * passing is what says a judge with Node and a checkout needs nothing else.
     * If type stripping ever stopped working, the import would throw and this
     * would be the test that named the reason.
     */
    const run = verify(soundBundle());
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
  });

  it("refuses a file that is not a bundle, separately from one that does not check out", () => {
    // Exit 2 is "I could not read this", which is a different thing for a caller
    // than exit 1, "I read it and it does not hold up".
    expect(verify({ formatVersion: 4 }).code).toBe(2);
    expect(verify({ hello: "world" }).code).toBe(2);
    const noArgument = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    expect(noArgument.status).toBe(2);
    expect(noArgument.stdout).toContain("usage");
  });
});

describe("one edit each, and the failure each edit produces", () => {
  it("catches a flipped byte in a signed payload", () => {
    const bundle = soundBundle();
    const envelope = bundle.attestations[0].body.envelope;
    const payload = Buffer.from(envelope.payload, "base64");
    // The version string, moved by one character. The record still parses, is
    // still in scope, still answers a live challenge; only the bytes moved.
    const decoded = payload.toString("utf8").replace("snapshot-7741", "snapshot-7742");
    envelope.payload = Buffer.from(decoded, "utf8").toString("base64");

    const run = verify(bundle);
    expect(run.code, run.stdout).toBe(1);
    expect(run.stdout).toContain("bad-signature");
    expect(run.stdout).toContain("FAILED");
  });

  it("catches a signature relabelled with another registered key", () => {
    const bundle = soundBundle();
    bundle.attestations[0].body.envelope.signatures[0].keyid = "spare-2026-07";

    const run = verify(bundle);
    expect(run.code, run.stdout).toBe(1);
    // The ledger's own copy of the key id no longer matches the signature it
    // describes, which is the edit itself rather than a consequence of it.
    expect(run.stdout).toContain("recorded-keyid-mismatch");
    // And the arithmetic fails too: the spare key did not make this signature.
    expect(run.stdout).toContain("bad-signature");
  });

  it("takes every coverage back when the signing key is reported compromised", () => {
    /*
     * The one way coverage is lost with nobody touching any data. The evidence
     * is untouched here and every signature still stands over the bytes it
     * covers; what changed is one field in the registry.
     */
    const bundle = soundBundle();
    bundle.keys = bundle.keys.map((key) =>
      key.keyId === "warehouse-2026-07"
        ? { ...key, status: { state: "compromised" as const, at: "2026-07-27T09:00:00.000Z" } }
        : key,
    );

    const run = verify(bundle);
    expect(run.code, run.stdout).toBe(1);
    expect(run.stdout).toContain("key-compromised");
    expect(run.stdout).toContain("0 of 2 assets covered");
    // And it says so against the recorded answer rather than only in the abstract.
    expect(run.stdout).toContain("recorded ATTESTED");
  });

  it("catches lineage edited to hide an upstream the rebuild never declared", () => {
    /*
     * The closure check is the only thing standing between "I declare I read
     * these two tables" and an attestor quietly dropping the unclean one. It is
     * made against DataHub's edges, so those edges are evidence, and a bundle
     * whose edges were edited is a bundle whose closure check was made against
     * the wrong set.
     */
    const bundle = soundBundle();
    bundle.upstreamOf[MIRROR] = [CUSTOMERS, ELSEWHERE];

    const run = verify(bundle);
    expect(run.code, run.stdout).toBe(1);
    // Every signature still verifies. What fails is the answer.
    expect(run.stdout).not.toContain("FAILED");
    expect(run.stdout).toContain("recorded ATTESTED, the evidence here supports UNPROVEN");
    expect(run.stdout).toContain("1 of 2 assets covered");
  });

  it("catches a challenge removed from the bundle", () => {
    /*
     * Without its challenge, a record is a signature over a claim that answers no
     * question obsel asked, which is exactly the record an attestor could have
     * prepared years earlier and held.
     */
    const bundle = soundBundle();
    bundle.challenges = bundle.challenges.filter(
      (challenge) => challenge.nonce !== DIRECT_CHALLENGE.nonce,
    );

    const run = verify(bundle);
    expect(run.code, run.stdout).toBe(1);
    expect(run.stdout).toContain("unknown-challenge");
    // And the rebuild falls with it, because its declared input is no longer
    // covered. Nothing had to traverse anything for that: the least fixpoint
    // never promoted it.
    expect(run.stdout).toContain("0 of 2 assets covered");
  });

  it("catches a record appended a second time under the same challenge", () => {
    /*
     * A challenge is single use, and single use is only checkable in order. The
     * first record here is the one that spent the nonce, so the copy behind it is
     * the replay, whatever else the two have in common.
     */
    const bundle = soundBundle();
    bundle.attestations.push({ ...bundle.attestations[0], sequence: 2 });

    const run = verify(bundle);
    expect(run.code, run.stdout).toBe(1);
    expect(run.stdout).toContain("challenge-replayed");
    // The first copy is untouched, so the answer itself does not move. The
    // finding is the appended record, not the coverage.
    expect(run.stdout).toContain("2 of 2 assets covered");
  });

  it("catches a record dated outside the window of the challenge it answers", () => {
    const late = soundBundle();
    late.attestations[0].at = "2026-07-26T12:40:00.000Z";
    late.attestations[0].body.envelope = signAttestation(
      directRecord({ at: "2026-07-26T12:40:00.000Z" }),
      WAREHOUSE.privateKeyPem,
      "warehouse-2026-07",
    );
    const lateRun = verify(late);
    expect(lateRun.code, lateRun.stdout).toBe(1);
    expect(lateRun.stdout).toContain("challenge-expired");

    /*
     * And the other end, which `verifyAttestation` does not check because on a
     * live server it cannot happen: a record cannot arrive before the nonce it
     * quotes was minted. In a file it can, and it means the timestamp was moved.
     */
    const early = soundBundle();
    early.attestations[0].at = "2026-07-26T11:30:00.000Z";
    early.attestations[0].body.envelope = signAttestation(
      directRecord({ at: "2026-07-26T11:30:00.000Z" }),
      WAREHOUSE.privateKeyPem,
      "warehouse-2026-07",
    );
    const earlyRun = verify(early);
    expect(earlyRun.code, earlyRun.stdout).toBe(1);
    expect(earlyRun.stdout).toContain("at-before-challenge-issued");
  });

  it("catches the ledger's own copy of a nonce edited away from the signed one", () => {
    /*
     * `verifyAttestation` reads the nonce out of the signed payload and never
     * looks at the copy beside it, so an edited copy verifies while describing
     * the record wrongly — and the description is what a person reads off the
     * ledger.
     */
    const bundle = soundBundle();
    bundle.attestations[0].body.nonce = REBUILD_CHALLENGE.nonce;

    const run = verify(bundle);
    expect(run.code, run.stdout).toBe(1);
    expect(run.stdout).toContain("recorded-nonce-mismatch");
  });

  it("says what it found in the same vocabulary when it finds a problem", () => {
    // A failure report is a surface like any other, and the words are fixed for
    // it too. This is the one that would drift, because failure text is written
    // in a hurry.
    const bundle = soundBundle();
    bundle.upstreamOf[MIRROR] = [CUSTOMERS, ELSEWHERE];
    for (const line of verify(bundle).stdout.split("\n")) {
      expect(FORBIDDEN.test(line), `forbidden vocabulary in: ${line}`).toBe(false);
    }
  });
});
