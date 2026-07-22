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
  OutputFingerprint,
  OutputShape,
  RunDetail,
  StaleMark,
  SwarmSnapshot,
  TaskRecord,
  TaskStatus,
} from "@/src/server/coordinator/types";
import {
  DATASET_NAMESPACE,
  FLOW_URN,
  MEMBERSHIP_EDGE,
  PLATFORM,
  datasetUrn,
  taskName,
  taskUrn,
} from "./urns";

/** `customProperties` keys obsel owns. Everything else on the aspect is left alone. */
export const PROP = {
  status: "obsel.status",
  finishedAt: "obsel.finishedAt",
  startedAt: "obsel.startedAt",
  fingerprints: "obsel.fingerprints",
  runRunner: "obsel.run.runner",
  runMs: "obsel.run.ms",
  runOutputs: "obsel.run.outputs",
  staleCausedBy: "obsel.stale.causedBy",
  staleCausedByTask: "obsel.stale.causedByTask",
  staleHops: "obsel.stale.hops",
  staleChangeKind: "obsel.stale.changeKind",
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
  const entity = await readTaskEntity(urn);
  const tags = entity?.globalTags?.value?.tags ?? [];
  return tags.map((entry) => entry.tag);
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
): Record<string, OutputFingerprint> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new DataHubError(
      `task ${urn} has unreadable ${PROP.fingerprints}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DataHubError(`task ${urn} has a non-object ${PROP.fingerprints}`);
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
 * Returns null — never a partial object — unless the runner, the duration and
 * the output shapes are all present and usable. This is display-only material,
 * so a half-written record is dropped rather than raised: unlike a fingerprint
 * or a stale mark, nothing obsel decides depends on it, and failing a snapshot
 * read over a cosmetic property would take the whole cockpit down.
 *
 * A missing record renders as nothing at all, which is the honest outcome. It
 * never renders as a zero, because "took 0 ms" is a measurement and "we were
 * not told" is not.
 */
function parseRun(props: Record<string, string>): RunDetail | null {
  const runner = props[PROP.runRunner];
  const ms = Number.parseInt(props[PROP.runMs] ?? "", 10);
  if (!runner || !Number.isFinite(ms) || ms < 0) return null;

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
        };
      }
    }
  }

  return { runner, ms, outputs };
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

  return {
    urn: entity.urn,
    name: info?.name ?? taskName(entity.urn),
    // The registration placeholder is not a job description; reading it back
    // as one would put "obsel agent task" on every old row as though an agent
    // had said it.
    description:
      info?.description && info.description !== "obsel agent task" ? info.description : null,
    reads: [...(io?.inputDatasets ?? [])],
    writes: [...(io?.outputDatasets ?? [])],
    status,
    fingerprints: parseFingerprints(props[PROP.fingerprints], entity.urn),
    finishedAt: finishedAt ? finishedAt : null,
    startedAt: startedAt ? startedAt : null,
    run: parseRun(props),
    stale: parseStale(props, status, entity.urn),
  };
}

export async function readTask(urn: string): Promise<TaskRecord | null> {
  const entity = await readTaskEntity(urn);
  return entity ? toTaskRecord(entity) : null;
}

/**
 * Everything obsel knows about the swarm.
 *
 * Membership comes from the flow's `IsPartOf` edges rather than a search query,
 * for the same reason traversal does: a task registered a second ago is present
 * in the graph store and absent from the index.
 *
 * A URN the graph reported but that cannot be read is raised, not skipped. A
 * missing task is a hole in the cascade.
 */
export async function readSnapshot(): Promise<SwarmSnapshot> {
  const urns = await relationships(FLOW_URN, "INCOMING", MEMBERSHIP_EDGE);

  const tasks = await Promise.all(
    urns.map(async (urn) => {
      const entity = await readTaskEntity(urn);
      if (!entity) {
        throw new DataHubError(
          `flow ${FLOW_URN} lists task ${urn}, but reading it returned 404 — the graph and the aspect store disagree`,
        );
      }
      return toTaskRecord(entity);
    }),
  );

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
        customProperties: { [PROP.status]: "registered" },
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
