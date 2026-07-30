import "server-only";

/**
 * obsel's read and write path into DataHub over GMS HTTP.
 *
 * There is no local database. A task is a `DataJob`, what it reads and writes are
 * `Consumes`/`Produces` lineage edges, and everything else about it is carried in
 * that DataJob's `dataJobInfo.customProperties` under an `obsel.` prefix
 * (`properties.ts`). Transport is in `gms.ts`, traversal in `lineage.ts`, and the
 * translation from a DataHub entity to a `TaskRecord` in `task-record.ts`.
 *
 * **Existence is never established with `GET /entities/<urn>`.** That endpoint
 * synthesises a well-formed response for any syntactically valid URN including
 * invented ones. `GET /openapi/v3/entity/datajob/<urn>` does return 404 for a
 * URN that was never written, verified on this instance, so it is used instead.
 * `docs/environment-findings.md` §1.
 */

import type { SwarmSnapshot, TaskRecord } from "@/src/server/coordinator/types";
import { clientProperty, type ClientDeclaration } from "@/src/server/http/client-body";
import { DataHubError } from "./errors";
import { confirmWrite, gmsFetch, gmsJson, gmsUrl } from "./gms";
import { readLineageDownstream, relationships } from "./lineage";
import { PROP } from "./properties";
import type { PropertyPatch } from "./properties";
import { parseTagUrns } from "./tags";
import {
  isRemoved,
  toTaskRecord,
  type AspectEnvelope,
  type DataJobEntity,
  type DataJobInfoAspect,
  type DataJobInputOutputAspect,
} from "./task-record";
import { FLOW_URN, MEMBERSHIP_EDGE, datasetUrn, isTaskUrn, taskName, taskUrn } from "./urns";

function entityPath(urn: string): string {
  return `/openapi/v3/entity/datajob/${encodeURIComponent(urn)}`;
}

/**
 * Raw entity, or null when it genuinely does not exist.
 *
 * Safe as an existence predicate, unlike `GET /entities/<urn>`: verified on this
 * instance that an invented DataJob URN returns 404 here.
 */
async function readTaskEntity(urn: string): Promise<DataJobEntity | null> {
  const response = await gmsFetch(entityPath(urn));
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new DataHubError(`DataHub ${response.status} reading ${urn}: ${body}`, response.status);
  }
  return (await response.json()) as DataJobEntity;
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
 * tasks and even at twelve, but the request COUNT is linear, and the page asks
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
   * This is one filter and not three because `readSnapshot` is what the page
   * draws, what `decideCompletion` traverses, and what `resetSwarm` walks. A
   * removed task therefore stops being drawn, stops being flagged, and stops
   * being reset, together.
   *
   * Found on 2026-07-28. A `clean_trips` DataJob a launcher bug had registered
   * onto the demo flow was soft-deleted, DataHub hid it in its own UI, and the
   * page went on drawing it and counting it, so it sat on "4 of 5 agents
   * finished" and could never reach the settled stage. Undoing the delete puts
   * the task back, because nothing here is stored.
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
  volatile?: Record<string, string[]>,
  client?: ClientDeclaration,
): Promise<TaskRecord> {
  const urn = taskUrn(name);

  /*
   * Volatile columns are fixed at the first registration that declares them.
   *
   * The rule exists because the exclusion list decides what a fingerprint MEANS.
   * Two recorded fingerprints of one table are comparable only if both were
   * taken under the same list; change it and the next comparison is between a
   * hash over four columns and a hash over five, which differs for a reason that
   * has nothing to do with the data. obsel would report a change nobody made and
   * cascade on it — and the opposite mistake is worse, since widening the list
   * can make a real change vanish into an excluded column.
   *
   * Refusing is reversible: pick a new task name, or reset, which clears every
   * baseline so nothing incomparable survives. Accepting silently is not.
   */
  const existing = await readTask(urn);
  const declared = JSON.stringify(
    Object.fromEntries(
      Object.entries(volatile ?? {})
        .map(([table, columns]) => [datasetUrn(table), [...columns].sort()] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
  const recorded = JSON.stringify(
    Object.fromEntries(
      Object.entries(existing?.volatile ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
  if (existing && declared !== recorded && recorded !== "{}") {
    throw new DataHubError(
      `task ${name} is already registered with a different set of volatile columns ` +
        `(${recorded}, not ${declared}). Those columns decide what its recorded fingerprints ` +
        "mean, so changing them would make the next comparison meaningless. Register under a " +
        "new name, or reset, which clears the baselines they were taken under.",
    );
  }

  await writeDataJob({
    urn,
    dataJobInfo: {
      value: {
        name,
        // The agent's own one-sentence job when it declared one — real DataHub
        // metadata, so DataHub's UI shows the same words the page does.
        description: description ?? "obsel agent task",
        type: { string: "COMMAND" },
        customProperties: {
          [PROP.status]: "registered",
          // Spread, so a task registered without a title carries no empty key.
          ...(title ? { [PROP.title]: title } : {}),
          /*
           * Which output columns are declared meaningless, keyed by the FULL
           * dataset URN so a reader can look it up with the URN it already has.
           *
           * Written at registration and never again: `registerTask` refuses a
           * re-registration whose lineage differs, and the immutability rule
           * below extends that to this. An exclusion list that could change
           * between runs would make two recorded fingerprints of one table
           * incomparable, which reads as a change nobody made.
           */
          ...(volatile && Object.keys(volatile).length > 0
            ? {
                [PROP.volatile]: JSON.stringify(
                  Object.fromEntries(
                    Object.entries(volatile).map(([table, columns]) => [
                      datasetUrn(table),
                      [...columns].sort(),
                    ]),
                  ),
                ),
              }
            : {}),
          // What the MCP client declared itself to be, when the registration
          // came through that door. Spread like `title`, so a task registered by
          // anything else carries no empty key.
          ...(client ? { [PROP.clientRegistered]: clientProperty(client) ?? "" } : {}),
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

export { confirmWrite, gmsUrl, PROP, readLineageDownstream, relationships };
