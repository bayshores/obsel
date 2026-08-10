/**
 * One erasure request, end to end, through a real obsel over HTTP.
 *
 * A real Next server, real routes, real Ed25519 keys, real DataHub `document`
 * entities for the ledger, and a real lineage walk across the
 * `showcase-ecommerce` pack. Nothing here is stood in for. Until this file
 * existed, the attestation layer was reachable only from unit tests and no
 * erasure had ever been run.
 *
 * The subject is somebody else's catalog throughout: obsel seeds nothing,
 * writes nothing onto any showcase entity, and its whole contribution lives in
 * `document` records of its own.
 */

import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireDataHub } from "./reachable";
import { startObsel, type ObselServer } from "./obsel-server";

const { signAttestation } = await import("@/src/server/coordinator/attestation");
const { ledgerUrn, readAttestationsFor, readLedgerRecord } =
  await import("@/src/server/datahub/documents");

const PORT = 3117;
const FLOW_ID = "obsel_integration_tests";
const TOKEN = "integration-suite-token";

const SNOWFLAKE = "urn:li:dataPlatform:snowflake";
const CUSTOMERS = `urn:li:dataset:(${SNOWFLAKE},b2fd91.order_entry_db.order_entry.customers,PROD)`;

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const KEY_ID = "integration-warehouse-key";
const ATTESTOR = "warehouse-adapter@integration";

/** The registry, as an operator would supply it. Never writable over HTTP. */
function registry(status: Record<string, unknown> = { state: "active" }): string {
  return JSON.stringify([
    {
      keyId: KEY_ID,
      attestor: ATTESTOR,
      publicKeyPem: PUBLIC_PEM,
      notBefore: "2026-01-01T00:00:00.000Z",
      status,
      scope: [`urn:li:dataset:(${SNOWFLAKE},*`],
    },
  ]);
}

let server: ObselServer;
/** Unique per run: ledger records are append-only and obsel never deletes. */
const REQUEST = `dsr-live-${Date.now()}`;

async function api(
  path: string,
  init: RequestInit & { token?: string | null } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { token = TOKEN, ...rest } = init;
  const response = await fetch(`${server.url}${path}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(rest.headers ?? {}),
    },
    signal: AbortSignal.timeout(120_000),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

interface CoverageRow {
  asset: string;
  state: string;
  version: string;
  explanation: string;
}

function rowFor(body: Record<string, unknown>, asset: string): CoverageRow | undefined {
  return (body.coverage as CoverageRow[] | undefined)?.find((row) => row.asset === asset);
}

beforeAll(async () => {
  await requireDataHub();
  server = await startObsel(PORT, FLOW_ID, {
    OBSEL_API_TOKEN: TOKEN,
    OBSEL_ATTESTOR_KEYS: registry(),
  });
  return async () => {
    await server.stop();
  };
}, 300_000);

afterAll(async () => {
  await server?.stop();
});

describe("the routes refuse before they do anything", () => {
  it("refuses an unauthenticated write to every mutating route", async () => {
    for (const path of ["/api/erasure", "/api/erasure/challenge", "/api/erasure/proof"]) {
      const response = await api(path, {
        method: "POST",
        token: null,
        body: JSON.stringify({}),
      });
      expect(response.status, `${path} should refuse`).toBe(401);
    }
  }, 120_000);

  it("refuses a wrong token", async () => {
    const response = await api("/api/erasure", {
      method: "POST",
      token: "not-the-token",
      body: JSON.stringify({ identifiers: ["x"], seeds: [CUSTOMERS] }),
    });
    expect(response.status).toBe(401);
  }, 120_000);

  it("refuses a seed DataHub has no dataset for, and names it", async () => {
    /*
     * The typo case. `/relationships` answers a URN nobody ever wrote with an
     * empty list rather than an error, so before the seed check this opened a
     * request, walked nowhere and answered 200 with one UNPROVEN row and
     * `assetsReached: 1` — the same report the postgres copy of this table
     * genuinely produces. The refusal names every unknown seed, and no ledger
     * record is written for a request that was refused.
     */
    const typo = `urn:li:dataset:(${SNOWFLAKE},b2fd91.order_entry_db.order_entry.custmers,PROD)`;
    const refused = await api("/api/erasure", {
      method: "POST",
      body: JSON.stringify({
        request: `${REQUEST}-unknown-seed`,
        identifiers: ["cust_88213"],
        seeds: [CUSTOMERS, typo],
        hops: 2,
      }),
    });

    expect(refused.status).toBe(400);
    expect(refused.body.unknownSeeds).toEqual([typo]);
    expect(String(refused.body.error)).toContain(typo);
    expect(refused.body.coverage).toBeUndefined();

    // Nothing was opened, so reading it back finds no request.
    const status = await api(`/api/erasure/${REQUEST}-unknown-seed`, { method: "GET" });
    expect(status.status).toBe(500);
  }, 120_000);

  it("has no route that marks an asset covered", async () => {
    /*
     * The rule this product cannot bend. Coverage is derived from the ledger on
     * every read, so there is nothing to clear even in principle, and a tool to
     * declare work done would be a tool for silencing the one thing obsel is
     * for. Asserted rather than assumed, because the absence of an endpoint is
     * exactly the kind of thing a later commit adds for convenience.
     */
    for (const path of [
      `/api/erasure/${REQUEST}/clear`,
      `/api/erasure/${REQUEST}/attest`,
      "/api/erasure/cover",
    ]) {
      const response = await fetch(`${server.url}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: "{}",
        signal: AbortSignal.timeout(60_000),
      });
      // 404 for a path with no route, 405 for one whose only method is GET.
      // Either way there is no mutation behind it, which is the assertion.
      expect([404, 405], `${path} should have no mutation behind it`).toContain(response.status);
    }
  }, 120_000);
});

describe("one erasure request, from opening to covered and back", () => {
  it("opens, walks a real catalog, and starts with everything unattested", async () => {
    const opened = await api("/api/erasure", {
      method: "POST",
      body: JSON.stringify({
        request: REQUEST,
        identifiers: ["cust_88213"],
        seeds: [CUSTOMERS],
        hops: 2,
      }),
    });

    expect(opened.status).toBe(200);
    const summary = opened.body.summary as Record<string, number>;
    expect(summary.total).toBeGreaterThan(1);
    // Everything, with no exceptions. An asset nobody has spoken for is
    // unattested, and on the day a request opens nobody has spoken for any.
    expect(summary.attested).toBe(0);
    expect(summary.unproven).toBe(summary.total);

    const row = rowFor(opened.body, CUSTOMERS);
    expect(row?.state).toBe("UNPROVEN");
    expect(row?.explanation).toContain("unattested");

    // The report says how far it walked, so a reader can tell a covered estate
    // from a small one.
    const assurance = opened.body.assurance as Record<string, number>;
    expect(assurance.hopsWalked).toBe(2);
    expect(assurance.assetsReached).toBe(summary.total);

    /*
     * And it says what those numbers cannot account for, on the wire rather
     * than only in the documentation. Asserted on the real route because the
     * unit test can only prove the constant is well formed; this proves the
     * response an API consumer actually receives carries it.
     */
    const limits = (opened.body.assurance as { limits?: unknown }).limits as string[];
    expect(Array.isArray(limits)).toBe(true);
    expect(limits.length).toBeGreaterThan(0);
    for (const limit of limits) {
      expect(/\b(proof|proven|proves|complete|completely)\b/i.test(limit), limit).toBe(false);
    }
  }, 300_000);

  it("refuses a second open under the same id, and leaves the first record as it was", async () => {
    /*
     * The write path is an upsert, so DataHub would accept the second open and
     * replace the request record in place: identifiers, seeds, hops and the
     * opened time. The attestations under that id would stay, still read back
     * by the report, now beside a question they were never asked. obsel reads
     * the ledger URN first and refuses.
     */
    const urn = ledgerUrn("request", REQUEST);
    const before = await readLedgerRecord(urn);
    expect(before).not.toBeNull();

    const reopened = await api("/api/erasure", {
      method: "POST",
      body: JSON.stringify({
        request: REQUEST,
        identifiers: ["cust_88213", "cust_99001"],
        seeds: [CUSTOMERS],
        hops: 5,
      }),
    });

    expect(reopened.status).toBe(409);
    expect(reopened.body.error).toContain(REQUEST);

    const after = await readLedgerRecord(urn);
    expect(after?.body).toBe(before?.body);
    expect(after?.at).toBe(before?.at);
  }, 300_000);

  it("does not echo the subject's identifiers back in the report", async () => {
    /*
     * Handing the subject key to everyone who reads the report would create
     * fresh copies of the identifier in the act of accounting for its removal,
     * which is an Article 5(1)(c) minimization problem of obsel's own making.
     * The identifiers live on the request record and are not echoed.
     */
    const status = await api(`/api/erasure/${REQUEST}`, { method: "GET" });
    expect(status.status).toBe(200);
    expect(JSON.stringify(status.body)).not.toContain("cust_88213");
  }, 120_000);

  it("covers an asset once a real signed attestation arrives, and not before", async () => {
    const challenge = await api("/api/erasure/challenge", {
      method: "POST",
      body: JSON.stringify({ request: REQUEST, asset: CUSTOMERS }),
    });
    expect(challenge.status).toBe(200);
    const nonce = challenge.body.nonce as string;
    expect(nonce).toBeTruthy();

    // An unsigned claim first: this is what every attestation looks like until
    // the crypto has passed it, and it must change nothing.
    const unsigned = await api("/api/erasure/proof", {
      method: "POST",
      body: JSON.stringify({
        request: REQUEST,
        envelope: {
          payloadType: "application/vnd.obsel.attestation+json",
          payload: Buffer.from("{}").toString("base64"),
          signatures: [{ keyid: KEY_ID, sig: "bm90LWEtc2lnbmF0dXJl" }],
        },
      }),
    });
    expect(unsigned.status).toBe(422);
    expect(unsigned.body.accepted).toBe(false);

    const signed = signAttestation(
      {
        kind: "direct",
        request: REQUEST,
        asset: CUSTOMERS,
        version: "snapshot-7741",
        predicate: {
          identifiers: ["cust_88213"],
          expression: "customer_id = 'cust_88213'",
          columns: ["customer_id"],
        },
        scope: { kind: "whole" },
        result: "absent",
        attestor: ATTESTOR,
        signatureVerified: false,
        at: new Date().toISOString(),
        nonce,
      },
      PRIVATE_PEM,
      KEY_ID,
    );

    const accepted = await api("/api/erasure/proof", {
      method: "POST",
      body: JSON.stringify({ request: REQUEST, envelope: signed }),
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.accepted).toBe(true);

    const report = accepted.body.report as Record<string, unknown>;
    const row = rowFor(report, CUSTOMERS);
    expect(row?.state).toBe("ATTESTED");
    expect(row?.version).toBe("snapshot-7741");
    // The vocabulary the specification requires, all the way out through HTTP.
    expect(row?.explanation).toContain("attested absent over version snapshot-7741");
    expect(row?.explanation).not.toContain("proven");

    // Everything downstream is still unattested, which is the honest answer:
    // one table being clean says nothing about what was built from it.
    const summary = report.summary as Record<string, number>;
    expect(summary.attested).toBe(1);
    expect(summary.unproven).toBe(summary.total - 1);
  }, 300_000);

  it("refuses the same envelope a second time", async () => {
    /*
     * Single use, enforced across two separate HTTP requests against a ledger
     * in DataHub rather than in a variable. Without it, one signed answer covers
     * every later version of the asset forever.
     */
    const ledger = await readAttestationsFor(REQUEST, CUSTOMERS);
    expect(ledger.length, "the accepted attestation should be in the ledger").toBe(1);
    const stored = JSON.parse(ledger[0].body) as { envelope: unknown };

    const replay = await api("/api/erasure/proof", {
      method: "POST",
      body: JSON.stringify({ request: REQUEST, envelope: stored.envelope }),
    });

    expect(replay.status).toBe(422);
    const failures = replay.body.failures as { kind: string }[];
    expect(failures.map((entry) => entry.kind)).toContain("challenge-replayed");
  }, 300_000);

  it("keeps the answer in DataHub, so a fresh read gives the same report", async () => {
    // Nothing about the verdict is held in memory. A GET recomputes it from the
    // ledger and the graph, which is why a compromised key or a new version can
    // take a green away without anything having to remember to.
    const status = await api(`/api/erasure/${REQUEST}`, { method: "GET" });
    expect(status.status).toBe(200);
    expect(rowFor(status.body, CUSTOMERS)?.state).toBe("ATTESTED");

    // The request record plus the one attestation. Challenges are deliberately
    // not counted: asking more questions must not make a report look better
    // evidenced than it is.
    const assurance = status.body.assurance as Record<string, number>;
    expect(assurance.evidenceRecords).toBe(2);
  }, 300_000);
});

describe("two attestors answering at the same instant", () => {
  /*
   * Single use is only true if checking a nonce and consuming it cannot
   * interleave with another submission doing the same. Two attestors answering
   * at once would otherwise both read the challenge unconsumed and both be
   * accepted, which is exactly the replay the challenge exists to stop.
   *
   * The hostile input is real: two genuinely concurrent HTTP requests carrying
   * the same valid envelope, against a real server writing to real DataHub.
   */
  it("accepts one and refuses the other when both carry the same challenge", async () => {
    const asset = CUSTOMERS;
    const challenge = await api("/api/erasure/challenge", {
      method: "POST",
      body: JSON.stringify({ request: REQUEST, asset }),
    });
    const nonce = challenge.body.nonce as string;

    const envelope = signAttestation(
      {
        kind: "direct",
        request: REQUEST,
        asset,
        version: "snapshot-race",
        predicate: {
          identifiers: ["cust_88213"],
          expression: "customer_id = 'cust_88213'",
          columns: ["customer_id"],
        },
        scope: { kind: "whole" },
        result: "absent",
        attestor: ATTESTOR,
        signatureVerified: false,
        at: new Date().toISOString(),
        nonce,
      },
      PRIVATE_PEM,
      KEY_ID,
    );

    const body = JSON.stringify({ request: REQUEST, envelope });
    const [first, second] = await Promise.all([
      api("/api/erasure/proof", { method: "POST", body }),
      api("/api/erasure/proof", { method: "POST", body }),
    ]);

    const codes = [first.status, second.status].sort();
    expect(codes, "exactly one of the two should be accepted").toEqual([200, 422]);

    const refused = first.status === 422 ? first : second;
    expect((refused.body.failures as { kind: string }[]).map((f) => f.kind)).toContain(
      "challenge-replayed",
    );
  }, 300_000);

  it("writes each accepted attestation beside the last, never over it", async () => {
    /*
     * The ledger is append-only, and the sequence number is what makes that
     * true rather than aspirational. Two challenges answered for one asset must
     * land as two records; a shared URN would silently replace the first, and
     * the evidence chain would be a chain of one.
     */
    const before = await readAttestationsFor(REQUEST, CUSTOMERS);

    const challenge = await api("/api/erasure/challenge", {
      method: "POST",
      body: JSON.stringify({ request: REQUEST, asset: CUSTOMERS }),
    });
    const envelope = signAttestation(
      {
        kind: "direct",
        request: REQUEST,
        asset: CUSTOMERS,
        version: "snapshot-appended",
        predicate: {
          identifiers: ["cust_88213"],
          expression: "customer_id = 'cust_88213'",
          columns: ["customer_id"],
        },
        scope: { kind: "whole" },
        result: "absent",
        attestor: ATTESTOR,
        signatureVerified: false,
        at: new Date().toISOString(),
        nonce: challenge.body.nonce as string,
      },
      PRIVATE_PEM,
      KEY_ID,
    );

    const accepted = await api("/api/erasure/proof", {
      method: "POST",
      body: JSON.stringify({ request: REQUEST, envelope }),
    });
    expect(accepted.status).toBe(200);

    const after = await readAttestationsFor(REQUEST, CUSTOMERS);
    expect(after.length).toBe(before.length + 1);
    // The earlier record is byte-identical, not merely present.
    expect(after[0].body).toBe(before[0].body);
  }, 300_000);
});

describe("a compaction that rewrote an asset from its own prior version", () => {
  /*
   * The churn the self-rebuild rule exists for, exercised end to end.
   *
   * `CUSTOMERS` is a source table: DataHub records no upstream lineage for it,
   * so an ordinary rebuild attestation is refused with `no-recorded-lineage` —
   * there is nothing to cross-check a declared input set against. That makes it
   * the sharpest demonstration available on this catalog: without the carve-out
   * every compaction of a source table is permanently unattestable, and the
   * asset falls back to unattested every time the warehouse tidies its files.
   *
   * The rule is in `docs/erasure-coverage.md` under "Self-rebuild", written
   * before this test and before the kernel change.
   */
  it("carries coverage to the new version, and refuses one built on an unattested version", async () => {
    // What stands right now, read rather than assumed: the tests above have
    // added attestations over time and the newest names the current version.
    const before = await api(`/api/erasure/${REQUEST}`, { method: "GET" });
    const standing = rowFor(before.body, CUSTOMERS);
    expect(standing?.state).toBe("ATTESTED");
    const attestedVersion = standing?.version as string;
    expect(attestedVersion).toBeTruthy();

    const compacted = `${attestedVersion}-compacted`;

    const challenge = await api("/api/erasure/challenge", {
      method: "POST",
      body: JSON.stringify({ request: REQUEST, asset: CUSTOMERS }),
    });
    expect(challenge.status).toBe(200);

    const signed = signAttestation(
      {
        kind: "rebuild",
        request: REQUEST,
        asset: CUSTOMERS,
        version: compacted,
        materialization: "full",
        soleProducer: true,
        // The whole claim: nothing entered this version except the version that
        // was already attested. No new rows, no other table.
        inputs: [{ asset: CUSTOMERS, version: attestedVersion }],
        attestor: ATTESTOR,
        signatureVerified: false,
        at: new Date().toISOString(),
        nonce: challenge.body.nonce as string,
      },
      PRIVATE_PEM,
      KEY_ID,
    );

    const accepted = await api("/api/erasure/proof", {
      method: "POST",
      body: JSON.stringify({ request: REQUEST, envelope: signed }),
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.accepted).toBe(true);

    const report = accepted.body.report as Record<string, unknown>;
    const row = rowFor(report, CUSTOMERS);
    // The version moved, and the coverage came with it.
    expect(row?.version).toBe(compacted);
    expect(row?.state).toBe("ATTESTED");
    expect(row?.explanation).not.toContain("proven");

    /*
     * And the other half, which is what stops the carve-out being a hole: a
     * second compaction declaring a version nobody ever attested inherits
     * nothing, however well signed it is.
     */
    const nextChallenge = await api("/api/erasure/challenge", {
      method: "POST",
      body: JSON.stringify({ request: REQUEST, asset: CUSTOMERS }),
    });
    const ungrounded = signAttestation(
      {
        kind: "rebuild",
        request: REQUEST,
        asset: CUSTOMERS,
        version: `${compacted}-again`,
        materialization: "full",
        soleProducer: true,
        inputs: [{ asset: CUSTOMERS, version: "a-version-nobody-attested" }],
        attestor: ATTESTOR,
        signatureVerified: false,
        at: new Date().toISOString(),
        nonce: nextChallenge.body.nonce as string,
      },
      PRIVATE_PEM,
      KEY_ID,
    );

    const refused = await api("/api/erasure/proof", {
      method: "POST",
      body: JSON.stringify({ request: REQUEST, envelope: ungrounded }),
    });
    // The signature is real, so the record is accepted into the ledger; what
    // fails is the coverage it claims, which is the kernel's decision.
    expect(refused.status).toBe(200);
    const after = rowFor(refused.body.report as Record<string, unknown>, CUSTOMERS);
    expect(after?.state).toBe("UNPROVEN");
    expect(after?.explanation).toContain("rewritten from its own version");
  }, 300_000);
});

describe("the evidence bundle, checked by a process that is not obsel", () => {
  /*
   * The server stamps `signatureVerified: true` on every ledger record it reads
   * and never redoes the arithmetic — `erasure-engine.ts` says so at
   * `attestationOf` rather than implying it. So the report obsel serves is
   * obsel's word, and the only thing that tests that boundary is somebody
   * outside the process redoing it from the bytes.
   *
   * Here that somebody is a bare `node` on `scripts/verify-erasure-evidence.mjs`,
   * over a bundle this server produced, after every attestation the tests above
   * really signed and really submitted. No build, no install, no import into the
   * test's own process.
   */
  const workspace = mkdtempSync(join(tmpdir(), "obsel-live-evidence-"));
  const script = new URL("../../scripts/verify-erasure-evidence.mjs", import.meta.url).pathname;

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function runVerifier(bundle: unknown, name: string): { code: number; stdout: string } {
    const path = join(workspace, name);
    writeFileSync(path, JSON.stringify(bundle, null, 2));
    const run = spawnSync(process.execPath, [script, path], {
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    return { code: run.status ?? -1, stdout: run.stdout ?? "" };
  }

  it("refuses the bundle to an unauthenticated caller, unlike the report beside it", async () => {
    /*
     * The report carries no identifiers because obsel builds it and can leave
     * them out. A bundle carries DSSE payloads, and a direct attestation's
     * payload holds the predicate its attestor executed. Those bytes are what
     * the signature covers, so obsel cannot redact them and still hand over
     * something checkable.
     */
    const open = await fetch(`${server.url}/api/erasure/${REQUEST}/evidence`, {
      signal: AbortSignal.timeout(60_000),
    });
    expect(open.status).toBe(401);

    const gated = await api(`/api/erasure/${REQUEST}/evidence`, { method: "GET" });
    expect(gated.status).toBe(200);
  }, 300_000);

  it("verifies, and agrees with the live server asset by asset", async () => {
    const report = await api(`/api/erasure/${REQUEST}`, { method: "GET" });
    expect(report.status).toBe(200);
    const evidence = await api(`/api/erasure/${REQUEST}/evidence`, { method: "GET" });
    expect(evidence.status).toBe(200);

    const run = runVerifier(evidence.body, "live.json");
    expect(run.code, run.stdout).toBe(0);

    // Number for number against what the server said, from a process that read
    // no DataHub and trusted no field of obsel's answer.
    const summary = report.body.summary as Record<string, number>;
    const counted =
      /recomputed\s+(\d+) of (\d+) assets covered, (\d+) unattested, (\d+) contradicted/.exec(
        run.stdout,
      );
    expect(counted, run.stdout).not.toBeNull();
    expect(counted!.slice(1).map(Number)).toEqual([
      summary.attested,
      summary.total,
      summary.unproven,
      summary.contradicted,
    ]);

    /*
     * And row by row, which is what pins the ten-line `currentVersion` rule the
     * script restates against `versionOf` in `erasure-engine.ts`. The two live in
     * different files because one of them is `server-only`; a reading of both is
     * not evidence that they agree, and this is.
     */
    for (const row of report.body.coverage as CoverageRow[]) {
      expect(run.stdout, `state for ${row.asset}`).toContain(
        `${row.state.padEnd(12)} ${row.asset}`,
      );
      expect(run.stdout, `version for ${row.asset}`).toContain(`version ${row.version}`);
    }
  }, 300_000);

  it("refuses the same bundle with one byte of one signed payload moved", async () => {
    const evidence = await api(`/api/erasure/${REQUEST}/evidence`, { method: "GET" });
    const bundle = JSON.parse(JSON.stringify(evidence.body)) as {
      attestations: { body: { envelope: { payload: string } } }[];
    };
    expect(bundle.attestations.length).toBeGreaterThan(0);

    // The attestor's name, one letter different. Everything else about the
    // record is untouched: it still answers its own challenge, still names an
    // asset the key is scoped for, still parses.
    const envelope = bundle.attestations[0].body.envelope;
    const decoded = Buffer.from(envelope.payload, "base64").toString("utf8");
    envelope.payload = Buffer.from(decoded.replace(ATTESTOR, `${ATTESTOR}x`), "utf8").toString(
      "base64",
    );

    const run = runVerifier(bundle, "tampered.json");
    expect(run.code, run.stdout).not.toBe(0);
    expect(run.stdout).toContain("bad-signature");
    expect(run.stdout).toContain("FAILED");
  }, 300_000);
});

describe("an envelope issued for one request, submitted to another", () => {
  it("is refused, and nothing about the other request's answer moves", async () => {
    /*
     * Everything about this envelope is genuine: obsel issued the challenge,
     * the attestor holds a registered key scoped for the asset, and the record
     * answers the challenge it was given. What is wrong is only the request it
     * was POSTed against. `verifyAttestation` holds the challenge and the record
     * to each other and cannot see that, so without a check at the submission
     * boundary the record is appended to the first request's own bucket, where
     * `buildReport` reads it back and takes the version the whole answer is
     * computed against from a record the first request has no evidence about.
     */
    const other = `${REQUEST}-second`;
    const opened = await api("/api/erasure", {
      method: "POST",
      body: JSON.stringify({
        request: other,
        identifiers: ["cust_88213"],
        seeds: [CUSTOMERS],
        hops: 1,
      }),
    });
    expect(opened.status).toBe(200);

    const challenge = await api("/api/erasure/challenge", {
      method: "POST",
      body: JSON.stringify({ request: other, asset: CUSTOMERS }),
    });
    expect(challenge.status).toBe(200);

    const signed = signAttestation(
      {
        kind: "direct",
        request: other,
        asset: CUSTOMERS,
        version: "snapshot-foreign",
        predicate: {
          identifiers: ["cust_88213"],
          expression: "customer_id = 'cust_88213'",
          columns: ["customer_id"],
        },
        scope: { kind: "whole" },
        result: "absent",
        attestor: ATTESTOR,
        signatureVerified: false,
        at: new Date().toISOString(),
        nonce: challenge.body.nonce as string,
      },
      PRIVATE_PEM,
      KEY_ID,
    );

    const before = await readAttestationsFor(REQUEST, CUSTOMERS);

    const refused = await api("/api/erasure/proof", {
      method: "POST",
      body: JSON.stringify({ request: REQUEST, envelope: signed }),
    });
    expect(refused.status).toBe(422);
    const failures = refused.body.failures as { kind: string }[];
    expect(failures.map((entry) => entry.kind)).toContain("request-mismatch");

    // The ledger is append-only, so this is the assertion that matters: a
    // record refused here can never be taken back out.
    const after = await readAttestationsFor(REQUEST, CUSTOMERS);
    expect(after.length).toBe(before.length);

    const status = await api(`/api/erasure/${REQUEST}`, { method: "GET" });
    expect(rowFor(status.body, CUSTOMERS)?.version).not.toBe("snapshot-foreign");
  }, 300_000);
});

describe("an asset with more records than any reader's ceiling", () => {
  /*
   * The volume a compacting estate reaches on one table. The attestation walk
   * used to stop at twenty-five records, and the write position was taken from
   * the length of that walk, so record 26 was written and record 27 landed on
   * the same urn and replaced it. The report and the spent-nonce check both read
   * that walk, so neither could see what had been lost.
   *
   * Written straight into the ledger rather than through twenty-six signed
   * submissions: the subject is the walk and the write, and the signing path
   * either side of it is covered by the tests above. The asset is a scratch urn
   * no lineage reaches, so these records are never parsed into a report.
   */
  const SCRATCH = `urn:li:dataset:(${SNOWFLAKE},b2fd91.ledger_depth.scratch_${Date.now()},PROD)`;

  it("reads back every record past the former ceiling", async () => {
    const { attestationUrn, writeLedgerRecord } = await import("@/src/server/datahub/documents");

    for (let sequence = 1; sequence <= 26; sequence += 1) {
      await writeLedgerRecord({
        id: attestationUrn(REQUEST, SCRATCH, sequence).split("obsel.attestation.")[1],
        kind: "attestation",
        request: REQUEST,
        at: new Date().toISOString(),
        body: JSON.stringify({ nonce: `depth-${sequence}` }),
        assets: [SCRATCH],
      });
    }

    const found = await readAttestationsFor(REQUEST, SCRATCH);
    expect(found.length).toBe(26);
    // Record 26 specifically: the first one the old ceiling hid, and the one
    // the next submission used to overwrite.
    expect(JSON.parse(found[25].body).nonce).toBe("depth-26");
  }, 300_000);

  it("refuses a second write onto a urn the ledger already holds", async () => {
    const { attestationUrn, writeLedgerRecord } = await import("@/src/server/datahub/documents");
    const { DataHubError } = await import("@/src/server/datahub/errors");

    const id = attestationUrn(REQUEST, SCRATCH, 26).split("obsel.attestation.")[1];
    await expect(
      writeLedgerRecord({
        id,
        kind: "attestation",
        request: REQUEST,
        at: new Date().toISOString(),
        body: JSON.stringify({ nonce: "would-have-overwritten-26" }),
        assets: [SCRATCH],
      }),
    ).rejects.toBeInstanceOf(DataHubError);

    // Refused, and record 26 is the one it always was rather than merely present.
    const found = await readAttestationsFor(REQUEST, SCRATCH);
    expect(JSON.parse(found[25].body).nonce).toBe("depth-26");
  }, 300_000);

  it("lands the next accepted submission above the whole ledger", async () => {
    const { nextAttestationSequence } = await import("@/src/server/datahub/documents");
    expect(await nextAttestationSequence(REQUEST, SCRATCH)).toBe(27);
  }, 300_000);
});

describe("a key reported compromised takes its coverage back", () => {
  it("returns the asset to unattested, with no data having changed", async () => {
    /*
     * The one way coverage is lost that involves nobody touching any data, so
     * nothing else in obsel would ever notice it. The ledger is untouched, the
     * attestation is still there and still verifies against the bytes it
     * covers; what changed is that obsel has been told the key was in someone
     * else's hands.
     *
     * Restarted rather than reconfigured live, because the registry is read at
     * startup and there is deliberately no route that edits it: an endpoint
     * that registers keys is an endpoint that mints attestations.
     */
    await server.stop();
    server = await startObsel(PORT, FLOW_ID, {
      OBSEL_API_TOKEN: TOKEN,
      OBSEL_ATTESTOR_KEYS: registry({ state: "compromised", at: new Date().toISOString() }),
    });

    const status = await api(`/api/erasure/${REQUEST}`, { method: "GET" });
    expect(status.status).toBe(200);

    const row = rowFor(status.body, CUSTOMERS);
    expect(row?.state).toBe("UNPROVEN");

    const summary = status.body.summary as Record<string, number>;
    expect(summary.attested).toBe(0);

    // And it says why, rather than quietly going gray.
    const dropped = (status.body.assurance as Record<string, unknown>)
      .attestationsDroppedForKeys as { asset: string; reason: string }[];
    // Every attestation this request holds, not a fixed number: the tests above
    // add more over time, and a compromise takes back all of them or it has not
    // understood what a compromise is.
    const recorded = await readAttestationsFor(REQUEST, CUSTOMERS);
    expect(dropped.length).toBe(recorded.length);
    expect(dropped.length).toBeGreaterThan(1);
    for (const entry of dropped) {
      expect(entry.reason).toBe("key-compromised");
      expect(entry.asset).toBe(CUSTOMERS);
    }
  }, 300_000);
});
