import "server-only";

/**
 * The IO half of erasure coverage: read the graph, read the ledger, ask
 * `erasure.ts` what is covered, write the answer down.
 *
 * Same split as `engine.ts` beside `staleness.ts`, and for the same reason:
 * every decision here is made by pure functions, so the whole of the reasoning
 * is testable without a network and cannot drift into inference. Nothing in
 * this file decides anything. It moves data and enforces order.
 *
 * **No route clears an obligation.** Coverage is derived from the ledger on
 * every read, so there is nothing to clear even in principle: an asset is
 * covered because a verified attestation says so, and it stops being covered
 * the moment that attestation stops standing. A tool that marked an asset done
 * would be a tool for silencing the one thing this product is for, which is the
 * same rule the staleness half already keeps.
 */

import { randomUUID } from "node:crypto";

import { readLineageDownstream } from "@/src/server/datahub/client";
import {
  attestationUrn,
  ledgerUrn,
  readAttestationsFor,
  readLedgerRecord,
  writeLedgerRecord,
} from "@/src/server/datahub/documents";
import {
  canonicalJson,
  invalidatedByKeys,
  verifyAttestation,
  type Challenge,
  type Envelope,
  type RegisteredKey,
  type VerificationFailure,
} from "./attestation";
import { ASSURANCE_LIMITS, coverageFor, summarize, type Attestation } from "./erasure";
import type { ErasureReport, ErasureRequest } from "./erasure-report";
import { emit } from "./trace";

/**
 * The report shapes are declared in `erasure-report.ts` and re-exported here.
 *
 * This file is `server-only`, and the dashboard has to name what the erasure
 * route returns. Every existing importer still reads them from the engine, so
 * the move is invisible to them; what it buys is that browser code can describe
 * a report without importing a module that holds DataHub credentials.
 */
export type { ErasureReport, ErasureRequest, PublishedErasureReport } from "./erasure-report";

/** How long an attestor has to answer a challenge before it stops counting. */
const CHALLENGE_TTL_MS = 15 * 60 * 1000;

/** How far downstream a request walks. Reported, never silently applied. */
const DEFAULT_HOPS = 3;

/**
 * The attestor key registry, from configuration and never from an HTTP route.
 *
 * There is deliberately no endpoint that registers a key. If anybody who can
 * reach obsel can add a key, then anybody who can reach obsel can mint
 * attestations, and every signature check in `attestation.ts` becomes theatre
 * performed for an audience of one. Registering a key is an operator action
 * taken out of band, exactly as it would be for any other trust root.
 *
 * `OBSEL_ATTESTOR_KEYS` is inline JSON or a path to a JSON file. Absent means
 * an empty registry, which means nothing verifies and every asset stays
 * unattested — the correct behaviour for an obsel that has not been told who it
 * trusts, and a loud one, because the board says so on every row.
 */
async function attestorKeys(): Promise<RegisteredKey[]> {
  const raw = process.env.OBSEL_ATTESTOR_KEYS?.trim();
  if (!raw) return [];
  const text = raw.startsWith("[")
    ? raw
    : await (await import("node:fs/promises")).readFile(raw, "utf8");
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error("OBSEL_ATTESTOR_KEYS must be a JSON array of registered keys");
  }
  return parsed as RegisteredKey[];
}

/*
 * One erasure mutation at a time, process-wide.
 *
 * A challenge is single use, and single use is only true if checking it and
 * consuming it cannot interleave with another submission doing the same. Two
 * attestors answering at once would otherwise both read the nonce unconsumed
 * and both be accepted, which is precisely the replay the challenge exists to
 * stop. `engine.ts` serialises completions for the same class of reason and
 * carries the same honest limit: this holds because obsel is one process, and
 * two obsels against one DataHub would need a lock DataHub does not offer.
 */
let mutationLock: Promise<void> = Promise.resolve();

async function serialized<T>(work: () => Promise<T>): Promise<T> {
  const previous = mutationLock;
  let release: () => void = () => {};
  mutationLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
  }
}

/**
 * Open a request: walk the graph from the seeds, and record what was found.
 *
 * Everything reached starts `UNPROVEN`, which is not a placeholder. It is the
 * honest state of an asset nobody has said anything about, and the list of them
 * is the report's most valuable output on the day it is opened.
 */
export async function openErasureRequest(input: {
  request?: string;
  identifiers: string[];
  seeds: string[];
  hops?: number;
}): Promise<ErasureReport> {
  if (input.identifiers.length === 0) {
    throw new Error("an erasure request needs at least one subject identifier");
  }
  if (input.seeds.length === 0) {
    throw new Error("an erasure request needs at least one seed asset");
  }

  const request: ErasureRequest = {
    request: input.request ?? `dsr-${randomUUID()}`,
    identifiers: [...input.identifiers].sort(),
    seeds: [...input.seeds].sort(),
    hops: input.hops ?? DEFAULT_HOPS,
    openedAt: new Date().toISOString(),
  };

  return await serialized(async () => {
    emit("read", `opening ${request.request}`, `${request.seeds.length} seed assets`);
    await writeLedgerRecord({
      id: request.request,
      kind: "request",
      request: request.request,
      at: request.openedAt,
      body: canonicalJson(request),
      assets: request.seeds,
    });
    return await buildReport(request);
  });
}

/**
 * Issue a challenge for one asset, which an attestor must bind into what it
 * signs.
 *
 * This is what makes a signature evidence about now rather than a record
 * prepared whenever it suited the signer. Without it an attestor could sign
 * "absent" the day its key was issued and produce it on demand for years.
 */
export async function issueChallenge(input: {
  request: string;
  asset: string;
}): Promise<Challenge> {
  const issuedAt = new Date();
  const challenge: Challenge = {
    nonce: randomUUID(),
    request: input.request,
    asset: input.asset,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + CHALLENGE_TTL_MS).toISOString(),
  };

  return await serialized(async () => {
    await writeLedgerRecord({
      id: challenge.nonce,
      kind: "challenge",
      request: challenge.request,
      at: challenge.issuedAt,
      body: canonicalJson(challenge),
      assets: [challenge.asset],
    });
    emit("write", `issued a challenge for ${shortAsset(input.asset)}`, "valid for 15 minutes");
    return challenge;
  });
}

export type SubmissionResult =
  { accepted: true; report: ErasureReport } | { accepted: false; failures: VerificationFailure[] };

/**
 * Take an attestation, verify it, and record it if it stands.
 *
 * The verification is `attestation.ts`'s and the coverage decision is
 * `erasure.ts`'s. What happens here is order: read the ledger, verify against
 * the challenges it holds, write the record, then recompute. A refused
 * submission writes nothing at all — not even a note that it was refused —
 * because a ledger of failed attempts is an invitation to grind at the
 * signature check until something lands, and the failures go back to the caller
 * where the attestor can act on them.
 */
export async function submitAttestation(
  envelope: Envelope,
  requestId: string,
): Promise<SubmissionResult> {
  return await serialized(async () => {
    const request = await readRequest(requestId);
    const nonce = nonceOf(envelope);
    const asset = assetOf(envelope);

    /*
     * The challenge is read by its own URN rather than looked up in a list, so
     * a nonce issued a second ago is found rather than waited for. Replay is
     * checked the same way: every attestation already recorded about this asset
     * is read back and its nonce compared. Both are direct aspect reads with no
     * index in the path.
     */
    const stored = await readLedgerRecord(ledgerUrn("challenge", nonce));
    const existing = await readAttestationsFor(requestId, asset);
    const spent = existing.some(
      (record) => (JSON.parse(record.body) as { nonce?: string }).nonce === nonce,
    );

    const challenges: Challenge[] = stored
      ? [{ ...(JSON.parse(stored.body) as Challenge), consumed: spent }]
      : [];

    const result = verifyAttestation(envelope, {
      keys: await attestorKeys(),
      challenges,
      now: new Date().toISOString(),
    });

    if (!result.ok) {
      emit("compare", "refused an attestation", result.failures.map((f) => f.kind).join(", "));
      return { accepted: false, failures: result.failures };
    }

    await writeLedgerRecord({
      id: attestationUrn(requestId, asset, existing.length + 1).split("obsel.attestation.")[1],
      kind: "attestation",
      request: requestId,
      at: result.attestation.at,
      body: canonicalJson({ envelope, keyId: result.keyId, nonce }),
      assets: [asset],
    });

    emit(
      "mark",
      `accepted an attestation for ${shortAsset(asset)}`,
      `${result.attestation.attestor}, version ${result.attestation.version}`,
    );
    return { accepted: true, report: await buildReport(request) };
  });
}

/** The current answer for a request, derived from the ledger every time. */
export async function erasureStatus(requestId: string): Promise<ErasureReport> {
  return await buildReport(await readRequest(requestId));
}

/**
 * Read the ledger and the graph, and compute the report.
 *
 * Derived on every read rather than stored, deliberately. A stored verdict
 * would keep saying "covered" after the key that signed it was reported
 * compromised, after a retraction landed, and after the asset was written
 * again — three things that change no stored field. Recomputing costs a graph
 * walk and removes an entire class of stale-green.
 */
async function buildReport(request: ErasureRequest): Promise<ErasureReport> {
  const reach = await readLineageDownstream(request.seeds, request.hops);
  const keys = await attestorKeys();

  /*
   * One direct read per reachable asset rather than one search over the whole
   * ledger. That is more calls and no index, which is the trade this design
   * wants: a search that has not caught up returns fewer attestations, and
   * fewer attestations reads as an asset nobody spoke for, which is
   * indistinguishable from a real finding.
   */
  const perAsset = await Promise.all(
    reach.reachable.map(async (asset) => ({
      asset,
      records: await readAttestationsFor(request.request, asset),
    })),
  );

  const accepted: { attestation: Attestation; keyId: string }[] = [];
  let evidenceRecords = 1; // the request record itself
  for (const entry of perAsset) {
    evidenceRecords += entry.records.length;
    for (const record of entry.records) {
      const stored = JSON.parse(record.body) as { envelope: Envelope; keyId: string };
      accepted.push({ attestation: attestationOf(stored.envelope), keyId: stored.keyId });
    }
  }

  /*
   * Key compromise is not a write, and nothing else here would notice it. Every
   * other way an asset loses coverage happens because somebody touched data; a
   * key reported compromised changes no asset and no version, so without this
   * the board keeps showing green backed by signatures nobody should trust.
   */
  const dropped = invalidatedByKeys(accepted, keys);
  const droppedSet = new Set(dropped.map((entry) => entry.attestation));
  const attestations = accepted
    .map((entry) => entry.attestation)
    .filter((attestation) => !droppedSet.has(attestation));

  const currentVersion: Record<string, string> = {};
  for (const asset of reach.reachable) {
    // Version identity is warehouse-native and obsel does not invent one. Until
    // an attestor reports the version it saw, the asset sits at an unknown
    // version, which has no attestation and is therefore unattested — the right
    // answer, reached honestly rather than by defaulting to covered.
    currentVersion[asset] = versionOf(attestations, asset) ?? "unknown";
  }

  const coverage = coverageFor({
    request: request.request,
    identifiers: request.identifiers,
    currentVersion,
    recordedUpstream: reach.upstreamOf,
    attestations,
  });

  return {
    request,
    coverage,
    summary: summarize(coverage),
    assurance: {
      hopsWalked: request.hops,
      assetsReached: reach.reachable.length,
      evidenceRecords,
      attestationsDroppedForKeys: dropped.map((entry) => ({
        asset: entry.attestation.asset,
        attestor: entry.attestation.attestor,
        reason: entry.reason.kind,
      })),
      // Spread, so the report carries its own copy rather than a reference a
      // consumer could mutate into a different set of caveats.
      limits: [...ASSURANCE_LIMITS],
    },
  };
}

/**
 * The version an attestor reported for an asset, or nothing.
 *
 * The latest one wins, because a later attestation about a later version is
 * what a re-check produces. When two attestors disagree about what version
 * stands, the newest claim is the one the report is computed against and the
 * older one simply covers a version that is no longer current — which is the
 * SUPERSEDED case the kernel already handles, arriving here rather than needing
 * a rule of its own.
 */
function versionOf(attestations: Attestation[], asset: string): string | null {
  const forAsset = attestations
    .filter((entry) => entry.asset === asset)
    .sort((a, b) => a.at.localeCompare(b.at));
  return forAsset.length > 0 ? forAsset[forAsset.length - 1].version : null;
}

function attestationOf(envelope: Envelope): Attestation {
  const record = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as Record<
    string,
    unknown
  >;
  // Marked verified because it is only ever written to the ledger after
  // `verifyAttestation` accepted it. Re-verifying on read would be better and
  // is what a hostile-storage model would demand; it is not done here, and that
  // is stated rather than implied: the ledger is trusted storage in this design.
  return { ...(record as unknown as Attestation), signatureVerified: true };
}

function nonceOf(envelope: Envelope): string {
  const record = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as {
    nonce?: string;
  };
  return record.nonce ?? "no-nonce";
}

/** The request record, read by its own URN. No search, so no index lag. */
async function readRequest(requestId: string): Promise<ErasureRequest> {
  const found = await readLedgerRecord(ledgerUrn("request", requestId));
  if (!found) throw new Error(`no erasure request ${requestId} in the ledger`);
  return JSON.parse(found.body) as ErasureRequest;
}

function assetOf(envelope: Envelope): string {
  const record = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as {
    asset?: string;
  };
  return record.asset ?? "";
}

function shortAsset(urn: string): string {
  const parts = urn.split(",");
  const path = parts.length > 1 ? parts[1] : urn;
  const segments = path.split(".");
  return segments[segments.length - 1].replace(/_/g, " ");
}
