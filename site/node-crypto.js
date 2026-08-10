/**
 * The browser's stand-in for the three `node:crypto` calls the verifier makes.
 *
 * This file is the ONLY substitution in the hosted page. `attestation.ts`,
 * `erasure.ts` and `verify-erasure-evidence.mjs` are bundled unchanged; what
 * cannot come along is `node:crypto` itself, because `verifyAttestation` is
 * synchronous by design and the browser's own WebCrypto API is asynchronous.
 * The arithmetic here comes from audited, widely used libraries by the same
 * author (@noble/ed25519 and @noble/hashes), and `tests/site-verify.test.ts`
 * holds this file's answers equal to `node:crypto`'s over real signatures and
 * over tampered ones.
 *
 * Only what the verifier calls is implemented. Everything else throws by
 * omission, which is the point: a new use of `node:crypto` in the kernel should
 * fail the site build's test loudly, not verify vacuously.
 */

import { hashes, verify as edVerify } from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha2.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// @noble/ed25519's synchronous `verify` needs SHA-512 supplied; the library
// only wires it up by itself in the async path.
hashes.sha512 = sha512;

/**
 * Ed25519 SPKI is one fixed shape: a 12-byte DER prefix and then the 32 raw
 * key bytes, 44 bytes in all. Parsed by that shape rather than with an ASN.1
 * library, and refused if the prefix is anything else, because a key that is
 * not this exact form is not an Ed25519 SPKI key and must not be guessed at.
 */
const SPKI_PREFIX = "302a300506032b6570032100";

export function createPublicKey(pem) {
  const body = String(pem)
    .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0));
  if (der.length !== 44 || bytesToHex(der.subarray(0, 12)) !== SPKI_PREFIX) {
    throw new Error("not an Ed25519 SPKI public key");
  }
  return { raw: der.subarray(12) };
}

/** `verify(null, data, key, signature)`, exactly as `attestation.ts` calls it. */
export function verify(_algorithm, data, key, signature) {
  return edVerify(new Uint8Array(signature), new Uint8Array(data), key.raw);
}

/** The verifier never signs in the browser; only attestor adapters sign. */
export function sign() {
  throw new Error("signing is not available in the browser verifier");
}

/** Only the one call the verifier makes: sha256 over utf8, hex out. */
export function createHash(algorithm) {
  if (algorithm !== "sha256") {
    throw new Error(`only sha256 is implemented in the browser, not ${algorithm}`);
  }
  const chunks = [];
  return {
    update(data) {
      chunks.push(typeof data === "string" ? new TextEncoder().encode(data) : data);
      return this;
    },
    digest(encoding) {
      if (encoding !== "hex") throw new Error(`only hex digests are implemented, not ${encoding}`);
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.length;
      }
      return bytesToHex(sha256(joined));
    },
  };
}
