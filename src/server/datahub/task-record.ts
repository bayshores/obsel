/**
 * The DataJob entity shape DataHub returns, and its translation into a `TaskRecord`.
 *
 * Pure, and without the `server-only` guard `client.ts` carries, for the same
 * reason `tags.ts` has none: the guard makes a module unimportable from a test as
 * well as from the browser, so a parser living behind it is a parser nothing can
 * check.
 *
 * The rule the parsers below split on: a field obsel *decides* with throws when
 * it is unreadable, and a field that only renders is dropped. An unparseable
 * fingerprint that fell back to `{}` would read as "first run" to
 * `compareFingerprints`, which reads as "nothing changed", which would suppress
 * every downstream mark without anyone noticing. A malformed column list is a
 * missing sentence on a page.
 */

import type {
  ChangeKind,
  ColumnChange,
  OutputFingerprint,
  OutputShape,
  RunDetail,
  StaleMark,
  TaskRecord,
  TaskStatus,
} from "@/src/server/coordinator/types";
import { DataHubError } from "./errors";
import { PROP } from "./properties";
import { hasStaleTag, parseTagUrns } from "./tags";
import { taskName } from "./urns";

export interface AspectEnvelope<T> {
  value: T;
}

export interface DataJobInfoAspect {
  name: string;
  description?: string;
  type?: { string: string };
  customProperties?: Record<string, string>;
}

export interface DataJobInputOutputAspect {
  inputDatasets?: string[];
  outputDatasets?: string[];
}

interface GlobalTagsAspect {
  tags: { tag: string }[];
}

export interface DataJobEntity {
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
export function isRemoved(entity: DataJobEntity): boolean {
  return entity.status?.value.removed === true;
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

/** Stored fingerprints, or `{}` only when none were ever written. */
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
 * Each of the three fields is judged on its own, and a missing one renders as
 * nothing at all rather than as a zero — "took 0 ms" is a measurement and "we
 * were not told" is not.
 *
 * **`outputs` is why this no longer demands all three.** Those column lists are
 * what `columnChange` diffs to name the columns that moved, so they are the
 * difference between a mark reading "clean expenses lost amount" and one reading
 * "the columns in clean expenses changed". Requiring a runner and a duration
 * alongside them meant a reporter with no stopwatch — the page's table form,
 * where a person types the table and there is no run to time — lost the shape as
 * collateral.
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
          ...(typeof shape.path === "string" && shape.path !== "" ? { path: shape.path } : {}),
        };
      }
    }
  }

  if (runner === null && ms === null && Object.keys(outputs).length === 0) return null;
  return { runner, ms, outputs };
}

/**
 * Read back which columns moved, when the mark recorded it.
 *
 * Null on anything unusable, never a partial or empty diff. An empty diff is
 * treated as absent too: `{"added":[],"removed":[]}` would be a schema change
 * with nothing to show, which `columnChange` never produces, so seeing one means
 * the value is wrong rather than meaningful.
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

export function toTaskRecord(entity: DataJobEntity): TaskRecord {
  const info = entity.dataJobInfo?.value;
  const io = entity.dataJobInputOutput?.value;
  const props = info?.customProperties ?? {};
  const status = parseStatus(props[PROP.status], entity.urn);
  const finishedAt = props[PROP.finishedAt];
  const startedAt = props[PROP.startedAt];
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
