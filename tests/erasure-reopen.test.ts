/**
 * A request id is used once, and the ledger says so before anything is written.
 *
 * The ledger is append-only: a record is written and never edited. The request
 * record is the one an evidence bundle is re-derived against, so an id opened a
 * second time with different identifiers, seeds or hops would replace the
 * question that the attestations already in the ledger answered, and nothing in
 * the bundle would show that the earlier question ever existed.
 *
 * The write itself is an upsert against DataHub, which cannot refuse this. The
 * refusal has to come from obsel reading the ledger URN first, and the decision
 * about what a read record means is the pure part tested here. The end-to-end
 * 409 over a real server is in `tests/live/erasure.live.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { RequestAlreadyOpen, refuseReopen } from "@/src/server/coordinator/erasure-engine";
import type { LedgerRecord } from "@/src/server/datahub/documents";

const OPENED_AT = "2026-08-01T09:15:00.000Z";

function requestRecord(id: string): LedgerRecord {
  return {
    id,
    kind: "request",
    request: id,
    at: OPENED_AT,
    body: JSON.stringify({ request: id, identifiers: ["alice@example.com"], hops: 2 }),
    assets: ["urn:li:dataset:(urn:li:dataPlatform:snowflake,shop.public.customers,PROD)"],
  };
}

describe("opening a request id the ledger already holds", () => {
  it("is refused", () => {
    expect(() => refuseReopen("dsr-1", requestRecord("dsr-1"))).toThrow(RequestAlreadyOpen);
  });

  it("names the request and when it was opened, so the caller can go and read it", () => {
    /*
     * A bare "conflict" would leave the caller guessing whether the id is
     * theirs. The sentence has to carry the id it is talking about and the time
     * the existing record was written.
     */
    let thrown: unknown;
    try {
      refuseReopen("dsr-1", requestRecord("dsr-1"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RequestAlreadyOpen);
    const message = (thrown as Error).message;
    expect(message).toContain("dsr-1");
    expect(message).toContain(OPENED_AT);
    expect((thrown as RequestAlreadyOpen).status).toBe(409);
  });

  it("says the earlier record stands rather than that it was replaced", () => {
    // The refusal exists because a rewrite is silent. It should tell the reader
    // the ledger record is unchanged, which is the fact they need.
    const message = (() => {
      try {
        refuseReopen("dsr-1", requestRecord("dsr-1"));
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(/written once|never (rewritten|edited)/i.test(message), message).toBe(true);
  });
});

describe("opening a request id nothing was ever written under", () => {
  it("is allowed", () => {
    expect(() => refuseReopen("dsr-2", null)).not.toThrow();
  });
});
