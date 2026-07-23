/**
 * Reading DataHub's `globalTags` aspect.
 *
 * Its own module, without the `server-only` guard `client.ts` carries, for the same
 * reason `urns.ts` has none: this is pure string handling with no I/O, and the guard
 * makes a module unimportable from a test as well as from the browser. `client.ts`
 * is untested precisely because everything in it sits behind that guard, so a pure
 * parser that lives there is a pure parser nothing can check.
 */

import { STALE_TAG_URN } from "./urns";

/**
 * Tag URNs from a `globalTags` aspect, sorted, with anything unusable dropped.
 *
 * Takes `unknown` on purpose. This is the one place obsel reads a DataHub aspect it
 * does not write itself — a human, another tool, or an ingestion recipe can put tags
 * on the same job — so the shape is genuinely not obsel's to assume, and typing the
 * argument would only move the assumption somewhere less honest.
 *
 * Sorted so the details panel renders a stable order across polls rather than
 * whatever order the aspect came back in, which would reshuffle once a second.
 *
 * **Drops rather than raises**, following `parseRun` and not `parseStale`. The tag
 * is evidence obsel reports, never evidence it reasons over: staleness is decided by
 * `compareFingerprints` on sha256 alone. A malformed entry must not fail a whole
 * snapshot read and blind the board over a field nothing depends on. The cost is
 * that a tag obsel cannot read goes uncounted, so the write-back figure reads low.
 * That is the honest direction to be wrong in — it understates obsel's own
 * contribution rather than claiming a write that did not land.
 */
export function parseTagUrns(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) =>
      typeof entry === "object" && entry !== null ? (entry as { tag?: unknown }).tag : undefined,
    )
    .filter((tag): tag is string => typeof tag === "string" && tag.length > 0)
    .sort();
}

/** Whether obsel's own stale tag is among them. */
export function hasStaleTag(tags: readonly string[]): boolean {
  return tags.includes(STALE_TAG_URN);
}
