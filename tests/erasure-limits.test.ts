/**
 * The vocabulary table, enforced on the sentences the report ships.
 *
 * `CLAUDE.md` and `docs/erasure-coverage.md` both carry a table of words obsel
 * never says about erasure: "proof", "proven clean", "complete". Every other
 * place that rule is kept is a matter of somebody having read the table before
 * writing a string. These sentences are the ones most likely to be edited by
 * someone reaching for reassurance, because their whole job is to be the
 * caveat, so the rule is checked here rather than trusted.
 *
 * The forbidden list is deliberately about the words, not the sentiment. A
 * check that tried to judge whether a caveat was honest enough would be a
 * check nobody could make fail on purpose.
 */

import { describe, expect, it } from "vitest";

import { ASSURANCE_LIMITS } from "@/src/server/coordinator/erasure";

/**
 * Word-boundary matches, so "incomplete" is not read as "complete" and a
 * sentence saying obsel cannot establish absence is not failed for the word it
 * is denying.
 */
const FORBIDDEN = /\b(proof|proven|proves|complete|completely)\b/i;

describe("the report's stated limits", () => {
  it("exist, and are not empty sentences", () => {
    expect(ASSURANCE_LIMITS.length).toBeGreaterThan(0);
    for (const limit of ASSURANCE_LIMITS) {
      expect(limit.trim().length).toBeGreaterThan(0);
    }
  });

  it("use none of the words the vocabulary table forbids", () => {
    for (const limit of ASSURANCE_LIMITS) {
      expect(FORBIDDEN.test(limit), `forbidden vocabulary in: ${limit}`).toBe(false);
    }
  });

  /*
   * One pin per sentence, not per limit. The sentences are what a reader is
   * left holding, and an edit that shortens a limit by a sentence reads as
   * tidying rather than as dropping a caveat, so each sentence gets a substring
   * only it contains. A pin that matched two sentences would survive the
   * deletion of either one and would therefore guard neither.
   */
  it("pins every sentence, so no caveat can be dropped without a failing test", () => {
    const all = ASSURANCE_LIMITS.join(" ").toLowerCase();
    // What the walk covered, and who did the attesting. A report whose caveats
    // dropped either one would leave its numbers reading as a statement about
    // an estate obsel never saw, or as a measurement obsel never took.
    expect(all).toContain("lineage");
    expect(all).toContain("no warehouse credentials");
    /*
     * And the reach of that walk in the other direction: DataHub's lineage is
     * the whole input, so an asset nobody catalogued is absent from the counts
     * rather than counted unattested. Without this sentence the first limit
     * says where the numbers came from and not what they leave out.
     */
    expect(all).toContain("nobody catalogued");
    /*
     * What an attestation is. The credentials sentence beside it says obsel
     * cannot establish absence itself; this one says what stands in its place,
     * and a reader who lost it would have the denial without the substitute.
     */
    expect(all).toContain("signed claim by a named attestor");
    /*
     * And where the version beside each asset came from. obsel learns of a write
     * only when somebody attests to it, so an asset written since its last
     * attestation keeps being reported at the older, attested version. A reader
     * quoting the counts onward cannot tell that from the numbers, and the tab
     * does not render these sentences, so the payload is the only place it can
     * be said.
     */
    expect(all).toContain("latest attestation names");
    /*
     * Both cases, because the sentence is fixed text quoted onward beside the
     * counts and has to hold for every row it is quoted beside. An asset nobody
     * has attested to has no attestation to name a version, and
     * `erasure-engine.ts` reports it at "unknown"; a caveat phrased only around
     * the attested case would be strictly false of those rows. They are counted
     * unattested either way, so the error could not have inflated the numbers,
     * but it would still be a false sentence travelling with them.
     */
    expect(all).toContain("unknown version");
    /*
     * And the reason that limit exists at all: a version here moves only when
     * an attestor reports one, so an asset written since its last attestation
     * keeps being reported over the earlier version. The two pins above cover
     * where the version came from; without this one, the sentence saying what
     * that costs could be deleted and this file would still pass.
     */
    expect(all).toContain("written since its last attestation");
  });
});
