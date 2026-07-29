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

import { generateKeyPairSync } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireDataHub } from "./reachable";
import { startObsel, type ObselServer } from "./obsel-server";

const { signAttestation } = await import("@/src/server/coordinator/attestation");
const { readAttestationsFor } = await import("@/src/server/datahub/documents");

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

  it("does not echo the subject's identifiers back in the report", async () => {
    /*
     * Handing the subject key to everyone who reads the report would create
     * fresh copies of the identifier in the act of accounting for its removal,
     * which is an Article 5(1)(c) minimisation problem of obsel's own making.
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

    // And it says why, rather than quietly going grey.
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
