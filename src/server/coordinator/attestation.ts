/**
 * Signing and verifying the records the erasure kernel reasons about.
 *
 * `erasure.ts` refuses any attestation whose `signatureVerified` is false, and
 * this module is the only thing entitled to set it true. Everything the tool
 * says to a regulator rests on that boundary, so the checks here are the
 * product rather than plumbing for it.
 *
 * **Nothing here is invented where a standard exists.** The signed bytes are
 * DSSE's Pre-Authentication Encoding, which is the format in-toto and Sigstore
 * sign, and it is used because a hand-rolled "concatenate the fields" scheme is
 * where signature schemes go wrong: two different records that serialise to the
 * same bytes let one signature stand for the other. PAE length-prefixes each
 * field, so no record can be confused with another.
 *
 * Pure and deterministic. `node:crypto` does the arithmetic, and there is no
 * network, no clock of its own — `now` is passed in — and no model call.
 *
 * Four things must all hold before a record counts, and they fail separately so
 * the report can say which one:
 *
 * - the signature verifies over the canonical bytes,
 * - the key was usable, and has not since been reported compromised,
 * - the attestor is allowed to speak for that asset,
 * - the challenge obsel issued was fresh, unexpired, and never used before.
 *
 * The last one is the only defence against a record signed long ago and held.
 * Without it, an attestor could sign "absent" the day the key was issued and
 * hand it over whenever asked.
 */

import { createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";

import type { Attestation } from "./erasure";

/** Identifies what the signed payload is, so a signature cannot be reused elsewhere. */
export const PAYLOAD_TYPE = "application/vnd.obsel.attestation+json";

/**
 * A DSSE envelope, in the shape the standard defines.
 *
 * `payload` is base64 of the canonical JSON, not the JSON itself. That matters:
 * a verifier must check the signature over the bytes it received, never over
 * bytes it re-serialised, because any difference in re-serialisation silently
 * changes what was verified.
 */
export interface Envelope {
  payloadType: string;
  /** base64 of the canonical JSON payload. */
  payload: string;
  signatures: { keyid: string; sig: string }[];
}

/** Why a key can no longer be used, and how far back that reaches. */
export type KeyStatus =
  /** Usable. */
  | { state: "active" }
  /**
   * Rotated out cleanly. Signatures made while it was active still stand,
   * because nothing suggests anyone else could produce them.
   */
  | { state: "retired"; at: string }
  /**
   * Known or suspected to be in someone else's hands. **Retroactive**: every
   * signature by this key falls, whenever it was made, because the whole point
   * of a compromise is that the timeline cannot be trusted.
   *
   * This is the same shape as RETRACTED against SUPERSEDED in the kernel, and
   * for the same reason: two withdrawals that look identical in a ledger and
   * mean opposite things must not share one code path.
   */
  | { state: "compromised"; at: string };

export interface RegisteredKey {
  keyId: string;
  /** The identity this key speaks as. Must match the record's `attestor`. */
  attestor: string;
  /** SPKI PEM. Ed25519 only: one curve, no negotiation, no downgrade. */
  publicKeyPem: string;
  notBefore: string;
  status: KeyStatus;
  /**
   * Which assets this attestor may speak for.
   *
   * A warehouse team's adapter has no business attesting about a looker
   * dashboard it cannot see, and without this any registered key could cover
   * the entire estate. Entries are exact URNs, or a prefix ending in `*`.
   */
  scope: string[];
}

/**
 * A one-time value obsel issues before an attestor goes and looks.
 *
 * Bound into the signed payload, so the signature proves the attestor answered
 * THIS question at a time obsel chose, rather than replaying an answer it
 * prepared earlier. Single-use, so the same envelope cannot be submitted twice
 * to cover two versions.
 */
export interface Challenge {
  nonce: string;
  request: string;
  asset: string;
  issuedAt: string;
  expiresAt: string;
  /** Set once an envelope has consumed it. A second use is a replay. */
  consumed?: boolean;
}

/** The record an attestor signs: the attestation, plus the challenge it answers. */
export type SignedRecord = Attestation & { nonce: string };

export type VerificationFailure =
  | { kind: "malformed-envelope"; detail: string }
  | { kind: "unknown-key"; keyId: string }
  | { kind: "bad-signature"; keyId: string }
  | { kind: "key-not-yet-valid"; keyId: string; notBefore: string }
  | { kind: "key-retired-before-signing"; keyId: string; retiredAt: string }
  | { kind: "key-compromised"; keyId: string; at: string }
  | { kind: "attestor-mismatch"; claimed: string; keyBelongsTo: string }
  | { kind: "out-of-scope"; attestor: string; asset: string }
  | { kind: "unknown-challenge"; nonce: string }
  | { kind: "challenge-expired"; nonce: string; expiredAt: string }
  | { kind: "challenge-replayed"; nonce: string }
  | { kind: "challenge-mismatch"; detail: string };

export type VerificationResult =
  | { ok: true; attestation: Attestation; keyId: string }
  | { ok: false; failures: VerificationFailure[] };

/** What verification needs, all of it passed in rather than reached for. */
export interface VerificationContext {
  keys: RegisteredKey[];
  challenges: Challenge[];
  /** ISO timestamp. Passed in so verification is deterministic and testable. */
  now: string;
}

/**
 * Canonical JSON: sorted keys, no insignificant whitespace, recursively.
 *
 * A signature covers bytes, so two encoders that disagree by one space produce
 * a record that verifies on one machine and not on another. This is the subset
 * of RFC 8785 the payload needs, and it refuses everything it cannot encode
 * unambiguously rather than guessing: `undefined` inside an object is dropped
 * by `JSON.stringify` without complaint, which would let a field vanish between
 * signing and verifying, and a non-finite number encodes as `null`, which would
 * make two different records identical.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`cannot canonicalise ${String(value)}: it would encode as null`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((name) => record[name] !== undefined)
      .sort();
    return `{${keys.map((name) => `${JSON.stringify(name)}:${canonicalJson(record[name])}`).join(",")}}`;
  }
  throw new Error(`cannot canonicalise a value of type ${typeof value}`);
}

/**
 * DSSE Pre-Authentication Encoding.
 *
 * `DSSEv1 <len(type)> <type> <len(payload)> <payload>`, lengths in ASCII
 * decimal over BYTES rather than characters. The length prefixes are the whole
 * point: without them, a payload type ending in a digit and a payload beginning
 * with one could be re-split into a different pair that signs identically.
 */
export function pae(payloadType: string, payload: Buffer): Buffer {
  const type = Buffer.from(payloadType, "utf8");
  return Buffer.concat([
    Buffer.from("DSSEv1 ", "utf8"),
    Buffer.from(String(type.length), "utf8"),
    Buffer.from(" ", "utf8"),
    type,
    Buffer.from(" ", "utf8"),
    Buffer.from(String(payload.length), "utf8"),
    Buffer.from(" ", "utf8"),
    payload,
  ]);
}

/** The exact bytes an attestor signs and a verifier checks. One definition, both sides. */
export function signingBytes(payload: Buffer): Buffer {
  return pae(PAYLOAD_TYPE, payload);
}

/**
 * Sign a record, as an attestor's adapter would.
 *
 * Shipped rather than left to each attestor, because "produce the canonical
 * bytes yourself" is an invitation for one implementation to disagree with the
 * verifier about a space.
 */
export function signAttestation(
  record: SignedRecord,
  privateKeyPem: string,
  keyId: string,
): Envelope {
  const payload = Buffer.from(canonicalJson(record), "utf8");
  const sig = cryptoSign(null, signingBytes(payload), privateKeyPem);
  return {
    payloadType: PAYLOAD_TYPE,
    payload: payload.toString("base64"),
    signatures: [{ keyid: keyId, sig: sig.toString("base64") }],
  };
}

/**
 * Verify one envelope against the registry and the outstanding challenges.
 *
 * Every failure is collected rather than returned at the first one, so an
 * attestor fixing a submission is told everything wrong with it instead of
 * discovering the problems one round trip at a time. The result is still a
 * refusal unless the list is empty.
 *
 * **Does not consume the challenge.** Deciding and recording are separated
 * deliberately: a verification that marked the nonce used would burn it on a
 * failed submission, and the attestor would then be unable to retry a record it
 * had merely mis-signed. `consumeChallenge` is called by the caller after a
 * successful verification, and is where single-use is enforced for real.
 */
export function verifyAttestation(
  envelope: Envelope,
  context: VerificationContext,
): VerificationResult {
  const failures: VerificationFailure[] = [];

  if (envelope.payloadType !== PAYLOAD_TYPE) {
    return {
      ok: false,
      failures: [
        {
          kind: "malformed-envelope",
          detail: `payloadType is ${envelope.payloadType}, expected ${PAYLOAD_TYPE}`,
        },
      ],
    };
  }
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length !== 1) {
    return {
      ok: false,
      failures: [
        {
          kind: "malformed-envelope",
          detail: "exactly one signature is required; obsel does not resolve a quorum",
        },
      ],
    };
  }

  const payload = Buffer.from(envelope.payload, "base64");
  let record: SignedRecord;
  try {
    record = JSON.parse(payload.toString("utf8")) as SignedRecord;
  } catch (cause) {
    return {
      ok: false,
      failures: [
        {
          kind: "malformed-envelope",
          detail: `payload is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        },
      ],
    };
  }

  /*
   * The payload's shape is checked before any of its fields are used.
   *
   * Found by feeding an empty object through the real HTTP route: `{}` parses
   * fine, and the first check that reached for a field it did not have threw,
   * so a malformed submission came back a 500 instead of a refusal. A crash in
   * a verification path is the wrong failure in two ways — the caller learns
   * nothing about what was wrong, and unvalidated input has already travelled
   * further into the check than it should. Anything that is not shaped like a
   * record is refused here, before the key is even looked up.
   */
  const shapeProblem = describeShapeProblem(record);
  if (shapeProblem) {
    return { ok: false, failures: [{ kind: "malformed-envelope", detail: shapeProblem }] };
  }

  const { keyid, sig } = envelope.signatures[0];
  const key = context.keys.find((entry) => entry.keyId === keyid);
  if (!key) {
    return { ok: false, failures: [{ kind: "unknown-key", keyId: keyid }] };
  }

  /*
   * Verified over the bytes that ARRIVED, never over a re-serialisation of the
   * parsed record. Re-encoding before verifying is the classic way to end up
   * checking a signature over something other than what was signed, and it
   * would defeat the canonical encoder entirely.
   */
  let signatureValid = false;
  try {
    signatureValid = cryptoVerify(
      null,
      signingBytes(payload),
      createPublicKey(key.publicKeyPem),
      Buffer.from(sig, "base64"),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) failures.push({ kind: "bad-signature", keyId: keyid });

  failures.push(...keyUsable(key, record.at, context.now));

  if (record.attestor !== key.attestor) {
    failures.push({
      kind: "attestor-mismatch",
      claimed: record.attestor,
      keyBelongsTo: key.attestor,
    });
  }

  if (!inScope(key.scope, record.asset)) {
    failures.push({ kind: "out-of-scope", attestor: key.attestor, asset: record.asset });
  }

  failures.push(...challengeUsable(record, context));

  if (failures.length > 0) return { ok: false, failures };

  // `nonce` is stripped: it was the binding, not part of what is being claimed,
  // and leaving it on the attestation would put a one-time secret into the
  // ledger the report is built from.
  const attestation = { ...record } as Partial<SignedRecord>;
  delete attestation.nonce;
  return {
    ok: true,
    keyId: key.keyId,
    attestation: { ...(attestation as Attestation), signatureVerified: true },
  };
}

/**
 * What is missing or wrong about a parsed payload, or null if it is usable.
 *
 * Only the fields every later check reads unconditionally. This is not schema
 * validation and does not try to be: the point is that no check further down
 * can be handed something it will crash on, so each one gets to make its own
 * decision and report it.
 */
function describeShapeProblem(record: SignedRecord): string | null {
  // Typed as a record by the parse above and deliberately re-examined as
  // unknown here, because what actually arrived is whatever the caller sent.
  const fields = record as unknown as Record<string, unknown>;
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    return "payload is not a JSON object";
  }
  const required = ["kind", "request", "asset", "version", "attestor", "at", "nonce"];
  const missing = required.filter(
    (field) => typeof fields[field] !== "string" || fields[field] === "",
  );
  if (missing.length > 0) {
    return `payload is missing required string fields: ${missing.join(", ")}`;
  }
  if (fields.kind !== "direct" && fields.kind !== "rebuild") {
    return `payload kind is ${String(fields.kind)}, expected direct or rebuild`;
  }
  return null;
}

/**
 * Whether the key could have produced a usable signature at `signedAt`.
 *
 * The compromise branch deliberately ignores `signedAt`. A retired key's past
 * work stands because retirement says only that it is no longer in use; a
 * compromised key's past work does not, because the report says somebody else
 * may have had it, and there is no honest way to say for how long.
 */
function keyUsable(key: RegisteredKey, signedAt: string, now: string): VerificationFailure[] {
  const failures: VerificationFailure[] = [];
  const signed = Date.parse(signedAt);
  const valid = Date.parse(key.notBefore);

  if (Number.isNaN(signed)) {
    failures.push({
      kind: "malformed-envelope",
      detail: `the record's \`at\` is not a timestamp: ${signedAt}`,
    });
    return failures;
  }
  if (!Number.isNaN(valid) && signed < valid) {
    failures.push({ kind: "key-not-yet-valid", keyId: key.keyId, notBefore: key.notBefore });
  }
  // A record dated in the future is not evidence about now.
  if (signed > Date.parse(now)) {
    failures.push({
      kind: "malformed-envelope",
      detail: `the record is dated ${signedAt}, which is after ${now}`,
    });
  }

  if (key.status.state === "compromised") {
    failures.push({ kind: "key-compromised", keyId: key.keyId, at: key.status.at });
  } else if (key.status.state === "retired" && signed > Date.parse(key.status.at)) {
    failures.push({
      kind: "key-retired-before-signing",
      keyId: key.keyId,
      retiredAt: key.status.at,
    });
  }

  return failures;
}

function challengeUsable(
  record: SignedRecord,
  context: VerificationContext,
): VerificationFailure[] {
  const challenge = context.challenges.find((entry) => entry.nonce === record.nonce);
  if (!challenge) {
    return [{ kind: "unknown-challenge", nonce: String(record.nonce) }];
  }
  const failures: VerificationFailure[] = [];
  if (challenge.consumed) failures.push({ kind: "challenge-replayed", nonce: challenge.nonce });
  if (Date.parse(context.now) > Date.parse(challenge.expiresAt)) {
    failures.push({
      kind: "challenge-expired",
      nonce: challenge.nonce,
      expiredAt: challenge.expiresAt,
    });
  }
  // The challenge names the question. An answer about a different asset or a
  // different request is a valid signature over the wrong thing, which is
  // exactly what an unbound nonce would let through.
  if (challenge.request !== record.request || challenge.asset !== record.asset) {
    failures.push({
      kind: "challenge-mismatch",
      detail:
        `challenge was issued for ${challenge.asset} on ${challenge.request}, ` +
        `the record answers for ${record.asset} on ${record.request}`,
    });
  }
  return failures;
}

/** Exact URN, or a prefix ending in `*`. Nothing regex-shaped: a scope is not a language. */
function inScope(scope: string[], asset: string): boolean {
  return scope.some((entry) =>
    entry.endsWith("*") ? asset.startsWith(entry.slice(0, -1)) : entry === asset,
  );
}

/**
 * Which previously-accepted attestations a change to the key registry has just
 * invalidated.
 *
 * **Key compromise is not a write, and nothing else in obsel would notice it.**
 * Every other way an asset loses its coverage happens because somebody touched
 * data: a new version, a retraction, an upstream reopening. A key reported
 * compromised changes no asset and no version, and without this the board would
 * keep showing green backed by signatures nobody should trust any more.
 *
 * Returns the attestations to drop. The caller re-runs `coverageFor` without
 * them, and the least fixpoint takes the whole transitive closure down on its
 * own — the same mechanism retraction already uses, for the same reason.
 */
export function invalidatedByKeys(
  accepted: { attestation: Attestation; keyId: string }[],
  keys: RegisteredKey[],
): { attestation: Attestation; keyId: string; reason: VerificationFailure }[] {
  const dropped: { attestation: Attestation; keyId: string; reason: VerificationFailure }[] = [];
  for (const entry of accepted) {
    const key = keys.find((candidate) => candidate.keyId === entry.keyId);
    if (!key) {
      dropped.push({ ...entry, reason: { kind: "unknown-key", keyId: entry.keyId } });
      continue;
    }
    if (key.status.state === "compromised") {
      dropped.push({
        ...entry,
        reason: { kind: "key-compromised", keyId: key.keyId, at: key.status.at },
      });
    }
    // Retirement deliberately drops nothing: see `keyUsable`.
  }
  return dropped;
}

/**
 * Mark a challenge used, after the record that answered it was accepted.
 *
 * Separate from verification so a failed submission does not burn the nonce.
 * Returns a new list rather than mutating, because the caller owns where
 * challenges live and this module refuses to care.
 */
export function consumeChallenge(challenges: Challenge[], nonce: string): Challenge[] {
  return challenges.map((entry) => (entry.nonce === nonce ? { ...entry, consumed: true } : entry));
}
