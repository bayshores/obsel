/**
 * The link from obsel's board into DataHub's own UI.
 *
 * These assertions exist because the obvious implementation is wrong. DataHub
 * escapes a URN with a deliberately partial rule, and `encodeURIComponent` produces
 * a string its matching decoder mangles, so a link that looks correct fails when
 * clicked. The rule is copied from the bundle the running instance serves; these
 * tests pin obsel to it.
 */

import { describe, expect, it } from "vitest";

import { datahubTaskUrl, encodeDataHubUrn } from "@/src/features/dashboard/datahub-link";
import { taskUrn } from "@/src/server/datahub/urns";

const BASE = "http://localhost:9002";

describe("encodeDataHubUrn", () => {
  it("leaves the characters DataHub leaves alone", () => {
    // Colons, parentheses and commas are every special character an obsel task URN
    // actually contains, and DataHub puts all of them in the path raw. Percent
    // encoding them is what breaks the link.
    const urn = taskUrn("write_docs");
    expect(encodeDataHubUrn(urn)).toBe(urn);
    expect(encodeDataHubUrn(urn)).toContain(":");
    expect(encodeDataHubUrn(urn)).toContain("(");
    expect(encodeDataHubUrn(urn)).not.toContain("%3A");
  });

  it("escapes exactly the six characters DataHub escapes", () => {
    expect(encodeDataHubUrn("a/b")).toBe("a%2Fb");
    expect(encodeDataHubUrn("a?b")).toBe("a%3Fb");
    expect(encodeDataHubUrn("a#b")).toBe("a%23b");
    expect(encodeDataHubUrn("a[b]")).toBe("a%5Bb%5D");
  });

  it("turns a percent into DataHub's placeholder, not into %25", () => {
    // Looks like a bug and is not: it is how DataHub avoids decoding its own escapes
    // twice. obsel reproduces it so the link is byte-identical to the one DataHub's
    // UI would generate, rather than one obsel thinks is tidier.
    expect(encodeDataHubUrn("a%b")).toBe("a{{encoded_percent}}b");
    expect(encodeDataHubUrn("a%2Fb")).toBe("a{{encoded_percent}}2Fb");
  });

  it("does not double-escape an already-escaped slash", () => {
    // The percent goes first in DataHub's chain, which is what makes this hold.
    expect(encodeDataHubUrn("a%b/c")).toBe("a{{encoded_percent}}b%2Fc");
  });
});

describe("datahubTaskUrl", () => {
  it("points at the entity path DataHub registers for a DataJob", () => {
    // `getPathName=()=>"tasks"` on DataHub's DataJob entity, read out of the bundle
    // the local instance serves. Not `/dataJob/`, which is the graph name.
    expect(datahubTaskUrl(BASE, taskUrn("write_docs"))).toBe(
      `${BASE}/tasks/urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),write_docs)`,
    );
  });

  it("tolerates a trailing slash on the configured base", () => {
    // `.env.local` is hand-edited, so both spellings will happen.
    expect(datahubTaskUrl(`${BASE}/`, taskUrn("write_docs"))).toBe(
      datahubTaskUrl(BASE, taskUrn("write_docs")),
    );
    expect(datahubTaskUrl(`${BASE}///`, taskUrn("write_docs"))).not.toContain("//tasks");
  });
});
