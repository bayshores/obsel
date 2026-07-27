/**
 * The boundary everything else rests on.
 *
 * `erasure.ts` refuses any attestation whose `signatureVerified` is false, so
 * this module is the only thing that can turn a claim into evidence. If it is
 * wrong, every green on the board is decoration.
 *
 * **Real keys, real signatures.** `generateKeyPairSync("ed25519")` and
 * `node:crypto` do the arithmetic here; nothing is stubbed, because a stand-in
 * for a signature check can only assert what its author already believed, which
 * is the reason this repo deleted its last one.
 */

import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  PAYLOAD_TYPE,
  canonicalJson,
  consumeChallenge,
  invalidatedByKeys,
  pae,
  signAttestation,
  verifyAttestation,
} from "@/src/server/coordinator/attestation";
import type {
  Challenge,
  Envelope,
  RegisteredKey,
  SignedRecord,
} from "@/src/server/coordinator/attestation";
import { coverageFor } from "@/src/server/coordinator/erasure";

const CUSTOMERS = "urn:li:dataset:(urn:li:dataPlatform:snowflake,order_entry.customers,PROD)";
const DASHBOARD = "urn:li:dataset:(urn:li:dataPlatform:looker,analytics.revenue,PROD)";
const REQUEST = "dsr-2026-0417";
const NOW = "2026-07-26T12:00:00.000Z";

function keypair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

const WAREHOUSE = keypair();

function registeredKey(over: Partial<RegisteredKey> = {}): RegisteredKey {
  return {
    keyId: "warehouse-2026-07",
    attestor: "warehouse-adapter@acme",
    publicKeyPem: WAREHOUSE.publicKeyPem,
    notBefore: "2026-07-01T00:00:00.000Z",
    status: { state: "active" },
    scope: ["urn:li:dataset:(urn:li:dataPlatform:snowflake,*"],
    ...over,
  };
}

function challenge(over: Partial<Challenge> = {}): Challenge {
  return {
    nonce: "n-6f21ab",
    request: REQUEST,
    asset: CUSTOMERS,
    issuedAt: "2026-07-26T11:55:00.000Z",
    expiresAt: "2026-07-26T12:05:00.000Z",
    ...over,
  };
}

function record(over: Partial<SignedRecord> = {}): SignedRecord {
  return {
    kind: "direct",
    request: REQUEST,
    asset: CUSTOMERS,
    version: "v1",
    predicate: {
      identifiers: ["cust_88213"],
      expression: "customer_id = 'cust_88213'",
      columns: ["customer_id"],
    },
    scope: { kind: "whole" },
    result: "absent",
    attestor: "warehouse-adapter@acme",
    signatureVerified: false,
    at: "2026-07-26T11:58:00.000Z",
    nonce: "n-6f21ab",
    ...over,
  } as SignedRecord;
}

function context(over: Partial<Parameters<typeof verifyAttestation>[1]> = {}) {
  return { keys: [registeredKey()], challenges: [challenge()], now: NOW, ...over };
}

function sign(rec: SignedRecord = record(), keyId = "warehouse-2026-07"): Envelope {
  return signAttestation(rec, WAREHOUSE.privateKeyPem, keyId);
}

function failureKinds(result: ReturnType<typeof verifyAttestation>): string[] {
  return result.ok ? [] : result.failures.map((entry) => entry.kind).sort();
}

describe("canonical bytes", () => {
  it("does not depend on the order the fields were written in", () => {
    // Two encoders disagreeing by one space produce a record that verifies on
    // one machine and not on another. Key order is the usual way that happens.
    const a = canonicalJson({ b: 1, a: 2, c: { z: 1, y: 2 } });
    const b = canonicalJson({ c: { y: 2, z: 1 }, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":{"y":2,"z":1}}');
  });

  it("refuses a value it cannot encode unambiguously rather than guessing", () => {
    /*
     * `JSON.stringify` encodes Infinity as null and silently drops undefined
     * from an object. Either would let two different records produce identical
     * bytes, so one signature would stand for the other.
     */
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(/encode as null/);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/cannot canonicalise/);
  });

  it("length-prefixes each field, so no two records share the same signed bytes", () => {
    /*
     * The whole reason DSSE's PAE exists rather than concatenation. These two
     * pairs concatenate to the same string; the length prefixes are what keep
     * their signed forms apart, and without them a signature over one would
     * verify over the other.
     */
    const first = pae("ab", Buffer.from("cd", "utf8"));
    const second = pae("abc", Buffer.from("d", "utf8"));
    expect(first.equals(second)).toBe(false);
    expect(first.toString("utf8")).toBe("DSSEv1 2 ab 2 cd");
    expect(second.toString("utf8")).toBe("DSSEv1 3 abc 1 d");
  });

  it("measures length in bytes, not characters", () => {
    // A multi-byte identifier would otherwise be prefixed with a length that
    // does not match what a verifier reading bytes would compute.
    const encoded = pae(PAYLOAD_TYPE, Buffer.from("é", "utf8"));
    expect(encoded.toString("utf8")).toContain(" 2 é");
  });
});

describe("a correctly signed record", () => {
  it("verifies, and comes back marked verified", () => {
    const result = verifyAttestation(sign(), context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attestation.signatureVerified).toBe(true);
    expect(result.attestation.asset).toBe(CUSTOMERS);
  });

  it("does not carry the nonce into the attestation", () => {
    // The challenge was the binding, not part of the claim. Leaving it on the
    // record would put a one-time value into the ledger the report is built on.
    const result = verifyAttestation(sign(), context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.hasOwn(result.attestation, "nonce")).toBe(false);
  });
});

describe("tampering", () => {
  it("rejects a payload altered after signing, in the field that matters most", () => {
    const envelope = sign();
    const decoded = JSON.parse(Buffer.from(envelope.payload, "base64").toString()) as SignedRecord;
    // The one edit an attacker would actually make.
    const tampered = { ...decoded, result: "absent" as const, version: "v2" };
    const forged: Envelope = {
      ...envelope,
      payload: Buffer.from(canonicalJson(tampered)).toString("base64"),
    };

    expect(failureKinds(verifyAttestation(forged, context()))).toContain("bad-signature");
  });

  it("rejects a single flipped byte anywhere in the payload", () => {
    const envelope = sign();
    const bytes = Buffer.from(envelope.payload, "base64");
    bytes[Math.floor(bytes.length / 2)] ^= 0x01;
    const forged: Envelope = { ...envelope, payload: bytes.toString("base64") };

    expect(verifyAttestation(forged, context()).ok).toBe(false);
  });

  it("verifies the bytes that arrived, not a re-serialisation of what they parsed to", () => {
    /*
     * Added because a mutation survived: replacing the received payload with
     * `canonicalJson(parsed)` before verifying passed all thirty tests, because
     * every payload these tests produce is already canonical. That is the
     * classic way a signature check ends up covering something other than what
     * was signed, and the file's own comment warned about it while nothing
     * enforced it.
     *
     * The payload below re-orders the fields. It parses to exactly the same
     * record, so a verifier that re-serialises first would accept it — and
     * would thereby accept an envelope whose actual bytes nobody ever signed.
     * Once that is allowed, the door is open to payloads that parse the same
     * but read differently: duplicate keys where the last wins, `1e2` for
     * `100`, whitespace nobody looked at.
     *
     * The signature covers bytes. Anything that is not those bytes is not
     * signed, and the refusal is the whole point of a canonical encoding.
     */
    const envelope = sign();
    const parsed = JSON.parse(Buffer.from(envelope.payload, "base64").toString()) as SignedRecord;

    const reordered = Object.fromEntries(Object.entries(parsed).reverse());
    const nonCanonical = JSON.stringify(reordered);
    expect(nonCanonical, "the re-encoding must genuinely differ, or this tests nothing").not.toBe(
      canonicalJson(parsed),
    );

    const repackaged: Envelope = {
      ...envelope,
      payload: Buffer.from(nonCanonical, "utf8").toString("base64"),
    };

    expect(failureKinds(verifyAttestation(repackaged, context()))).toContain("bad-signature");
  });

  it("refuses a payload that is not shaped like a record, instead of crashing on it", () => {
    /*
     * Found by feeding `{}` through the real HTTP route, not by any unit test
     * here: every payload these tests build is well formed, so the first check
     * that reached for a field the record did not have threw, and a malformed
     * submission came back a 500 rather than a refusal. A crash in a
     * verification path is the wrong failure twice over — the caller learns
     * nothing about what was wrong, and unvalidated input has already travelled
     * further into the check than it should.
     */
    for (const payload of ["{}", "[]", '"a string"', '{"kind":"direct"}', "42"]) {
      const envelope: Envelope = {
        payloadType: PAYLOAD_TYPE,
        payload: Buffer.from(payload, "utf8").toString("base64"),
        signatures: [{ keyid: "warehouse-2026-07", sig: "bm90LWEtc2ln" }],
      };
      const result = verifyAttestation(envelope, context());
      expect(result.ok, `${payload} should be refused`).toBe(false);
      expect(failureKinds(result), payload).toContain("malformed-envelope");
    }
  });

  it("refuses a record carrying no nonce, which is a record bound to no question", () => {
    // Without a nonce there is nothing tying the signature to something obsel
    // asked, which is the whole difference between evidence and a stored answer.
    const noNonce = { ...record() } as Partial<SignedRecord>;
    delete noNonce.nonce;
    const envelope: Envelope = {
      payloadType: PAYLOAD_TYPE,
      payload: Buffer.from(canonicalJson(noNonce), "utf8").toString("base64"),
      signatures: [{ keyid: "warehouse-2026-07", sig: "bm90LWEtc2ln" }],
    };
    expect(failureKinds(verifyAttestation(envelope, context()))).toContain("malformed-envelope");
  });

  it("rejects a signature made by a different key than the one claimed", () => {
    // The attacker holds their own key and names somebody else's id.
    const other = keypair();
    const envelope = signAttestation(record(), other.privateKeyPem, "warehouse-2026-07");
    expect(failureKinds(verifyAttestation(envelope, context()))).toContain("bad-signature");
  });

  it("rejects a key nobody registered", () => {
    const envelope = sign(record(), "some-key-nobody-knows");
    expect(failureKinds(verifyAttestation(envelope, context()))).toEqual(["unknown-key"]);
  });

  it("rejects an envelope carrying a different payload type", () => {
    // A signature over a differently-typed payload must not be reusable here.
    const envelope = { ...sign(), payloadType: "application/json" };
    expect(failureKinds(verifyAttestation(envelope, context()))).toEqual(["malformed-envelope"]);
  });

  it("rejects an envelope with no signature, and one with several", () => {
    const envelope = sign();
    expect(failureKinds(verifyAttestation({ ...envelope, signatures: [] }, context()))).toEqual([
      "malformed-envelope",
    ]);
    expect(
      failureKinds(
        verifyAttestation(
          { ...envelope, signatures: [...envelope.signatures, ...envelope.signatures] },
          context(),
        ),
      ),
    ).toEqual(["malformed-envelope"]);
  });
});

describe("who is allowed to say what", () => {
  it("rejects a record claiming an attestor the key does not belong to", () => {
    const envelope = sign(record({ attestor: "someone-else@acme" }));
    expect(failureKinds(verifyAttestation(envelope, context()))).toContain("attestor-mismatch");
  });

  it("rejects an attestor speaking for an asset outside its scope", () => {
    /*
     * A warehouse adapter has no business attesting about a looker dashboard it
     * cannot see. Without scope, any registered key covers the whole estate,
     * and the weakest attestor in an organization sets the bar for all of it.
     */
    const envelope = sign(record({ asset: DASHBOARD, nonce: "n-dash" }));
    const result = verifyAttestation(
      envelope,
      context({ challenges: [challenge({ nonce: "n-dash", asset: DASHBOARD })] }),
    );
    expect(failureKinds(result)).toContain("out-of-scope");
  });

  it("accepts an asset inside a prefix scope", () => {
    const result = verifyAttestation(sign(), context());
    expect(result.ok).toBe(true);
  });
});

describe("the challenge, which is what stops a record being pre-signed", () => {
  it("rejects a record answering a nonce obsel never issued", () => {
    const envelope = sign(record({ nonce: "n-invented" }));
    expect(failureKinds(verifyAttestation(envelope, context()))).toContain("unknown-challenge");
  });

  it("rejects a record answering an expired challenge", () => {
    const result = verifyAttestation(sign(), context({ now: "2026-07-26T12:06:00.000Z" }));
    expect(failureKinds(result)).toContain("challenge-expired");
  });

  it("rejects the same envelope submitted twice", () => {
    // Single use. Without it one signed answer covers every later version of
    // the asset, which is the replay the whole mechanism exists to stop.
    const envelope = sign();
    const first = verifyAttestation(envelope, context());
    expect(first.ok).toBe(true);

    const used = consumeChallenge([challenge()], "n-6f21ab");
    const second = verifyAttestation(envelope, context({ challenges: used }));
    expect(failureKinds(second)).toContain("challenge-replayed");
  });

  it("does not burn the challenge on a submission that failed", () => {
    /*
     * Verification decides; the caller records. If verifying consumed the
     * nonce, an attestor that mis-signed once could never retry, and the
     * operator would be stuck reissuing challenges to work around a bug.
     */
    const challenges = [challenge()];
    verifyAttestation({ ...sign(), signatures: [] }, context({ challenges }));
    expect(challenges[0].consumed).toBeUndefined();
    expect(verifyAttestation(sign(), context({ challenges })).ok).toBe(true);
  });

  it("rejects a valid signature over the wrong question", () => {
    // The nonce names an asset and a request. An unbound nonce would let a
    // genuine answer about one table be submitted as an answer about another.
    const envelope = sign(record({ asset: CUSTOMERS }));
    const result = verifyAttestation(
      envelope,
      context({
        challenges: [
          challenge({
            asset: "urn:li:dataset:(urn:li:dataPlatform:snowflake,order_entry.orders,PROD)",
          }),
        ],
      }),
    );
    expect(failureKinds(result)).toContain("challenge-mismatch");
  });
});

describe("key lifecycle", () => {
  it("rejects a record signed before the key was valid", () => {
    const envelope = sign(record({ at: "2026-06-01T00:00:00.000Z" }));
    expect(failureKinds(verifyAttestation(envelope, context()))).toContain("key-not-yet-valid");
  });

  it("rejects a record dated after now, which is not evidence about now", () => {
    const envelope = sign(record({ at: "2026-08-01T00:00:00.000Z" }));
    expect(failureKinds(verifyAttestation(envelope, context()))).toContain("malformed-envelope");
  });

  it("keeps work a retired key signed while it was still active", () => {
    /*
     * Rotation is routine and says only that a key is no longer in use. Nothing
     * about it suggests anyone else could have produced its past signatures, so
     * dropping that work would punish good hygiene and teach operators not to
     * rotate.
     */
    const keys = [registeredKey({ status: { state: "retired", at: "2026-07-26T11:59:00.000Z" } })];
    expect(verifyAttestation(sign(), context({ keys })).ok).toBe(true);
  });

  it("rejects work a retired key signed after it was retired", () => {
    const keys = [registeredKey({ status: { state: "retired", at: "2026-07-26T11:00:00.000Z" } })];
    expect(failureKinds(verifyAttestation(sign(), context({ keys })))).toContain(
      "key-retired-before-signing",
    );
  });

  it("rejects everything a compromised key ever signed, however old", () => {
    /*
     * The asymmetry that matters. A compromise report says somebody else may
     * have held the key, and there is no honest way to say for how long, so the
     * timeline it signed cannot be trusted at any point. Same shape as RETRACTED
     * against SUPERSEDED in the kernel, and kept on a separate code path for the
     * same reason: two withdrawals that look identical mean opposite things.
     */
    const keys = [
      registeredKey({ status: { state: "compromised", at: "2026-07-26T11:59:59.000Z" } }),
    ];
    expect(failureKinds(verifyAttestation(sign(), context({ keys })))).toContain("key-compromised");
  });
});

describe("a key reported compromised after the fact", () => {
  /*
   * Key compromise is not a write, and nothing else in obsel would notice it.
   * Every other way coverage is lost happens because somebody touched data. A
   * key going bad changes no asset and no version, so without this the board
   * keeps showing green backed by signatures nobody should trust.
   */
  const accepted = [
    { attestation: { ...record(), signatureVerified: true }, keyId: "warehouse-2026-07" },
  ];

  it("takes back the attestations it signed", () => {
    const keys = [registeredKey({ status: { state: "compromised", at: NOW } })];
    const dropped = invalidatedByKeys(accepted, keys);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].reason.kind).toBe("key-compromised");
  });

  it("takes back nothing when the key was merely retired", () => {
    const keys = [registeredKey({ status: { state: "retired", at: NOW } })];
    expect(invalidatedByKeys(accepted, keys)).toEqual([]);
  });

  it("takes back attestations whose key has vanished from the registry entirely", () => {
    // A key removed rather than marked is the same problem with less
    // information, and reading its absence as "still fine" is the exact shape
    // of failure obsel exists to catch.
    expect(invalidatedByKeys(accepted, [])).toHaveLength(1);
  });
});

describe("the loop with the kernel closes", () => {
  const currentVersion = { [CUSTOMERS]: "v1" };
  const recordedUpstream = { [CUSTOMERS]: [] as string[] };

  it("a verified attestation reaches ATTESTED, and an unverified one does not", () => {
    const verified = verifyAttestation(sign(), context());
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    const covered = coverageFor({
      request: REQUEST,
      identifiers: ["cust_88213"],
      currentVersion,
      recordedUpstream,
      attestations: [verified.attestation],
    });
    expect(covered[0].state).toBe("ATTESTED");

    // The same claim, unsigned. This is what every attestation looks like until
    // this module has passed it.
    const unverified = coverageFor({
      request: REQUEST,
      identifiers: ["cust_88213"],
      currentVersion,
      recordedUpstream,
      attestations: [{ ...record(), signatureVerified: false }],
    });
    expect(unverified[0].state).toBe("UNPROVEN");
  });

  it("an asset goes back to unattested when the signing key is reported compromised", () => {
    const verified = verifyAttestation(sign(), context());
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    const accepted = [{ attestation: verified.attestation, keyId: verified.keyId }];
    const green = coverageFor({
      request: REQUEST,
      identifiers: ["cust_88213"],
      currentVersion,
      recordedUpstream,
      attestations: accepted.map((entry) => entry.attestation),
    });
    expect(green[0].state).toBe("ATTESTED");

    // Nothing about the data changed. Only what is known about the key.
    const keys = [registeredKey({ status: { state: "compromised", at: NOW } })];
    const dropped = new Set(invalidatedByKeys(accepted, keys).map((entry) => entry.attestation));
    const after = coverageFor({
      request: REQUEST,
      identifiers: ["cust_88213"],
      currentVersion,
      recordedUpstream,
      attestations: accepted
        .map((entry) => entry.attestation)
        .filter((entry) => !dropped.has(entry)),
    });

    expect(after[0].state).toBe("UNPROVEN");
    expect(after[0].explanation).toContain("unattested");
  });
});
