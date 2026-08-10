/**
 * Where the evidence ledger ends, and where the next record goes.
 *
 * The rule: a walk over derived URNs returns every record that is there, and a
 * write position is derived from the end of the ledger rather than from however
 * much of it some reader chose to fetch.
 *
 * This is the arithmetic behind a defect that lost evidence. The attestation
 * walk used to stop at twenty-five, and `submitAttestation` took its write
 * position from the length of that walk. On an asset with twenty-five records
 * the read stopped at the cap instead of at the end of the ledger, so record 26
 * was written and then written over by record 27, and the spent-nonce check —
 * which reads the same list — could not see the nonce record 26 had consumed.
 *
 * `readSequence` is exercised over an injected reader because the loop is the
 * subject here: which sequence numbers it asks for, and when it stops. What the
 * reader does against DataHub is covered in `tests/live/erasure.live.test.ts`
 * against real `document` entities, including the write-side refusal that no
 * pure test can reach.
 */

import { describe, expect, it } from "vitest";

import { attestationUrn, readSequence } from "@/src/server/datahub/documents";

const ASSET = "urn:li:dataset:(urn:li:dataPlatform:snowflake,db.schema.customers,PROD)";

/** A ledger holding records at exactly these sequence numbers, and nothing else. */
function ledger(present: number[]): (sequence: number) => Promise<string | null> {
  const held = new Set(present);
  return async (sequence) => (held.has(sequence) ? `record ${sequence}` : null);
}

describe("reading a derived-urn sequence to its end", () => {
  it("returns nothing when the ledger holds nothing", async () => {
    expect(await readSequence(ledger([]))).toEqual([]);
  });

  it("returns all forty records of a ledger with forty in it", async () => {
    // The defect, stated as a number: a walk that stopped at twenty-five
    // reported twenty-five here, and every record above that was invisible to
    // the report and to the spent-nonce check.
    const dense = Array.from({ length: 40 }, (_value, index) => index + 1);
    const found = await readSequence(ledger(dense));

    expect(found).toHaveLength(40);
    expect(found[25]).toBe("record 26");
    expect(found[39]).toBe("record 40");
  });

  it("stops at the first absence rather than skipping over it", async () => {
    // A gap is where the ledger ends as far as any reader is concerned. Walking
    // past one would report records the walk cannot vouch for having reached in
    // order, and would hide the gap itself.
    expect(await readSequence(ledger([1, 2, 4, 5]))).toEqual(["record 1", "record 2"]);
  });

  it("asks for one sequence number after another, starting at one", async () => {
    const asked: number[] = [];
    const read = ledger([1, 2, 3]);
    await readSequence(async (sequence) => {
      asked.push(sequence);
      return await read(sequence);
    });

    expect(asked).toEqual([1, 2, 3, 4]);
  });
});

describe("the urn each attestation lands on", () => {
  it("gives every sequence number its own record, past any former ceiling", async () => {
    const urns = [25, 26, 27].map((sequence) => attestationUrn("dsr-1", ASSET, sequence));
    expect(new Set(urns).size).toBe(3);
  });

  it("is derived from request, asset and sequence alone", () => {
    // Derived, never searched for: two readers pointed at the same record
    // recompute the same urn, which keeps the lagging search index out of the
    // path entirely.
    expect(attestationUrn("dsr-1", ASSET, 26)).toBe(attestationUrn("dsr-1", ASSET, 26));
    expect(attestationUrn("dsr-2", ASSET, 26)).not.toBe(attestationUrn("dsr-1", ASSET, 26));
  });
});
