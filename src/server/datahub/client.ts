import "server-only";

/**
 * obsel's read and write path into DataHub over GMS HTTP.
 *
 * There is no local database. A task is a `DataJob`, what it reads and writes are
 * `Consumes`/`Produces` lineage edges, and everything else about it is carried in
 * that DataJob's `dataJobInfo.customProperties` under an `obsel.` prefix. This
 * module is the only place that mapping is known.
 *
 * Two deliberate choices, both measured (see `docs/environment-findings.md`):
 *
 * - **Traversal is `GET /relationships`, never GraphQL `searchAcrossLineage`.**
 *   The GraphQL surface reads a search index that lagged by over 90 seconds on
 *   freshly registered tasks and returned an empty list rather than an error.
 *   obsel reasons about tasks registered seconds ago, so it would be blind
 *   exactly when it matters, and the blindness would read as "nothing affected".
 * - **Existence is never established with `GET /entities/<urn>`.** That endpoint
 *   synthesises a well-formed response for any syntactically valid URN including
 *   invented ones. `GET /openapi/v3/entity/datajob/<urn>` does return 404 for a
 *   URN that was never written, verified on this instance, so it is used instead.
 *
 * Failures throw. Nothing here degrades to an empty array, because in this
 * product an empty result means "nothing is affected" and that is the one wrong
 * answer nobody would question.
 */

import type {
  ChangeKind,
  ColumnChange,
  OutputFingerprint,
  OutputShape,
  RunDetail,
  StaleMark,
  SwarmSnapshot,
  TaskRecord,
  TaskStatus,
} from "@/src/server/coordinator/types";
import { hasStaleTag, parseTagUrns } from "./tags";
import {
  DATASET_NAMESPACE,
  FLOW_URN,
  MEMBERSHIP_EDGE,
  LINEAGE_EDGE,
  PLATFORM,
  datasetUrn,
  isTaskUrn,
  taskName,
  taskUrn,
} from "./urns";

/** `customProperties` keys obsel owns. Everything else on the aspect is left alone. */
export const PROP = {
  status: "obsel.status",
  /**
   * The task's short human name, e.g. "Orders cleaner" for `clean_orders`.
   *
   * A property rather than the DataJob's `name`, which is the code identifier the
   * URN is built from and which every assertion, test and traversal keys on.
   * Display only: nothing obsel decides reads this.
   */
  title: "obsel.title",
  finishedAt: "obsel.finishedAt",
  startedAt: "obsel.startedAt",
  fingerprints: "obsel.fingerprints",
  /**
   * The fingerprint each output held before the current one, kept when a
   * completion replaces it. One slot per dataset, written by the engine and
   * read by `classifyObservation`, which uses it to tell a reader that
   * straddled a re-report apart from a silent edit in a concurrent swarm.
   */
  previousFingerprints: "obsel.fingerprints.previous",
  /**
   * Reader-observed fingerprints of this task's outputs, kept only while they
   * disagree with `fingerprints`. Written when a completing task reports having
   * read a version of this output that was never recorded — the unreported
   * change — so the next reader of the same bytes compares clean instead of
   * re-flagging the cascade. Cleared when this task completes, and by reset.
   */
  observed: "obsel.observed",
  runRunner: "obsel.run.runner",
  runMs: "obsel.run.ms",
  runOutputs: "obsel.run.outputs",
  staleCausedBy: "obsel.stale.causedBy",
  staleCausedByTask: "obsel.stale.causedByTask",
  staleHops: "obsel.stale.hops",
  staleChangeKind: "obsel.stale.changeKind",
  /**
   * Which columns moved, as `{"added":[…],"removed":[…]}`.
   *
   * Describes the change `staleChangeKind` names, so the board can show
   * `order_total` leaving and `order_total_usd` arriving instead of a sha256.
   * Display only, like `title`: nothing obsel decides reads it, and staleness is
   * settled by `fingerprints` alone. Absent on a content-only change and on every
   * mark written before obsel recorded it.
   */
  staleColumns: "obsel.stale.columns",
  staleReason: "obsel.stale.reason",
  staleSince: "obsel.stale.since",
  staleDetectedMs: "obsel.stale.detectedMs",
} as const;

export type RelationshipDirection = "INCOMING" | "OUTGOING";

/** `null` clears a key. Undefined keys are left untouched. */
export type PropertyPatch = Record<string, string | null>;

const RELATIONSHIP_PAGE_SIZE = 200;
const DEFAULT_TIMEOUT_MS = 20_000;

/** Read lazily so a script or test can set the variable after importing this module. */
export function gmsUrl(): string {
  return process.env.DATAHUB_GMS_URL ?? "http://localhost:8080";
}

function headers(): Record<string, string> {
  const base: Record<string, string> = { "Content-Type": "application/json" };
  // Optional: the local quickstart disables auth entirely and issues no token.
  const token = process.env.DATAHUB_GMS_TOKEN;
  if (token) base.Authorization = `Bearer ${token}`;
  return base;
}

class DataHubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DataHubError";
  }
}

async function gmsFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = `${gmsUrl()}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { ...headers(), ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (cause) {
    // Name the endpoint: "fetch failed" alone sends people to the wrong port.
    throw new DataHubError(
      `DataHub request to ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        `GMS is port 8080; port 9002 is the frontend proxy and will not answer this.`,
    );
  }
  return response;
}

async function gmsJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await gmsFetch(path, init);
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new DataHubError(`DataHub ${response.status} on ${path}: ${body}`, response.status);
  }
  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

interface RelationshipsResponse {
  start: number;
  count: number;
  total: number;
  relationships: { type: string; entity: string }[];
}

/**
 * One hop of the lineage graph, read from the graph store.
 *
 * This is obsel's only traversal primitive. The response is paged, and a partial
 * page silently truncated would understate what a change breaks, so pages are
 * followed until `total` is covered.
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
    // "nothing is affected" everywhere downstream. That is the precise silent
    // blindness this file exists to prevent, so a surprising shape is an error.
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
 * Over `GET /relationships`, never GraphQL `searchAcrossLineage`, for the reason
 * in `docs/environment-findings.md` §7: the GraphQL surface is served from a
 * search index that lags minutes behind and answers with an empty list rather
 * than an error, and an empty list here reads as "nothing is affected".
 *
 * Dataset-to-dataset, not through jobs. On `showcase-ecommerce` a walk by
 * producing job sees almost nothing, because 45 of 73 datasets have no job
 * recorded; the `DownstreamOf` edges carry the same information and are
 * actually present. §13 has the measurement.
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

  // Upstreams for everything reached, including the seeds. Collected after the
  // walk so each asset is asked exactly once however many paths reached it.
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
 * `schemaField` URNs** like `urn:li:schemaField:(urn:li:dataset:(…),
 * cust_first_name)`. Column-level lineage is a genuine feature and obsel may
 * use it later; what it must not do is arrive unnoticed in an input set.
 *
 * The consequence of skipping this filter is specific and silent. The erasure
 * kernel cross-checks an attestor's declared inputs against these edges, so
 * every rebuild claim on this table would be refused for failing to declare
 * ninety-seven columns as if they were upstream tables — a board that is red
 * everywhere for a reason that is nobody's fault and that no operator could
 * act on. Found by running the walk against the real catalog; nothing in the
 * shape of the API suggests it.
 */
function onlyDatasets(urns: string[]): string[] {
  return urns.filter((urn) => urn.startsWith("urn:li:dataset:"));
}

// ---------------------------------------------------------------------------
// Reading a task
// ---------------------------------------------------------------------------

interface AspectEnvelope<T> {
  value: T;
}

interface DataJobInfoAspect {
  name: string;
  description?: string;
  type?: { string: string };
  customProperties?: Record<string, string>;
}

interface DataJobInputOutputAspect {
  inputDatasets?: string[];
  outputDatasets?: string[];
}

interface GlobalTagsAspect {
  tags: { tag: string }[];
}

interface DataJobEntity {
  urn: string;
  dataJobInfo?: AspectEnvelope<DataJobInfoAspect>;
  dataJobInputOutput?: AspectEnvelope<DataJobInputOutputAspect>;
  globalTags?: AspectEnvelope<GlobalTagsAspect>;
  /**
   * DataHub's own soft-delete mark, absent entirely on a live entity.
   *
   * Verified against this instance on 2026-07-28: `batchGet` returns
   * `status: {value: {removed: true}}` for a soft-deleted DataJob and omits the
   * aspect for a live one.
   */
  status?: AspectEnvelope<{ removed?: boolean }>;
}

/**
 * Whether DataHub has been told this entity is gone.
 *
 * Explicitly `=== true` rather than truthy: DataHub also writes
 * `removed: false`, and a check that read the aspect's presence would treat an
 * entity somebody restored as still deleted.
 */
function isRemoved(entity: DataJobEntity): boolean {
  return entity.status?.value.removed === true;
}

function entityPath(urn: string): string {
  return `/openapi/v3/entity/datajob/${encodeURIComponent(urn)}`;
}

/**
 * Raw entity, or null when it genuinely does not exist.
 *
 * Safe as an existence predicate, unlike `GET /entities/<urn>`: verified on this
 * instance that an invented DataJob URN returns 404 here.
 */
export async function readTaskEntity(urn: string): Promise<DataJobEntity | null> {
  const response = await gmsFetch(entityPath(urn));
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new DataHubError(`DataHub ${response.status} reading ${urn}: ${body}`, response.status);
  }
  return (await response.json()) as DataJobEntity;
}

export async function taskExists(urn: string): Promise<boolean> {
  return (await readTaskEntity(urn)) !== null;
}

/**
 * Whether a tag entity exists, by the same genuine-404 predicate as tasks.
 *
 * Used by the demo preflight to tell whether `agents.run setup` has been run
 * against this DataHub — obsel cannot create the tag itself at runtime, so
 * detecting staleness without this tag would succeed and then silently fail to
 * record anything a person can see.
 */
export async function tagExists(urn: string): Promise<boolean> {
  const response = await gmsFetch(`/openapi/v3/entity/tag/${encodeURIComponent(urn)}`);
  if (response.status === 404) return false;
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new DataHubError(`DataHub ${response.status} reading ${urn}: ${body}`, response.status);
  }
  return true;
}

/**
 * Tag URNs currently on a task, read straight from the entity.
 *
 * `globalTags` is a separate aspect from `dataJobInfo`, so it survives a
 * re-registration that replaces everything else — which is why a reset has to
 * clear it explicitly rather than assume it went with the properties.
 */
export async function readTagUrns(urn: string): Promise<string[]> {
  return parseTagUrns((await readTaskEntity(urn))?.globalTags?.value?.tags);
}

const STATUSES: readonly TaskStatus[] = ["registered", "running", "complete", "stale"];
const CHANGE_KINDS: readonly ChangeKind[] = ["schema", "content", "both"];

function parseStatus(raw: string | undefined, urn: string): TaskStatus {
  // A DataJob with no obsel status was declared but never run through obsel,
  // which is exactly what "registered" means.
  if (!raw) return "registered";
  if ((STATUSES as readonly string[]).includes(raw)) return raw as TaskStatus;
  throw new DataHubError(`task ${urn} has unrecognised ${PROP.status} "${raw}"`);
}

/**
 * Stored fingerprints, or `{}` only when none were ever written.
 *
 * Unparseable stored data throws rather than falling back to `{}`. An empty map
 * means "first run" to `compareFingerprints`, which means "nothing changed",
 * which would suppress every downstream mark without anyone noticing.
 */
function parseFingerprints(
  raw: string | undefined,
  urn: string,
  property: string = PROP.fingerprints,
): Record<string, OutputFingerprint> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new DataHubError(
      `task ${urn} has unreadable ${property}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DataHubError(`task ${urn} has a non-object ${property}`);
  }

  const fingerprints: Record<string, OutputFingerprint> = {};
  for (const [dataset, value] of Object.entries(parsed as Record<string, unknown>)) {
    const candidate = value as Partial<OutputFingerprint> | null;
    if (
      !candidate ||
      typeof candidate.schema !== "string" ||
      typeof candidate.content !== "string"
    ) {
      throw new DataHubError(`task ${urn} has a malformed fingerprint for ${dataset}`);
    }
    fingerprints[dataset] = { schema: candidate.schema, content: candidate.content };
  }
  return fingerprints;
}

/**
 * Read back what the last run said about itself, when it said anything.
 *
 * This is display-only material with one exception, so a half-written record is
 * dropped rather than raised: unlike a fingerprint or a stale mark, failing a
 * snapshot read over a cosmetic property would take the whole cockpit down.
 * Each of the three fields is judged on its own, and a missing one renders as
 * nothing at all rather than as a zero — "took 0 ms" is a measurement and "we
 * were not told" is not.
 *
 * **The exception is `outputs`, and it is why this no longer demands all
 * three.** Those column lists are what `columnChange` in `engine.ts` diffs to
 * name the columns that moved, so they are the difference between a mark
 * reading "clean expenses lost amount" and one reading "the columns in clean
 * expenses changed". Requiring a runner and a duration alongside them meant a
 * reporter with no stopwatch — the cockpit bench, where a person types the
 * table and there is no run to time — lost the shape as collateral.
 *
 * Null only when nothing usable was recorded at all.
 */
function parseRun(props: Record<string, string>): RunDetail | null {
  const runner = props[PROP.runRunner] || null;
  const parsedMs = Number.parseInt(props[PROP.runMs] ?? "", 10);
  const ms = Number.isFinite(parsedMs) && parsedMs >= 0 ? parsedMs : null;

  const outputs: Record<string, OutputShape> = {};
  const raw = props[PROP.runOutputs];
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { runner, ms, outputs };
    }
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      for (const [dataset, value] of Object.entries(parsed as Record<string, unknown>)) {
        const shape = value as Partial<OutputShape> | null;
        if (!shape || typeof shape.rows !== "number" || !Array.isArray(shape.columns)) continue;
        if (!Number.isFinite(shape.rows) || shape.rows < 0) continue;
        outputs[dataset] = {
          rows: shape.rows,
          columns: shape.columns.filter((name): name is string => typeof name === "string"),
          // The file's location per the writing agent, display only. Carried
          // when present and a string; anything else is dropped, not raised,
          // per this function's rule for cosmetic material.
          ...(typeof shape.path === "string" && shape.path !== "" ? { path: shape.path } : {}),
        };
      }
    }
  }

  // Nothing usable at all reads as never having been told, which is what an
  // absent record means and what the cockpit renders as no line rather than an
  // empty one.
  if (runner === null && ms === null && Object.keys(outputs).length === 0) return null;
  return { runner, ms, outputs };
}

/**
 * Read back which columns moved, when the mark recorded it.
 *
 * Null on anything unusable, never a partial or empty diff. This follows
 * `parseRun`'s rule rather than `parseStale`'s: the column names are display
 * material that nothing obsel decides depends on, so a malformed value renders as
 * absent instead of failing the whole snapshot read. `parseStale` raises on a
 * half-written mark because a mark with no traceable cause is not actionable;
 * that argument does not reach a description of the cause.
 *
 * An empty diff is treated as absent too. `{"added":[],"removed":[]}` would be a
 * schema change with nothing to show, which `columnChange` never produces, so
 * seeing one means the value is wrong rather than meaningful.
 */
function parseColumns(raw: string | undefined): ColumnChange | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const value = parsed as Partial<Record<"added" | "removed", unknown>>;
  const strings = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter((name): name is string => typeof name === "string") : [];

  const added = strings(value.added);
  const removed = strings(value.removed);
  if (added.length === 0 && removed.length === 0) return null;
  return { added, removed };
}

/**
 * Read back an unresolved stale mark, if the task carries one.
 *
 * Deliberately keyed on the mark's own properties rather than on `status`. A task
 * that was stale and is being re-run to fix it moves to `running`, and its mark
 * stays put until that run actually succeeds — so gating on `status === "stale"`
 * loses the fact that there is still a mark to clear, and the DataHub tag sticks
 * to a task that obsel's own properties call complete.
 *
 * Keeping the mark through the run is also the safer half: if the re-run fails,
 * the task is still visibly wrong rather than quietly unmarked.
 */
function parseStale(
  props: Record<string, string>,
  status: TaskStatus,
  urn: string,
): StaleMark | null {
  const marked = Boolean(props[PROP.staleCausedBy] ?? props[PROP.staleSince]);
  if (!marked) return null;
  // A task that never finished cannot carry a meaningful mark; if one is present
  // it is leftover state, not a claim about this run.
  if (status === "registered") return null;

  const causedBy = props[PROP.staleCausedBy];
  const changeKind = props[PROP.staleChangeKind];
  const hops = Number.parseInt(props[PROP.staleHops] ?? "", 10);

  // A mark with no traceable cause is not actionable, so a half-written one is
  // an error rather than something to render with blanks.
  if (!causedBy) throw new DataHubError(`task ${urn} is stale with no ${PROP.staleCausedBy}`);
  if (!Number.isFinite(hops) || hops < 1) {
    throw new DataHubError(`task ${urn} is stale with an unusable ${PROP.staleHops}`);
  }
  if (!changeKind || !(CHANGE_KINDS as readonly string[]).includes(changeKind)) {
    throw new DataHubError(`task ${urn} is stale with an unrecognised ${PROP.staleChangeKind}`);
  }

  const causedByTask = props[PROP.staleCausedByTask];
  const detectedMs = Number.parseInt(props[PROP.staleDetectedMs] ?? "", 10);

  return {
    causedBy,
    causedByTask: causedByTask ? causedByTask : null,
    hops,
    changeKind: changeKind as ChangeKind,
    columns: parseColumns(props[PROP.staleColumns]),
    reason: props[PROP.staleReason] ?? "",
    since: props[PROP.staleSince] ?? "",
    // Absent on marks written before this was recorded, which is a missing
    // measurement rather than a measurement of zero.
    detectedMs: Number.isFinite(detectedMs) ? detectedMs : null,
  };
}

function toTaskRecord(entity: DataJobEntity): TaskRecord {
  const info = entity.dataJobInfo?.value;
  const io = entity.dataJobInputOutput?.value;
  const props = info?.customProperties ?? {};
  const status = parseStatus(props[PROP.status], entity.urn);
  const finishedAt = props[PROP.finishedAt];
  const startedAt = props[PROP.startedAt];
  /*
   * Free. `readTaskEntity` already returns `globalTags` — that is what
   * `readTagUrns` has always read — and this function used to throw it away, so
   * the one thing obsel writes into DataHub that a person can see was the one
   * thing its own board could not report. No extra request.
   */
  const tags = parseTagUrns(entity.globalTags?.value?.tags);

  return {
    urn: entity.urn,
    name: info?.name ?? taskName(entity.urn),
    title: props[PROP.title] ? props[PROP.title] : null,
    // The registration placeholder is not a job description; reading it back
    // as one would put "obsel agent task" on every old row as though an agent
    // had said it.
    description:
      info?.description && info.description !== "obsel agent task" ? info.description : null,
    reads: [...(io?.inputDatasets ?? [])],
    writes: [...(io?.outputDatasets ?? [])],
    status,
    fingerprints: parseFingerprints(props[PROP.fingerprints], entity.urn),
    // Omitted, not `{}`, when the property is absent — the same rule as `tags`:
    // a key that was never written is not an empty record of observations.
    ...(props[PROP.observed]
      ? { observed: parseFingerprints(props[PROP.observed], entity.urn, PROP.observed) }
      : {}),
    ...(props[PROP.previousFingerprints]
      ? {
          previousFingerprints: parseFingerprints(
            props[PROP.previousFingerprints],
            entity.urn,
            PROP.previousFingerprints,
          ),
        }
      : {}),
    finishedAt: finishedAt ? finishedAt : null,
    startedAt: startedAt ? startedAt : null,
    run: parseRun(props),
    stale: parseStale(props, status, entity.urn),
    tags,
    staleTagged: hasStaleTag(tags),
  };
}

export async function readTask(urn: string): Promise<TaskRecord | null> {
  const entity = await readTaskEntity(urn);
  return entity ? toTaskRecord(entity) : null;
}

/** How many entities one batchGet asks for. Forty tasks fit in one request. */
const BATCH_GET_SIZE = 100;

/**
 * Everything obsel knows about the swarm.
 *
 * Membership comes from the flow's `IsPartOf` edges rather than a search query,
 * for the same reason traversal does: a task registered a second ago is present
 * in the graph store and absent from the index.
 *
 * The entities come back through `POST /openapi/v3/entity/datajob/batchGet` —
 * one request, not one per task. The per-task version was measured fine at four
 * tasks and even at twelve, but the request COUNT is linear, and the board asks
 * for a snapshot every second: a forty-task swarm would put ~41 requests per
 * second on DataHub just to render a screen. batchGet was verified on this
 * instance before being adopted (2026-07-24): it carries `dataJobInfo`,
 * `dataJobInputOutput` and `globalTags` when present, and — unlike
 * `GET /entities/<urn>` — it OMITS an invented URN rather than fabricating a
 * response for it, which is what makes the missing-entity check below real.
 *
 * A URN the graph reported but the aspect store did not return is raised, not
 * skipped. A missing task is a hole in the cascade, and an incomplete swarm is
 * not a smaller answer, it is a wrong one.
 */
export async function readSnapshot(): Promise<SwarmSnapshot> {
  const urns = await relationships(FLOW_URN, "INCOMING", MEMBERSHIP_EDGE);

  const entities: DataJobEntity[] = [];
  for (let start = 0; start < urns.length; start += BATCH_GET_SIZE) {
    const chunk = urns.slice(start, start + BATCH_GET_SIZE);
    const page = await gmsJson<DataJobEntity[]>("/openapi/v3/entity/datajob/batchGet", {
      method: "POST",
      body: JSON.stringify(chunk.map((urn) => ({ urn }))),
    });
    if (!Array.isArray(page)) {
      throw new DataHubError(
        `unusable batchGet response for ${chunk.length} tasks: expected an array, ` +
          `got ${JSON.stringify(page).slice(0, 200)}`,
      );
    }
    entities.push(...page);
  }

  const returned = new Set(entities.map((entity) => entity.urn));
  const missing = urns.filter((urn) => !returned.has(urn));
  if (missing.length > 0) {
    throw new DataHubError(
      `flow ${FLOW_URN} lists ${missing.length} task(s) the aspect store did not return ` +
        `(${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""}), ` +
        `so the graph and the aspect store disagree`,
    );
  }

  /*
   * Tasks DataHub has been told are gone are dropped here, after the check
   * above and not before it.
   *
   * The order matters. A soft-deleted entity is still listed by `/relationships`
   * and still returned by `batchGet`, so filtering earlier would leave its URN
   * in `urns` with nothing matching it in `returned`, and the guard above would
   * report the graph and the aspect store disagreeing about an entity they
   * agree on perfectly. That check is for a genuinely missing task and must keep
   * meaning only that.
   *
   * This is one filter and not three because `readSnapshot` is what the board
   * draws, what `decideCompletion` traverses, and what `resetSwarm` walks. A
   * removed task therefore stops being drawn, stops being flagged, and stops
   * being reset, together. Reporting a completion for one now fails with "not in
   * the swarm", which is the right refusal: DataHub has been told it is gone.
   *
   * Found on 2026-07-28. A `clean_trips` DataJob a launcher bug had registered
   * onto the demo flow was soft-deleted, DataHub hid it in its own UI, and the
   * board went on drawing it and counting it, so the board sat on "4 of 5 agents
   * finished" and could never reach the settled stage. obsel was reporting a
   * swarm DataHub no longer agreed it had. Undoing the delete puts the task back
   * on the board, because nothing here is stored.
   */
  const tasks = entities.filter((entity) => !isRemoved(entity)).map(toTaskRecord);
  tasks.sort((a, b) => a.urn.localeCompare(b.urn));
  return { flow: FLOW_URN, tasks, at: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

interface DataJobWritePayload {
  urn: string;
  dataJobInfo?: AspectEnvelope<DataJobInfoAspect>;
  dataJobInputOutput?: AspectEnvelope<DataJobInputOutputAspect>;
}

/**
 * `async=false` makes GMS apply the aspects before answering, so the entity and
 * its edges are readable on the next call. Derived surfaces (the search index,
 * and anything the MCP server reads) still catch up later — that is what
 * `confirmWrite` is for.
 */
async function writeDataJob(payload: DataJobWritePayload): Promise<void> {
  await gmsJson<unknown>("/openapi/v3/entity/datajob?async=false", {
    method: "POST",
    body: JSON.stringify([payload]),
  });
}

/**
 * Put an agent task into DataHub, wired to the data it reads and writes.
 *
 * `reads` and `writes` are short dataset names such as `clean_orders`; the
 * namespace and platform are applied here so callers never hand-build a URN.
 *
 * A registration is a fresh declaration of intent, so it sets status
 * `registered` and carries no run state. Re-running a task that already exists
 * goes through `startTask`/`coordinateCompletion`, which preserve the recorded
 * fingerprints — those are the baseline a re-run is compared against.
 */
export async function registerTask(
  name: string,
  reads: string[],
  writes: string[],
  description?: string,
  title?: string,
): Promise<TaskRecord> {
  const urn = taskUrn(name);

  await writeDataJob({
    urn,
    dataJobInfo: {
      value: {
        name,
        // The agent's own one-sentence job when it declared one — real DataHub
        // metadata, so DataHub's UI shows the same words the cockpit does.
        description: description ?? "obsel agent task",
        type: { string: "COMMAND" },
        customProperties: {
          [PROP.status]: "registered",
          // Spread, so a task registered without a title carries no empty key.
          ...(title ? { [PROP.title]: title } : {}),
        },
      },
    },
    dataJobInputOutput: {
      value: {
        inputDatasets: reads.map(datasetUrn),
        outputDatasets: writes.map(datasetUrn),
      },
    },
  });

  // A rejected (entityType, aspectName) pair can be dropped without failing the
  // request, so what landed is checked rather than assumed.
  const written = await confirmWrite(async () => await readTask(urn), 10_000);
  if (written.reads.length !== reads.length || written.writes.length !== writes.length) {
    throw new DataHubError(
      `task ${name} registered, but DataHub stored ${written.reads.length} inputs and ` +
        `${written.writes.length} outputs instead of ${reads.length} and ${writes.length}`,
    );
  }

  /*
   * The entity being readable is not the same as the task being IN the swarm.
   *
   * Membership is an `IsPartOf` edge in the graph store, and the graph store lags the
   * aspect store. Measured on this instance on 2026-07-23 against a brand-new flow:
   * `POST …?async=false` returned at 201 ms, the DataJob was readable at 218 ms, and
   * its `IsPartOf` edge only became queryable at **1302 ms**
   * (`docs/environment-findings.md` §11).
   *
   * Confirming only the entity therefore reported a task as registered while
   * `readSnapshot` — which enumerates the swarm from exactly this edge — still could
   * not see it. The consequence is the worst shape obsel has: a change upstream of a
   * task missing from the snapshot traverses straight past it, so the task is not
   * marked, and nothing anywhere reports a problem. An incomplete swarm is not a
   * smaller answer, it is a wrong one.
   *
   * Found by an integration test against a real DataHub. It could not have been found
   * against a stand-in, because a stand-in derives its edges from its own entity map
   * and they are therefore never late.
   */
  await confirmWrite(async () => {
    const members = await relationships(FLOW_URN, "INCOMING", MEMBERSHIP_EDGE);
    return members.includes(urn) ? true : null;
  }, 15_000).catch(() => {
    throw new DataHubError(
      `task ${name} is readable in DataHub but is still not a member of ${FLOW_URN} in the ` +
        `graph store, so obsel's own snapshot cannot see it and a change upstream of it ` +
        `would traverse straight past it`,
    );
  });

  return written;
}

/**
 * Merge `props` into a task's `customProperties`.
 *
 * Read-modify-write, because the OpenAPI upsert replaces the whole aspect: a
 * blind write would drop the name, the description, and any properties a human
 * or another tool added. obsel's writes are additive and reversible, and that
 * promise is kept here or nowhere.
 */
export async function updateTaskProperties(urn: string, props: PropertyPatch): Promise<TaskRecord> {
  /*
   * Refuses anything outside obsel's own flow, before it reads and long before
   * it writes.
   *
   * This function reconstructs `dataJobInfo` from four fields, because the
   * OpenAPI upsert replaces the aspect wholesale. On a job obsel registered that
   * is lossless: those four fields are all there ever were. On a foreign entity
   * it would silently destroy `externalUrl`, `created` and `flowUrn` — a real
   * team's link back to their own orchestrator, gone, in a tool whose stated
   * promise is that its writes are additive and reversible.
   *
   * The guard exists now rather than later because `datasetUrn` began passing
   * foreign URNs through, which is what erasure coverage needs, and the distance
   * between "obsel can name your table" and "obsel can overwrite your job" is
   * one careless call site. Marking a foreign entity is a structured-property
   * write, which is genuinely additive: verified 2026-07-26 against a real
   * showcase dataset, all 18 aspects intact afterwards including 109 upstream
   * edges and 55 schema fields. See `docs/environment-findings.md` §13.1.
   */
  if (!isTaskUrn(urn)) {
    throw new DataHubError(
      `refusing to write obsel properties onto ${urn}: it is not a task in ${FLOW_URN}. ` +
        `This call rebuilds dataJobInfo from four fields and would drop externalUrl, created ` +
        `and flowUrn from an entity obsel did not create. Foreign entities are marked with ` +
        `structured properties, which are additive.`,
    );
  }

  const entity = await readTaskEntity(urn);
  if (!entity) throw new DataHubError(`cannot update ${urn}: no such task in DataHub`);

  const info = entity.dataJobInfo?.value;
  const merged: Record<string, string> = { ...(info?.customProperties ?? {}) };
  for (const [key, value] of Object.entries(props)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }

  await writeDataJob({
    urn,
    dataJobInfo: {
      value: {
        name: info?.name ?? taskName(urn),
        description: info?.description ?? "obsel agent task",
        type: info?.type ?? { string: "COMMAND" },
        customProperties: merged,
      },
    },
  });

  return await confirmWrite(async () => {
    const task = await readTaskEntity(urn);
    if (!task) return null;
    const stored = task.dataJobInfo?.value.customProperties ?? {};
    const landed = Object.entries(props).every(([key, value]) =>
      value === null ? stored[key] === undefined : stored[key] === value,
    );
    return landed ? toTaskRecord(task) : null;
  }, 10_000);
}

/**
 * Poll until `predicate` returns something, or fail with a named timeout.
 *
 * DataHub writes propagate asynchronously. A single immediate read-back reports
 * failures that are only delays, and retrying the write on that false failure
 * writes twice. Measured on this instance: a `remove_tags` issued immediately
 * after an `add_tags` errored, and the identical call seconds later succeeded.
 */
export async function confirmWrite<T>(
  predicate: () => Promise<T | null>,
  timeoutMs = 10_000,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  for (;;) {
    try {
      const result = await predicate();
      if (result !== null && result !== undefined) return result;
    } catch (cause) {
      // A read can fail while a write is still settling; keep the last reason so
      // the timeout says what actually went wrong rather than just "timed out".
      lastError = cause;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new DataHubError(`DataHub write was not confirmed within ${timeoutMs} ms${detail}`);
}

/** Exposed for callers that need to name the platform, e.g. building a UI link. */
export const DATAHUB_PLATFORM = PLATFORM;
export const DATAHUB_DATASET_NAMESPACE = DATASET_NAMESPACE;
export { DataHubError };
