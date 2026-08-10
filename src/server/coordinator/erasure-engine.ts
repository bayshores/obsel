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

import { createHash, randomUUID } from "node:crypto";

import { readLineageDownstream } from "@/src/server/datahub/client";
import {
  attestationUrn,
  ledgerUrn,
  nextAttestationSequence,
  readAttestationsFor,
  readLedgerRecord,
  writeLedgerRecord,
  type LedgerRecord,
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
 * unattested — the correct behavior for an obsel that has not been told who it
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
 * stop. `engine.ts` serializes completions for the same class of reason and
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
 * A request id that has already been opened, refused rather than rewritten.
 *
 * Carries the status the route answers with, so the sentence and its code are
 * decided in one place instead of the route inventing a second wording.
 */
export class RequestAlreadyOpen extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "RequestAlreadyOpen";
  }
}

/**
 * Refuse a request id the ledger already holds a record for.
 *
 * The write path is an upsert: `writeLedgerRecord` POSTs `documentInfo` to
 * DataHub, which replaces the aspect at that URN. So a second open under the
 * same id would silently replace the identifiers, seeds, hops and opened time
 * of the first, while the attestations written under that id stay where they
 * are. Every one of them answered a challenge issued against the question that
 * was just overwritten, and the report and the evidence bundle would present
 * the new question beside them with nothing to show that the old one existed.
 * The ledger is append-only, and this is the read that keeps the request record
 * inside that rule.
 *
 * Pure, so the decision is tested without a network. The read that produces
 * `existing` is the caller's, and it happens under the mutation lock so two
 * opens of one id cannot both see nothing.
 */
export function refuseReopen(id: string, existing: LedgerRecord | null): void {
  if (existing === null) return;
  throw new RequestAlreadyOpen(
    `erasure request ${id} was already opened at ${existing.at}. A request record is written ` +
      `once and never rewritten, so this open would replace the question the attestations ` +
      `already in the ledger answered. The existing record stands. Open a new request under a ` +
      `different id, or read ${id} as it is.`,
  );
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
    // Read before write, and inside the lock. The URN is derived, never
    // searched for, so a record written a moment ago is visible here.
    refuseReopen(request.request, await readLedgerRecord(ledgerUrn("request", request.request)));
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
    /*
     * The record must name the request it was submitted to, checked before the
     * ledger is touched.
     *
     * `verifyAttestation` holds the challenge and the record to each other, and
     * that is a different pair: an envelope legitimately issued, signed and
     * bound for request R2 passes every one of those checks when it is POSTed
     * against R1. It would then be written into R1's own append-only bucket,
     * where `buildReport` reads it back and hands it to `versionOf`, which
     * looks at the asset and not at the request — so a record R1 has no
     * evidence about would set the version R1's answer is computed against.
     * The kernel filters by request and so cannot be made to attest from it,
     * but the version it is asked about is chosen before it runs.
     *
     * Refused rather than filtered out later: nothing that names another
     * request belongs in this one's ledger, and a refusal is the reversible
     * answer.
     */
    const named = requestOf(envelope);
    if (named !== null && named !== requestId) {
      emit("compare", "refused an attestation", "request-mismatch");
      return {
        accepted: false,
        failures: [
          { kind: "request-mismatch" as const, submittedFor: requestId, recordNames: named },
        ],
      };
    }

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

    /*
     * The sequence is counted to the end of the ledger, never taken from the
     * length of a bounded read. `existing` is unbounded now and would give the
     * same answer, but tying the write's position to whatever the reader
     * happened to return is how records 26 and up came to overwrite each other,
     * so the position is asked for on its own terms.
     */
    const sequence = await nextAttestationSequence(requestId, asset);
    await writeLedgerRecord({
      id: attestationUrn(requestId, asset, sequence).split("obsel.attestation.")[1],
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
 * Everything an outside party needs to re-derive this request's answer without
 * obsel, without DataHub, and without trusting either.
 *
 * The report obsel serves is a claim by obsel. `buildReport` above stamps
 * `signatureVerified: true` on every ledger record it reads, because the record
 * only got into the ledger by passing `verifyAttestation` once — see
 * `attestationOf`, which says so rather than implying it. A reader who wants
 * that boundary checked rather than asserted has to redo the arithmetic on the
 * bytes, and this is what they need to do it: the envelopes as they were signed,
 * the registry obsel was told to trust, the challenges obsel issued, and the
 * lineage the closure check was made against.
 *
 * `report` carries obsel's own answer alongside the evidence, so the two can be
 * compared rather than merely coexisting. `scripts/verify-erasure-evidence.mjs`
 * recomputes coverage from the evidence fields only and reports any asset where
 * the two disagree. The claim is read BEFORE the evidence, deliberately: an
 * attestation landing between the two reads leaves the bundle carrying more
 * evidence than the claim was built from, which the verifier reports as a
 * disagreement. That is a false alarm, and a false alarm is the direction this
 * race is allowed to fail in.
 *
 * **The subject's identifiers are not in here, and one part of them cannot be
 * taken out.** `request.identifiers` is replaced by SHA-256 digests, which is
 * everything the kernel's predicate check needs — it asks only whether each
 * identifier the request covers was searched for, which is set membership and
 * survives digesting. What obsel cannot redact is the `predicate` inside a
 * direct attestation: those bytes are what the attestor signed, and changing
 * them destroys the signature this bundle exists to have checked. So a bundle is
 * evidence handed to a named recipient, not a publication, which is why the
 * route serving it is gated.
 */
export interface EvidenceBundle {
  formatVersion: 1;
  capturedAt: string;
  request: Omit<ErasureRequest, "identifiers"> & {
    /** SHA-256 hex of each subject identifier, sorted. Never the identifiers. */
    identifierDigests: string[];
  };
  reachable: string[];
  upstreamOf: Record<string, string[]>;
  /** Public material only: the registry as `attestation.ts` reads it. */
  keys: RegisteredKey[];
  /** Every challenge answered by a record below, as it was issued. */
  challenges: Challenge[];
  attestations: {
    asset: string;
    /** Position in this asset's append-only ledger, from 1. */
    sequence: number;
    at: string;
    body: { envelope: Envelope; keyId: string; nonce: string };
  }[];
  /** obsel's own answer, to be compared against a recomputation, never used as one. */
  report: {
    summary: ErasureReport["summary"];
    coverage: { asset: string; version: string; state: string }[];
    attestationsDroppedForKeys: ErasureReport["assurance"]["attestationsDroppedForKeys"];
  };
}

export async function erasureEvidence(requestId: string): Promise<EvidenceBundle> {
  const request = await readRequest(requestId);
  const report = await buildReport(request);
  const reach = await readLineageDownstream(request.seeds, request.hops);

  const attestations: EvidenceBundle["attestations"] = [];
  const challenges: Challenge[] = [];
  const answered = new Set<string>();

  for (const asset of reach.reachable) {
    const records = await readAttestationsFor(request.request, asset);
    for (const [index, record] of records.entries()) {
      const body = JSON.parse(record.body) as EvidenceBundle["attestations"][number]["body"];
      attestations.push({ asset, sequence: index + 1, at: record.at, body });

      // Read by a URN derived from the nonce the record carries, never searched
      // for. A challenge a lagging index failed to return would read to the
      // verifier as `unknown-challenge`, which is indistinguishable from an
      // attestation answering a question obsel never asked.
      if (answered.has(body.nonce)) continue;
      answered.add(body.nonce);
      const issued = await readLedgerRecord(ledgerUrn("challenge", body.nonce));
      if (issued) challenges.push(JSON.parse(issued.body) as Challenge);
    }
  }

  return {
    formatVersion: 1,
    capturedAt: new Date().toISOString(),
    request: {
      request: request.request,
      seeds: request.seeds,
      hops: request.hops,
      openedAt: request.openedAt,
      identifierDigests: request.identifiers
        .map((identifier) => createHash("sha256").update(identifier, "utf8").digest("hex"))
        .sort(),
    },
    reachable: reach.reachable,
    upstreamOf: reach.upstreamOf,
    // Projected field by field rather than passed through. `OBSEL_ATTESTOR_KEYS`
    // is an operator's file and may carry whatever else that operator put in it;
    // a registry with a private key beside the public one would otherwise be
    // copied verbatim into a bundle meant to be handed to somebody.
    keys: (await attestorKeys()).map((key) => ({
      keyId: key.keyId,
      attestor: key.attestor,
      publicKeyPem: key.publicKeyPem,
      notBefore: key.notBefore,
      status: key.status,
      scope: key.scope,
    })),
    challenges,
    attestations,
    report: {
      summary: report.summary,
      coverage: report.coverage.map((row) => ({
        asset: row.asset,
        version: row.version,
        state: row.state,
      })),
      attestationsDroppedForKeys: report.assurance.attestationsDroppedForKeys,
    },
  };
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

/**
 * The request the signed payload names, or null when the payload does not carry
 * a readable one.
 *
 * Null rather than a thrown error or an empty string: a payload that is not
 * JSON, or that has no `request` field, is a malformed envelope, and
 * `verifyAttestation` says so in those words a few lines below. Answering it
 * here with a request mismatch would name the wrong problem.
 */
function requestOf(envelope: Envelope): string | null {
  try {
    const record = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as {
      request?: unknown;
    };
    return typeof record.request === "string" ? record.request : null;
  } catch {
    return null;
  }
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
