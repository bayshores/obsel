/**
 * URN construction and parsing, mirroring `agents/graph.py`.
 *
 * The Python emitter and this module must agree character for character: they
 * write and read the same entities, and a URN that differs by one character is a
 * different entity in DataHub rather than an error. Everything here is pure so
 * the shapes can be checked without standing anything up.
 */

/** DataHub data platform obsel registers its demo datasets under. */
export const PLATFORM = "obsel";

/** Namespace prefix on every demo dataset, e.g. `obsel_demo.clean_orders`. */
export const DATASET_NAMESPACE = "obsel_demo";

/**
 * The DataFlow the swarm's tasks belong to.
 *
 * `OBSEL_FLOW_ID` overrides it, and the override exists for one reason: obsel's
 * integration tests write into a **real** DataHub, so without it they would register
 * into the demo's own flow and `resetSwarm` would wipe whatever board the operator had
 * on screen. Pointing them at their own flow keeps every entity, edge, property and
 * tag genuine while leaving the demo alone.
 *
 * `agents/pipeline.py` reads the same variable with the same default, because the two
 * implementations write and read the same entities and a URN differing by one
 * character is a different entity rather than an error. `tests/urns.test.ts` asserts
 * they still agree.
 */
export const FLOW_ID = process.env.OBSEL_FLOW_ID ?? "orders_pipeline";

/** DataHub's own edge names on the `dataJobInputOutput` aspect. */
export const READS_EDGE = "Consumes";
export const WRITES_EDGE = "Produces";

/**
 * Dataset-to-dataset lineage, which is what a real catalog actually records.
 *
 * Measured on `showcase-ecommerce` 2026-07-26 and written up in
 * `docs/environment-findings.md` §13: `snowflake analytics.order_details` has
 * 109 `DownstreamOf` edges resolving to 12 distinct upstream datasets and
 * **zero** producing DataJobs. Across the instance, 45 of 73 datasets have no
 * producing job at all. Anything that traverses by job on a real estate goes
 * blind on most of it.
 *
 * The direction convention is the trap and was verified against a known
 * snowflake/dbt pair rather than assumed: `OUTGOING` returns the dataset's
 * UPSTREAMS, `INCOMING` returns its downstreams. Getting it backwards produces
 * a plausible non-empty answer about the wrong half of the graph.
 */
export const LINEAGE_EDGE = "DownstreamOf";

/** Whether a dataset URN is one obsel itself registered, rather than a foreign one. */
export function isObselDataset(urn: string): boolean {
  return urn.startsWith(`urn:li:dataset:(urn:li:dataPlatform:${PLATFORM},`);
}

/** Edge from a DataJob to the DataFlow it belongs to. Used to enumerate a swarm. */
export const MEMBERSHIP_EDGE = "IsPartOf";

/** The tag obsel applies to stale work. Registered during setup; obsel cannot mint it. */
export const STALE_TAG_URN = "urn:li:tag:obsel-stale";

export const FLOW_URN = `urn:li:dataFlow:(${PLATFORM},${FLOW_ID},prod)`;

/**
 * Dataset URN for a short name like `clean_orders`, or a qualified one like
 * `obsel_taxi.clean_trips`.
 *
 * The demo namespace is added here rather than by every caller, because the
 * HTTP API takes short names. Any name already carrying a namespace — a dot —
 * is passed through unchanged: the scale swarm registers under its own
 * namespace, and the earlier prefix-only check would have double-prefixed it
 * into `obsel_demo.obsel_taxi.clean_trips`, a URN nothing else builds.
 *
 * **A fully-qualified URN is passed through untouched**, which is what lets
 * obsel refer to a table it did not create. Everything this function built
 * before carried `urn:li:dataPlatform:obsel`, so a snowflake table or a looker
 * dashboard was not merely inconvenient to name, it was unrepresentable, and
 * erasure coverage is entirely about assets on somebody else's platform. Passing
 * one through here does NOT make it writable: `updateTaskProperties` refuses
 * anything outside obsel's own flow, for the reason recorded there.
 */
export function datasetUrn(name: string): string {
  if (name.startsWith("urn:li:dataset:(")) return name;
  const qualified = name.includes(".") ? name : `${DATASET_NAMESPACE}.${name}`;
  return `urn:li:dataset:(urn:li:dataPlatform:${PLATFORM},${qualified},PROD)`;
}

/**
 * The shape a name has to have for `datasetUrn` and `datasetName` to be inverses.
 *
 * `datasetName`, `shortName` in `src/features/dashboard/naming.ts` and
 * `dataset_short_name` in `agents/mcp_core.py` all recover a name by splitting on
 * commas and then on dots. So a comma or an extra dot inside the name is not
 * cosmetic: `datasetUrn("a,b")` builds a URN whose second comma-separated segment
 * is `a`, and every reader recovers `a` rather than `a,b`. The DataJob is created,
 * the board draws a box with the truncated name, and the lineage points at a URN
 * nobody can look up. Nothing downstream can detect it, so it has to be refused at
 * the door.
 *
 * Lowercase because that is what every table in the demo and the scale swarm is,
 * and a guard that admits `Clean_Orders` alongside `clean_orders` invites two boxes
 * on the board for one table.
 */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_]*$/;

/** Prose for the guard, so both doors and the docs say the same thing. */
const SHAPE = "lowercase letters, digits and underscores, starting with a letter or digit";

/**
 * Why this task id cannot be used, or null if it can.
 *
 * Returns the reason rather than a boolean because the caller's job is to hand a
 * model something it can act on, and "invalid name" is not actionable.
 */
export function taskNameProblem(name: string): string | null {
  if (NAME_PATTERN.test(name)) return null;
  return (
    `task name ${JSON.stringify(name)} is not a code identifier. Use ${SHAPE}, ` +
    `e.g. "build_revenue". The name is interpolated into this task's DataJob URN, ` +
    "so anything else builds an entity that cannot be read back by name."
  );
}

/**
 * Why this dataset name cannot be used, or null if it can.
 *
 * One optional namespace segment is allowed — `obsel_taxi.clean_trips` — because
 * the scale swarm registers under its own namespace and `datasetUrn` passes a
 * qualified name through untouched. A second dot is refused: the readers take the
 * LAST dot-separated segment, so `a.b.c` comes back as `c`.
 *
 * A full URN is refused too, and deliberately. `datasetUrn` passes one through for
 * obsel's own internal callers, which is what lets erasure name a snowflake table;
 * but the HTTP door takes short names, so a URN arriving here is a caller that has
 * not read the asymmetry, and it would be qualified into
 * `obsel_demo.urn:li:dataset:(…)` — a plausible entity that matches nothing.
 */
export function datasetNameProblem(name: string): string | null {
  const segments = name.split(".");
  if (segments.length <= 2 && segments.every((segment) => NAME_PATTERN.test(segment))) return null;
  const isUrn = name.startsWith("urn:li:");
  return (
    `dataset name ${JSON.stringify(name)} is not a table name. Use ${SHAPE}, ` +
    `e.g. "clean_orders", optionally with one namespace segment like ` +
    `"obsel_taxi.clean_trips". ` +
    (isUrn
      ? "This route takes SHORT names and builds the URNs itself; a URN sent here " +
        "would be qualified into obsel_demo.urn:li:dataset:(…), which is a different entity."
      : "The name is interpolated into the dataset URN and recovered by splitting on " +
        "commas and dots, so anything else names a table that cannot be looked up.")
  );
}

/** Short name of a dataset URN, e.g. `clean_orders`. Inverse of `datasetUrn`. */
export function datasetName(urn: string): string {
  const parts = urn.split(",");
  const qualified = parts.length > 1 ? parts[1] : urn;
  const segments = qualified.split(".");
  return segments[segments.length - 1];
}

/** DataJob URN for a task id like `build_revenue`, inside the demo flow. */
export function taskUrn(taskId: string): string {
  return `urn:li:dataJob:(${FLOW_URN},${taskId})`;
}

/**
 * Task id from a DataJob URN.
 *
 * A DataJob URN *nests* a DataFlow URN, so the id is the last comma-separated
 * segment, not the second to last, and it carries the closing parens of both
 * URNs. Reading the second-to-last segment yields `prod`, which looks plausible
 * and is wrong everywhere it is used.
 */
export function taskName(urn: string): string {
  const segments = urn.split(",");
  const last = segments[segments.length - 1];
  return last.replace(/\)+$/, "");
}

/** Whether a string is shaped like a DataJob URN in the demo flow. */
export function isTaskUrn(urn: string): boolean {
  return urn.startsWith(`urn:li:dataJob:(${FLOW_URN},`) && urn.endsWith(")");
}
