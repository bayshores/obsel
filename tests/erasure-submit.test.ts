/**
 * The submission boundary: which request a signed record is allowed to land in.
 *
 * `verifyAttestation` holds the challenge and the record to each other, which is
 * a different pair from the one this file is about. An envelope legitimately
 * issued, signed and bound for request R2 passes every check in that module when
 * it is POSTed against R1, and R1's ledger is where it would be written.
 *
 * Real signatures over real keys, and the DataHub the engine would otherwise
 * reach is a port nothing is listening on. That is the point of the second test:
 * a submission naming the request it was made to gets as far as the ledger read
 * and fails there, so the guard above it is narrow rather than a blanket
 * refusal. Nothing here stands in for a process boundary.
 */

import { generateKeyPairSync } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { signAttestation } from "@/src/server/coordinator/attestation";
import type { Envelope, SignedRecord } from "@/src/server/coordinator/attestation";
import { submitAttestation } from "@/src/server/coordinator/erasure-engine";

const CUSTOMERS = "urn:li:dataset:(urn:li:dataPlatform:snowflake,order_entry.customers,PROD)";
const FIRST = "dsr-2026-0417";
const SECOND = "dsr-2026-0512";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

beforeAll(() => {
  // A port nothing is listening on, so any read the engine attempts fails at
  // connect. The local DataHub is deliberately not involved in this file.
  process.env.DATAHUB_GMS_URL = "http://127.0.0.1:47881";
  process.env.OBSEL_ATTESTOR_KEYS = JSON.stringify([
    {
      keyId: "warehouse-2026-07",
      attestor: "warehouse-adapter@acme",
      publicKeyPem: PUBLIC_PEM,
      notBefore: "2026-07-01T00:00:00.000Z",
      status: { state: "active" },
      scope: ["urn:li:dataset:(urn:li:dataPlatform:snowflake,*"],
    },
  ]);
});

function envelopeFor(request: string): Envelope {
  const record = {
    kind: "direct",
    request,
    asset: CUSTOMERS,
    version: "v-foreign",
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
  } as SignedRecord;
  return signAttestation(record, PRIVATE_PEM, "warehouse-2026-07");
}

describe("one request's evidence stays out of another's", () => {
  it("refuses an envelope signed for another request, before the ledger is touched", async () => {
    /*
     * The record and its challenge agree with each other — both name the second
     * request — so nothing inside `verifyAttestation` has a reason to object.
     * What is wrong with the submission is only visible here: it was made
     * against the first request, whose bucket it would be appended to, and
     * whose report reads that bucket to decide which version the answer is
     * computed against.
     */
    const result = await submitAttestation(envelopeFor(SECOND), FIRST);

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.failures.map((failure) => failure.kind)).toEqual(["request-mismatch"]);
  });

  it("still reads the ledger for a record that names the request it was sent to", async () => {
    // The failure is the unreachable port, which is how this asserts that the
    // guard above did not answer: a submission naming its own request gets as
    // far as the ledger read and dies there.
    await expect(submitAttestation(envelopeFor(FIRST), FIRST)).rejects.toThrow(/fetch failed/);
  });
});
