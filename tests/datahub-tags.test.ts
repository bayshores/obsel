/**
 * Reading the one aspect obsel does not own.
 *
 * Every other value obsel reads back is a value obsel wrote, under an `obsel.`
 * prefix, in a format it controls. `globalTags` is shared: a human, an ingestion
 * recipe, or another tool can put tags on the same DataJob. So this parser is the
 * one place a foreign shape can arrive, and every case below is a shape obsel might
 * genuinely be handed rather than a hypothetical.
 */

import { describe, expect, it } from "vitest";

import { hasStaleTag, parseTagUrns } from "@/src/server/datahub/tags";
import { STALE_TAG_URN } from "@/src/server/datahub/urns";

describe("parseTagUrns", () => {
  it("reads the tags DataHub reports", () => {
    expect(parseTagUrns([{ tag: STALE_TAG_URN }])).toEqual([STALE_TAG_URN]);
  });

  it("returns nothing, rather than throwing, when the aspect is absent", () => {
    // A job that has never been tagged has no `globalTags` aspect at all, which is
    // the common case: three of four tasks on a calm board look like this. Throwing
    // here would fail the whole snapshot read and blank the board.
    expect(parseTagUrns(undefined)).toEqual([]);
    expect(parseTagUrns(null)).toEqual([]);
  });

  it("keeps a human-authored tag beside obsel's own", () => {
    // The details panel renders this list in full, and that is deliberate: a tag
    // someone else wrote sitting next to obsel-stale is the visible evidence that
    // obsel's writes are additive and replaced nobody's metadata.
    const tags = parseTagUrns([{ tag: "urn:li:tag:pii" }, { tag: STALE_TAG_URN }]);
    expect(tags).toContain("urn:li:tag:pii");
    expect(tags).toContain(STALE_TAG_URN);
  });

  it("drops an unusable entry instead of raising", () => {
    // Drops rather than raises, following parseRun and not parseStale. The tag is
    // evidence obsel reports, never evidence it reasons over, so one bad entry must
    // not blind the board. The visible cost is that the write-back count reads low,
    // which understates obsel rather than claiming a write that never landed.
    const tags = parseTagUrns([
      { tag: STALE_TAG_URN },
      { tag: "" },
      { tag: 42 },
      {},
      null,
      "urn:li:tag:not-an-object",
    ]);
    expect(tags).toEqual([STALE_TAG_URN]);
  });

  it("returns nothing when the aspect is not a list at all", () => {
    expect(parseTagUrns({ tag: STALE_TAG_URN })).toEqual([]);
    expect(parseTagUrns("urn:li:tag:obsel-stale")).toEqual([]);
  });

  it("sorts, so the details panel does not reshuffle between polls", () => {
    const first = parseTagUrns([{ tag: "urn:li:tag:zeta" }, { tag: "urn:li:tag:alpha" }]);
    const second = parseTagUrns([{ tag: "urn:li:tag:alpha" }, { tag: "urn:li:tag:zeta" }]);
    expect(first).toEqual(second);
    expect(first).toEqual(["urn:li:tag:alpha", "urn:li:tag:zeta"]);
  });
});

describe("hasStaleTag", () => {
  it("recognises obsel's own tag and nothing else", () => {
    expect(hasStaleTag([STALE_TAG_URN])).toBe(true);
    expect(hasStaleTag([])).toBe(false);
    expect(hasStaleTag(["urn:li:tag:pii"])).toBe(false);
  });

  it("does not match on a prefix or a near miss", () => {
    // A substring match here would count someone else's tag as obsel's write and
    // report a confirmation that never happened.
    expect(hasStaleTag(["urn:li:tag:obsel-stale-old"])).toBe(false);
    expect(hasStaleTag(["urn:li:tag:obsel"])).toBe(false);
  });
});
