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

/** The single DataFlow the demo swarm's tasks belong to. */
export const FLOW_ID = "orders_pipeline";

/** DataHub's own edge names on the `dataJobInputOutput` aspect. */
export const READS_EDGE = "Consumes";
export const WRITES_EDGE = "Produces";

/** Edge from a DataJob to the DataFlow it belongs to. Used to enumerate a swarm. */
export const MEMBERSHIP_EDGE = "IsPartOf";

/** The tag obsel applies to stale work. Registered during setup; obsel cannot mint it. */
export const STALE_TAG_URN = "urn:li:tag:obsel-stale";

export const FLOW_URN = `urn:li:dataFlow:(${PLATFORM},${FLOW_ID},prod)`;

/**
 * Dataset URN for a short name like `clean_orders`.
 *
 * The namespace is added here rather than by every caller, because the HTTP API
 * takes short names. An already-qualified name is passed through unchanged so a
 * URN built from a round-tripped name cannot end up double-prefixed.
 */
export function datasetUrn(name: string): string {
  const qualified = name.startsWith(`${DATASET_NAMESPACE}.`)
    ? name
    : `${DATASET_NAMESPACE}.${name}`;
  return `urn:li:dataset:(urn:li:dataPlatform:${PLATFORM},${qualified},PROD)`;
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
