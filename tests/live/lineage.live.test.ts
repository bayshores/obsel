/**
 * Reading somebody else's lineage graph, and refusing to write to it.
 *
 * Erasure coverage is entirely about assets obsel did not create, so these two
 * capabilities arrive together on purpose: the moment obsel can name a
 * snowflake table, it can also be pointed at one by a careless call site. The
 * refusal is tested here beside the read for that reason.
 *
 * Against the `showcase-ecommerce` datapack on a real DataHub. Nothing here is
 * seeded by obsel: these are somebody else's entities with somebody else's
 * lineage, which is the only kind of graph the coverage rule is interesting on.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { requireDataHub } from "./reachable";

const { readLineageDownstream, relationships, updateTaskProperties } =
  await import("@/src/server/datahub/client");
const { LINEAGE_EDGE } = await import("@/src/server/datahub/urns");

/**
 * The showcase pack's real URNs, which carry a database segment.
 *
 * Written out rather than searched for, because a test that discovers its own
 * subject cannot fail when the subject is missing — it just tests nothing. If
 * the datapack is absent these fail loudly, which is the intended behavior and
 * the same stance `reachable.ts` takes about DataHub itself.
 */
const SNOWFLAKE = "urn:li:dataPlatform:snowflake";
const CUSTOMERS = `urn:li:dataset:(${SNOWFLAKE},b2fd91.order_entry_db.order_entry.customers,PROD)`;
const ORDER_DETAILS = `urn:li:dataset:(${SNOWFLAKE},b2fd91.order_entry_db.analytics.order_details,PROD)`;

beforeAll(async () => {
  await requireDataHub();
});

describe("walking a real catalog's lineage", () => {
  it("reaches several platforms from one PII-bearing source table", async () => {
    /*
     * The thing worth demonstrating, and the reason the coverage rule binds to
     * recorded lineage rather than to a producing job: a person's row in one
     * snowflake table is visible from dashboards on three other platforms, and
     * DataHub already knows the whole path.
     */
    const reach = await readLineageDownstream([CUSTOMERS], 3);

    expect(reach.reachable.length).toBeGreaterThan(10);
    expect(reach.reachable).toContain(CUSTOMERS);

    const platforms = new Set(
      reach.reachable
        .filter((urn) => urn.includes("dataPlatform:"))
        .map((urn) => urn.split("dataPlatform:")[1].split(",")[0]),
    );
    // Snowflake into dbt into the BI tools. A single-platform answer would mean
    // the walk stopped at the first hop and nobody noticed.
    expect(platforms.size).toBeGreaterThanOrEqual(3);
    expect(platforms).toContain("snowflake");
  }, 300_000);

  it("returns tables as upstreams, never the columns riding the same edge type", async () => {
    /*
     * The trap this filter exists for, asserted against the numbers that
     * revealed it. `order_details` answers with 109 upstream edges, of which 12
     * are datasets and 97 are `schemaField` URNs, because column-level lineage
     * is recorded down the same `DownstreamOf` edge.
     *
     * Without the filter the erasure kernel would cross-check an attestor's
     * declared inputs against ninety-seven column URNs, refuse every rebuild
     * claim on this table for not declaring them, and paint a board red for a
     * reason no operator could act on. Nothing in the shape of the API suggests
     * this; only running it does.
     */
    const raw = await relationships(ORDER_DETAILS, "OUTGOING", LINEAGE_EDGE);
    const fields = raw.filter((urn) => urn.startsWith("urn:li:schemaField:"));
    expect(
      fields.length,
      "the schemaField edges this filter exists for should be present",
    ).toBeGreaterThan(0);

    const reach = await readLineageDownstream([ORDER_DETAILS], 1);
    const upstreams = reach.upstreamOf[ORDER_DETAILS] ?? [];

    expect(upstreams.length).toBeGreaterThan(0);
    for (const upstream of upstreams) {
      expect(upstream.startsWith("urn:li:dataset:"), upstream).toBe(true);
    }
    // Deduplicated as well as filtered: the raw edge list repeats a table once
    // per column pair.
    expect(new Set(upstreams).size).toBe(upstreams.length);
    expect(upstreams.length).toBeLessThan(raw.length);
  }, 300_000);

  it("collects upstreams for assets the downstream walk reached, not only the seeds", async () => {
    // The CLOSED condition is checked per asset, so an asset reached at hop two
    // needs its own upstream set. Deriving it from the downstream edges already
    // walked would give a partial view and pass declarations that should fail.
    const reach = await readLineageDownstream([CUSTOMERS], 2);

    for (const asset of reach.reachable) {
      expect(Object.hasOwn(reach.upstreamOf, asset), `no upstream entry for ${asset}`).toBe(true);
    }
    // At least one asset downstream of the seed has recorded upstreams of its
    // own, or the cross-check would have nothing to check anywhere.
    const withUpstream = reach.reachable.filter((a) => (reach.upstreamOf[a] ?? []).length > 0);
    expect(withUpstream.length).toBeGreaterThan(0);
  }, 300_000);
});

describe("refusing to write onto an entity obsel did not create", () => {
  it("refuses a foreign URN, and leaves every aspect of it untouched", async () => {
    /*
     * `updateTaskProperties` rebuilds `dataJobInfo` from four fields, because
     * the OpenAPI upsert replaces the aspect wholesale. On an obsel job that is
     * lossless. On somebody's real entity it would drop `externalUrl`, `created`
     * and `flowUrn`, which is a team's link back to their own orchestrator, in a
     * tool whose stated promise is that its writes are additive and reversible.
     *
     * The subject is a real showcase dataset, read before and after, so this
     * asserts nothing happened rather than that an exception was thrown.
     */
    const before = await snapshotAspects(CUSTOMERS);
    expect(before.length, "the showcase dataset should have aspects to protect").toBeGreaterThan(3);

    await expect(updateTaskProperties(CUSTOMERS, { "obsel.status": "stale" })).rejects.toThrow(
      /refusing to write obsel properties/,
    );

    const after = await snapshotAspects(CUSTOMERS);
    expect(after).toEqual(before);
  }, 120_000);

  it("refuses before it reads, so a nonexistent foreign URN fails the same way", async () => {
    // The guard is on the URN, not on what happens to be in DataHub. A call site
    // that had the wrong URN must be told what it did wrong, not told the entity
    // is missing and encouraged to create it.
    const invented = `urn:li:dataset:(${SNOWFLAKE},b2fd91.nothing.here_at_all,PROD)`;
    await expect(updateTaskProperties(invented, { "obsel.status": "stale" })).rejects.toThrow(
      /refusing to write obsel properties/,
    );
  }, 120_000);

  it("still writes to a task in obsel's own flow", async () => {
    // The guard refusing everything would pass both tests above and break the
    // product, so the positive case is asserted in the same file.
    const { registerTask } = await import("@/src/server/coordinator/engine");
    const task = await registerTask("lineage_guard_subject", ["raw_orders"], ["guard_out"]);
    const updated = await updateTaskProperties(task.urn, { "obsel.status": "registered" });
    expect(updated.status).toBe("registered");
  }, 300_000);
});

/** Aspect names DataHub currently holds for an entity, sorted. */
async function snapshotAspects(urn: string): Promise<string[]> {
  const response = await fetch(
    `${process.env.DATAHUB_GMS_URL ?? "http://localhost:8080"}/openapi/v3/entity/dataset/${encodeURIComponent(urn)}`,
    { signal: AbortSignal.timeout(20_000) },
  );
  if (!response.ok) throw new Error(`reading ${urn} answered ${response.status}`);
  const body = (await response.json()) as Record<string, unknown>;
  return Object.keys(body).sort();
}
