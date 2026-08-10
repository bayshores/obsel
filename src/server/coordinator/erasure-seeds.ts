/**
 * Which of a request's seeds DataHub has no dataset for, and the refusal.
 *
 * A seed is where the walk starts. `GET /relationships` answers a URN nobody
 * ever wrote with an empty relationship list rather than an error, so a
 * mistyped table name walks nowhere: the request reaches exactly that one
 * string, reports one `UNPROVEN` row, and says `assetsReached: 1`. A real
 * one-asset estate looks identical — the postgres copy of
 * `order_entry.customers` reaches one asset because DataHub records no
 * downstream edges from it. Nothing in either report separates them, so the
 * request is refused at the door rather than answered over the wrong estate.
 *
 * This file is pure. Existence is decided by the caller against
 * `GET /openapi/v3/entity/dataset/<urn>`, the endpoint that genuinely 404s
 * (`docs/environment-findings.md` §1), never `GET /entities/<urn>`, which
 * synthesises a response for any syntactically valid URN. What is here is what
 * to do with those answers.
 *
 * Refusing is all this does. It adds no state, no vocabulary and no claim about
 * any asset: an asset obsel never walked to is not attested absent, and a
 * request obsel refused reports nothing about anybody.
 */

/** One seed and whether DataHub returned an entity for it. */
export interface SeedCheck {
  seed: string;
  exists: boolean;
}

/** Every seed with no dataset behind it, sorted and deduplicated. */
export function unknownSeeds(checks: readonly SeedCheck[]): string[] {
  const missing = checks.filter((check) => !check.exists).map((check) => check.seed);
  return [...new Set(missing)].sort();
}

/**
 * The refusal, naming every unknown seed rather than the first.
 *
 * A caller that mistyped two seeds and fixed one would otherwise resubmit and be
 * refused again for the second, learning one typo per round trip.
 */
export function unknownSeedsMessage(unknown: readonly string[]): string {
  const label = unknown.length === 1 ? "seed" : "seeds";
  return `DataHub has no dataset for ${unknown.length} ${label}: ${unknown.join(", ")}`;
}

/** Thrown when a request names a seed DataHub does not know. */
export class UnknownSeedsError extends Error {
  readonly unknownSeeds: string[];

  constructor(unknown: string[]) {
    super(unknownSeedsMessage(unknown));
    this.name = "UnknownSeedsError";
    this.unknownSeeds = unknown;
  }
}
