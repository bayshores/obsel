/**
 * How a caller is told apart "this erasure request was never opened" from
 * "obsel could not read the ledger".
 *
 * Both routes under `app/api/erasure/[id]/` used to decide that by looking for
 * the substring "no erasure request" in the thrown message. The request id is
 * caller-chosen and unvalidated beyond being non-empty, it is interpolated into
 * the ledger URN, and `readLedgerRecord` interpolates that URN into the message
 * it throws for a non-404 status. So a request opened under the id
 * `no erasure request in the ledger x` turned every transient GMS failure for
 * that request into a 404 saying the request does not exist. An auditor would
 * be told the erasure request was never opened at the exact moment obsel could
 * not see it.
 *
 * The classification is therefore made on the type of the thrown value, never
 * on its text. Only `readRequest` in `erasure-engine.ts` throws
 * `NoSuchErasureRequest`, and it throws it only where the ledger genuinely
 * answered 404 for that record.
 */

/** Thrown where the ledger holds no record under a request's own URN. */
export class NoSuchErasureRequest extends Error {
  constructor(requestId: string) {
    super(`no erasure request ${requestId} in the ledger`);
    this.name = "NoSuchErasureRequest";
  }
}

/**
 * The HTTP status a failed read of one erasure request answers with.
 *
 * 404 only for the absence obsel actually observed. Everything else is 500,
 * including a failure whose message happens to read like an absence.
 */
export function erasureReadStatus(error: unknown): 404 | 500 {
  return error instanceof NoSuchErasureRequest ? 404 : 500;
}
