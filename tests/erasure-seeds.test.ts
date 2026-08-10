/**
 * The decision that refuses an erasure request naming a seed DataHub has never
 * heard of.
 *
 * Why this decision exists: `GET /relationships` answers an unknown URN with an
 * empty relationship list rather than an error, so a mistyped table name walks
 * nowhere and the request answers over exactly that one string. A real estate of
 * one asset also exists — the postgres copy of `order_entry.customers` reaches
 * one, recorded in `docs/verification.md` — so the two reports carry the same
 * fields, the same counts and the same `UNPROVEN` row, and nothing in either one
 * separates a typo from a subject whose data really did stop at one table.
 *
 * The existence answers come from `GET /openapi/v3/entity/dataset/<urn>`, which
 * genuinely 404s, over the wire in `erasure-engine.ts`. What is under test here
 * is the decision taken once those answers are in hand.
 */

import { describe, expect, it } from "vitest";

import {
  UnknownSeedsError,
  unknownSeeds,
  unknownSeedsMessage,
} from "@/src/server/coordinator/erasure-seeds";

const SNOWFLAKE = "urn:li:dataPlatform:snowflake";
const ORDERS = `urn:li:dataset:(${SNOWFLAKE},analytics.orders,PROD)`;
const TYPO = `urn:li:dataset:(${SNOWFLAKE},analytics.ordres,PROD)`;
const CUSTOMERS = `urn:li:dataset:(${SNOWFLAKE},analytics.customers,PROD)`;

describe("unknown seeds", () => {
  it("names nothing when every seed is a dataset DataHub knows", () => {
    expect(
      unknownSeeds([
        { seed: ORDERS, exists: true },
        { seed: CUSTOMERS, exists: true },
      ]),
    ).toEqual([]);
  });

  it("names the one seed that does not exist, and keeps the ones that do", () => {
    expect(
      unknownSeeds([
        { seed: ORDERS, exists: true },
        { seed: TYPO, exists: false },
      ]),
    ).toEqual([TYPO]);
  });

  it("names every unknown seed rather than the first, sorted and without repeats", () => {
    const other = `urn:li:dataset:(${SNOWFLAKE},analytics.custmers,PROD)`;
    expect(
      unknownSeeds([
        { seed: TYPO, exists: false },
        { seed: other, exists: false },
        { seed: TYPO, exists: false },
        { seed: ORDERS, exists: true },
      ]),
    ).toEqual([other, TYPO]);
  });

  it("refuses rather than reporting, so no asset is given a state", () => {
    // The refusal is the whole behavior. Nothing here decides that an asset is
    // covered, attested or clear, and there is no shape in which a caller can
    // read a verdict out of it.
    const error = new UnknownSeedsError([TYPO]);
    expect(error).toBeInstanceOf(Error);
    expect(error.unknownSeeds).toEqual([TYPO]);
    expect(error.message).toContain(TYPO);
    expect(Object.keys(error)).not.toContain("coverage");
  });

  it("puts every unknown seed in the message a caller reads", () => {
    const message = unknownSeedsMessage([TYPO, CUSTOMERS]);
    expect(message).toContain(TYPO);
    expect(message).toContain(CUSTOMERS);
  });
});
