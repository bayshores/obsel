/**
 * What the erasure half is allowed to say on screen.
 *
 * The specification forbids a short list of words, and the reason it forbids
 * them is that each one claims more than obsel can support: obsel holds no
 * warehouse credentials, never reads warehouse data, and therefore cannot prove
 * absence of anything. A board that said "proven clean" would be making the one
 * claim the whole design is built to avoid making.
 *
 * A rule written in a document is a rule somebody has to remember. These are the
 * same rules as assertions over every value the view module can produce, so a
 * later edit that reintroduces one fails here rather than on camera.
 */

import { describe, expect, it } from "vitest";

import {
  assuranceLine,
  coverageTone,
  stateWord,
  summaryLine,
} from "@/src/features/dashboard/erasure/coverage-view";
import { reasonSentence } from "@/src/server/coordinator/erasure";
import type { ErasureState, ResidueReason } from "@/src/server/coordinator/erasure";

const STATES: ErasureState[] = ["ATTESTED", "UNPROVEN", "CONTRADICTED"];

/** Every residue kind the kernel can produce, so none goes unworded. */
const REASONS: ResidueReason[] = [
  { kind: "no-attestation" },
  { kind: "not-total", materialization: "merge" },
  { kind: "partitions-uncovered", covered: 3, total: 730 },
  { kind: "not-sole-producer" },
  { kind: "no-recorded-lineage" },
  { kind: "closure-mismatch", undeclared: ["urn:li:dataset:(x,warehouse.raw_orders,PROD)"] },
  {
    kind: "unattested-input",
    input: "urn:li:dataset:(x,warehouse.customers,PROD)",
    version: "v4",
  },
  { kind: "predicate-gap", missing: ["email_hash"] },
  {
    kind: "predicate-split",
    identifiers: ["cust_88213", "hash_9f2a"],
    partial: [{ identifier: "hash_9f2a", covered: 1, total: 730 }],
  },
  { kind: "unverified-signature", attestor: "warehouse-team" },
  { kind: "attested-other-version", attestedVersion: "v3" },
];

describe("the words an erasure state is reported in", () => {
  it("never uses a word the specification forbids", () => {
    const banned = ["proven clean", "proof", "complete", "certified", "guaranteed"];
    const everything = [
      ...STATES.map(stateWord),
      summaryLine({ total: 6, attested: 2, unproven: 3, contradicted: 1 }),
      summaryLine({ total: 6, attested: 6, unproven: 0, contradicted: 0 }),
      summaryLine({ total: 0, attested: 0, unproven: 0, contradicted: 0 }),
      assuranceLine({ hopsWalked: 3, assetsReached: 6, evidenceRecords: 9 }),
      ...REASONS.map((reason) => reasonSentence(reason, "customers")),
    ]
      .join(" ")
      .toLowerCase();

    for (const word of banned) {
      expect(everything, `"${word}" must not appear on the board`).not.toContain(word);
    }
  });

  it("never prints the enum spelling, which is an internal identifier", () => {
    for (const state of STATES) {
      expect(stateWord(state)).not.toContain(state);
      expect(stateWord(state)).toBe(stateWord(state).toLowerCase());
    }
  });

  it("says what somebody attested rather than what is true", () => {
    // "attested absent", not "clean" and not "absent": the sentence has to carry
    // the fact that this is somebody's claim, because that is all obsel has.
    expect(stateWord("ATTESTED")).toBe("attested absent");
    expect(stateWord("UNPROVEN")).toBe("unattested");
    expect(stateWord("CONTRADICTED")).toBe("reported still present");
  });

  it("gives every state a distinct word", () => {
    expect(new Set(STATES.map(stateWord)).size).toBe(STATES.length);
  });
});

describe("the color an erasure state is drawn in", () => {
  /*
   * Amber is spoken for. `tone.ts` states the invariant it keeps on the graph:
   * amber fill if and only if a task is out of date. An unattested asset is not
   * out of date, nothing upstream of it moved, and the two conditions appear on
   * the same screen minutes apart during the demo.
   */
  it("never uses the stale amber for any coverage state", () => {
    for (const state of STATES) {
      const tone = coverageTone(state);
      expect(tone.fill).not.toContain("stale");
      expect(tone.fill).not.toContain("amber");
      expect(tone.fill).not.toContain("lantern");
    }
  });

  it("resolves to mmux tokens rather than to color values", () => {
    for (const state of STATES) {
      expect(coverageTone(state).fill).toMatch(/^var\(--[a-z-]+\)$/);
    }
  });

  it("gives every state a distinct color", () => {
    expect(new Set(STATES.map((state) => coverageTone(state).fill)).size).toBe(STATES.length);
  });
});

describe("the line a report leads with", () => {
  it("counts assets and never reports a percentage", () => {
    const line = summaryLine({ total: 6, attested: 2, unproven: 3, contradicted: 1 });
    expect(line).toBe("2 of 6 assets covered, 3 unattested, 1 reported still present");
    expect(line).not.toContain("%");
  });

  it("says nothing about contradictions when there are none", () => {
    expect(summaryLine({ total: 4, attested: 1, unproven: 3, contradicted: 0 })).toBe(
      "1 of 4 assets covered, 3 unattested",
    );
  });

  it("agrees the noun with the number it is about", () => {
    expect(summaryLine({ total: 1, attested: 0, unproven: 1, contradicted: 0 })).toBe(
      "0 of 1 asset covered, 1 unattested",
    );
  });

  /*
   * A fully covered report still says how many assets that was. "Covered" with
   * no denominator is the shape of a claim about an estate, and this is a claim
   * about six tables somebody walked to.
   */
  it("keeps the denominator when everything is covered", () => {
    expect(summaryLine({ total: 6, attested: 6, unproven: 0, contradicted: 0 })).toBe(
      "6 of 6 assets covered, 0 unattested",
    );
  });

  it("words the empty walk rather than printing three zeroes", () => {
    const line = summaryLine({ total: 0, attested: 0, unproven: 0, contradicted: 0 });
    expect(line).not.toContain("0 of 0");
    expect(line).toContain("reached no assets");
  });
});

describe("the assurance line", () => {
  it("states the reach as well as the count, since coverage stops where the walk did", () => {
    expect(assuranceLine({ hopsWalked: 3, assetsReached: 6, evidenceRecords: 9 })).toBe(
      "Walked 3 hops downstream, reached 6 assets, built from 9 ledger records",
    );
  });

  it("agrees every noun with its own number", () => {
    expect(assuranceLine({ hopsWalked: 1, assetsReached: 1, evidenceRecords: 1 })).toBe(
      "Walked 1 hop downstream, reached 1 asset, built from 1 ledger record",
    );
  });
});

describe("every residue reason says something", () => {
  it("words all eleven kinds without leaving one to a fallback", () => {
    for (const reason of REASONS) {
      const sentence = reasonSentence(reason, "customers");
      expect(sentence.length, `${reason.kind} says nothing`).toBeGreaterThan(10);
      expect(sentence, `${reason.kind} leaked its own kind`).not.toContain(reason.kind);
    }
  });

  it("does not put an em dash on the board", () => {
    for (const reason of REASONS) {
      expect(reasonSentence(reason, "customers")).not.toContain("—");
    }
  });
});
