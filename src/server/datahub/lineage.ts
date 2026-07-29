import "server-only";

/**
 * obsel's only traversal primitive, and the downstream walk built on it.
 *
 * **Traversal is `GET /relationships`, never GraphQL `searchAcrossLineage`.**
 * The GraphQL surface reads a search index that lagged by over 90 seconds on
 * freshly registered tasks and returned an empty list rather than an error.
 * obsel reasons about tasks registered seconds ago, so it would be blind
 * exactly when it matters, and the blindness would read as "nothing affected".
 * `docs/environment-findings.md` §7.
 */

import { DataHubError } from "./errors";
import { gmsJson } from "./gms";
import { LINEAGE_EDGE } from "./urns";

const RELATIONSHIP_PAGE_SIZE = 200;

export type RelationshipDirection = "INCOMING" | "OUTGOING";

interface RelationshipsResponse {
  start: number;
  count: number;
  total: number;
  relationships: { type: string; entity: string }[];
}

/**
 * One hop of the lineage graph, read from the graph store.
 *
 * The response is paged, and a partial page silently truncated would understate
 * what a change breaks, so pages are followed until `total` is covered.
 */
export async function relationships(
  urn: string,
  direction: RelationshipDirection,
  type: string,
): Promise<string[]> {
  const found: string[] = [];
  let start = 0;

  for (;;) {
    const query = new URLSearchParams({
      urn,
      direction,
      types: type,
      start: String(start),
      count: String(RELATIONSHIP_PAGE_SIZE),
    });
    const page = await gmsJson<RelationshipsResponse>(`/relationships?${query}`);

    // The response shape is checked rather than trusted. An unexpected body would
    // otherwise fall through `?? []` and return an empty list as though the call
    // succeeded — and an empty list from the only traversal primitive means
    // "nothing is affected" everywhere downstream.
    if (!Array.isArray(page.relationships) || typeof page.total !== "number") {
      throw new DataHubError(
        `unusable /relationships response for ${urn} (${direction} ${type}): ` +
          `expected relationships[] and a numeric total, got ${JSON.stringify(page).slice(0, 200)}`,
      );
    }

    for (const edge of page.relationships) found.push(edge.entity);

    start += RELATIONSHIP_PAGE_SIZE;
    if (found.length >= page.total || page.relationships.length === 0) break;
  }

  return found;
}

/** What one downstream walk found: the assets reached, and each one's upstreams. */
export interface LineageReach {
  /** Every dataset reachable downstream of the seeds, seeds included. Sorted. */
  reachable: string[];
  /**
   * Upstream datasets DataHub records for each reachable asset.
   *
   * This is the independent source the erasure kernel's CLOSED condition is
   * checked against, which is why it is collected during the same walk rather
   * than re-derived later from the downstream edges. The two are not the same
   * set: an asset reached from one seed usually has upstreams the walk never
   * visited, and cross-checking a rebuild declaration against a partial view of
   * its inputs would pass declarations that should be refused.
   */
  upstreamOf: Record<string, string[]>;
}

/**
 * Walk the real lineage graph downstream from a set of seed datasets.
 *
 * Dataset-to-dataset, not through jobs. On `showcase-ecommerce` a walk by
 * producing job sees almost nothing, because 45 of 73 datasets have no job
 * recorded; the `DownstreamOf` edges carry the same information and are
 * actually present. `docs/environment-findings.md` §13.
 *
 * `maxHops` is a real bound rather than a safety net. The traversal already
 * terminates on its visited set, but an unbounded walk on a large estate is a
 * long series of live calls with no upper bound on how long an operator waits,
 * and a coverage report over three hops that arrives is worth more than one over
 * nine that times out. Where the walk stopped is reported by the caller as an
 * assurance gap rather than passed off as the whole graph.
 */
export async function readLineageDownstream(seeds: string[], maxHops = 3): Promise<LineageReach> {
  const seen = new Set(seeds);
  const upstreamOf: Record<string, string[]> = {};
  let frontier = [...seeds];

  for (let hop = 0; hop < maxHops && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const asset of frontier) {
      // INCOMING is downstream, OUTGOING is upstream. Verified against a known
      // pair rather than assumed, because reversing it returns a plausible
      // non-empty answer about the wrong half of the graph.
      const downstream = await relationships(asset, "INCOMING", LINEAGE_EDGE);
      for (const found of onlyDatasets(downstream)) {
        if (seen.has(found)) continue;
        seen.add(found);
        next.push(found);
      }
    }
    frontier = next;
  }

  // Collected after the walk so each asset is asked exactly once however many
  // paths reached it.
  const reachable = [...seen].sort();
  for (const asset of reachable) {
    const upstream = await relationships(asset, "OUTGOING", LINEAGE_EDGE);
    upstreamOf[asset] = [...new Set(onlyDatasets(upstream))].sort();
  }

  return { reachable, upstreamOf };
}

/**
 * Datasets only. `DownstreamOf` returns column-level lineage down the same edge
 * type, and most of what comes back is not a table.
 *
 * Measured on this instance rather than guessed: `analytics.order_details`
 * answers with 109 upstream edges, of which **12 are datasets and 97 are
 * `schemaField` URNs**. Column-level lineage is a genuine feature and obsel may
 * use it later; what it must not do is arrive unnoticed in an input set.
 *
 * The consequence of skipping this filter is specific and silent. The erasure
 * kernel cross-checks an attestor's declared inputs against these edges, so
 * every rebuild claim on this table would be refused for failing to declare
 * ninety-seven columns as if they were upstream tables — a page that is red
 * everywhere for a reason that is nobody's fault and that no operator could
 * act on. `docs/environment-findings.md` §13.
 */
function onlyDatasets(urns: string[]): string[] {
  return urns.filter((urn) => urn.startsWith("urn:li:dataset:"));
}
