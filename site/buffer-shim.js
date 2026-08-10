/**
 * Injected by the site build so every free `Buffer` reference in the bundled
 * kernel resolves to the standard browser polyfill (feross/buffer, the one
 * bundlers have shipped for years). `attestation.ts` and the verifier use
 * `Buffer` for base64 and utf8 round-trips and for the PAE concatenation;
 * the polyfill implements the same API over Uint8Array.
 */
export { Buffer } from "buffer";
