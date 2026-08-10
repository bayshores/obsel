import "server-only";

/**
 * DataHub's own incident surface, raised and resolved by obsel.
 *
 * A stale mark is obsel's record. An incident is DataHub's: it appears on the
 * dataset's page in DataHub's UI, it turns that dataset's `health` to `FAIL`
 * while it is open, and it is visible to somebody who never opens obsel. So one
 * cascade raises one incident on the table whose output moved, and the repair
 * that clears the marks resolves it. Nothing here decides anything — the
 * decision was made by `staleness.ts` and written by `completion.ts`; this file
 * carries it to a second place.
 *
 * **GraphQL is used for the two mutations and for nothing else.** The ban in
 * `CLAUDE.md` — traversal is `GET /relationships`, never GraphQL — is about
 * reads served from the search index: they lag, and an empty list is
 * indistinguishable from "nothing is affected". Measured again for incidents in
 * `docs/environment-findings.md` §16.2 on this instance: `dataset(urn:).incidents`
 * first answered correctly 1791 ms after the raise, and `GET /relationships`
 * with `types=IncidentOn` took 1.6–3.4 s. A mutation is a different thing. It is
 * the only way to raise an incident at all, it returns the new URN in its own
 * response, and no index is consulted to produce that answer. Every READ below
 * goes to the aspect store over OpenAPI v3, which §16.2 measured answering
 * correctly on the first attempt, 19–48 ms after the mutation returned.
 *
 * The traps this file guards, each measured in §16.3:
 *
 * 1. GraphQL `entity(urn:)` returns `{"entity":null}` for an incident that
 *    genuinely exists AND for an invented URN, so it cannot be used to read one
 *    back or to tell whether one is there.
 * 2. `raiseIncident` answers HTTP 200 when it fails, with the failure in
 *    `errors` and `data.raiseIncident` null. The status code means nothing.
 * 3. `raiseIncident` does not check that its target exists.
 * 4. Raising on a dataset URN that does not exist CREATES that dataset, with no
 *    properties, no schema and no lineage — and every later existence check then
 *    confirms it. So the target's existence is established here, before the
 *    raise, and a target that is not there is skipped rather than invented.
 */

import { DataHubError } from "./errors";
import { confirmWrite, gmsFetch } from "./gms";

/** What obsel calls the kind of incident it raises. `CUSTOM` needs no setup; §16.1. */
export const INCIDENT_CUSTOM_TYPE = "obsel stale downstream work";

/** The two states DataHub's `IncidentState` enum has. */
export type IncidentState = "ACTIVE" | "RESOLVED";

function incidentPath(urn: string): string {
  return `/openapi/v3/entity/incident/${encodeURIComponent(urn)}`;
}

/**
 * One GraphQL mutation, with the body checked rather than the status code.
 *
 * Trap 2. A raise with no `resourceUrn` answers HTTP 200 carrying
 * `{"errors":[…],"data":{"raiseIncident":null}}`, so a caller that trusts
 * `response.ok` records a success that never happened — and, for a raise, would
 * then have no URN to resolve later. The returned field is the only signal.
 */
async function mutate<T>(query: string, variables: unknown, field: string): Promise<T> {
  const response = await gmsFetch("/api/graphql", {
    method: "POST",
    body: JSON.stringify({ query, variables }),
  });

  const text = await response.text();
  let payload: { data?: Record<string, unknown>; errors?: { message?: string }[] };
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    throw new DataHubError(
      `DataHub answered ${response.status} on ${field} with a body that is not JSON: ${text.slice(0, 300)}`,
      response.status,
    );
  }

  const value = payload.data?.[field];
  if (value === undefined || value === null) {
    const reasons = (payload.errors ?? []).map((error) => error.message ?? "unknown").join("; ");
    throw new DataHubError(
      `DataHub ${field} did not happen (HTTP ${response.status}, which it answers either way): ` +
        (reasons || "no error was reported and no value came back"),
      response.status,
    );
  }
  return value as T;
}

/**
 * Whether a dataset entity is genuinely there, by the same 404 predicate as
 * `tagExists` and `readTaskEntity`.
 *
 * Called BEFORE every raise, which is trap 4 and the reason this function
 * exists at all. `GET /entities/<urn>` would answer for an invented URN
 * (§1) and `raiseIncident` would then create the dataset it was given (§16.3),
 * so a mistyped URN reaching the mutation leaves a permanent empty dataset
 * behind that every later existence check confirms. Establishing it first is
 * the only order in which the check still means something.
 */
export async function datasetExists(urn: string): Promise<boolean> {
  const response = await gmsFetch(`/openapi/v3/entity/dataset/${encodeURIComponent(urn)}`);
  if (response.status === 404) return false;
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new DataHubError(`DataHub ${response.status} reading ${urn}: ${body}`, response.status);
  }
  return true;
}

/**
 * One incident's state, or null when nothing was ever written under that URN.
 *
 * OpenAPI v3, never GraphQL: trap 1. This endpoint genuinely 404s for an
 * invented incident URN and 200s for a real one, which is what makes it usable
 * as both a read and an existence check.
 */
export async function readIncidentState(urn: string): Promise<IncidentState | null> {
  const response = await gmsFetch(incidentPath(urn));
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new DataHubError(`DataHub ${response.status} reading ${urn}: ${body}`, response.status);
  }
  const entity = (await response.json()) as {
    incidentInfo?: { value?: { status?: { state?: string } } };
  };
  const state = entity.incidentInfo?.value?.status?.state;
  return state === "ACTIVE" || state === "RESOLVED" ? state : null;
}

/**
 * The incident URNs DataHub currently calls open on one dataset.
 *
 * Read off the dataset's own `incidentsSummary` aspect, which a raise writes
 * onto the target: active and resolved are separate arrays, so this answers
 * "does this table have open work" from one URN with no search, no relationship
 * traversal, and no list of incident URNs for obsel to keep in step.
 *
 * `GET /relationships?types=IncidentOn` is not used and would be wrong twice
 * over (§16.2, §16.4): it lags the aspect store by 1.6–3.4 s, and resolving an
 * incident does not remove the edge, so enumerating it and counting reports open
 * work that was closed.
 */
export async function activeIncidentsOn(datasetUrn: string): Promise<string[]> {
  const path =
    `/openapi/v3/entity/dataset/${encodeURIComponent(datasetUrn)}` + `?aspects=incidentsSummary`;
  const response = await gmsFetch(path);
  if (response.status === 404) return [];
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new DataHubError(
      `DataHub ${response.status} reading incidents on ${datasetUrn}: ${body}`,
      response.status,
    );
  }
  const entity = (await response.json()) as {
    incidentsSummary?: { value?: { activeIncidentDetails?: { urn?: string }[] } };
  };
  return (entity.incidentsSummary?.value?.activeIncidentDetails ?? [])
    .map((detail) => detail.urn)
    .filter((urn): urn is string => typeof urn === "string");
}

const RAISE = `mutation obselRaise($input: RaiseIncidentInput!) { raiseIncident(input: $input) }`;

const UPDATE = `mutation obselResolve($urn: String!, $input: IncidentStatusInput!) {
  updateIncidentStatus(urn: $urn, input: $input)
}`;

/**
 * What one raise produced: the URN DataHub minted, and whether obsel confirmed it.
 *
 * `confirmed` is false when the mutation returned a URN and the bounded
 * confirmation below did not complete. `unconfirmed` then carries the reason,
 * for the caller's traced step.
 */
export interface IncidentRaise {
  urn: string;
  confirmed: boolean;
  unconfirmed?: string;
}

/**
 * Raise one incident on the dataset whose output changed, and confirm it landed.
 *
 * Returns the incident's URN, or null when the target dataset is not in DataHub
 * — the skip that trap 4 forces. A failure before the mutation throws; the
 * caller decides what that costs, and in `completion.ts` it costs a traced step
 * and nothing more, because the marks are obsel's answer and this is a second
 * copy of it.
 *
 * The confirmation is `confirmWrite` over two aspect reads: the incident itself
 * reading `ACTIVE`, and the incident URN appearing in the TARGET dataset's
 * `activeIncidentDetails`. Both are the aspect store, both measured answering
 * within one round trip in §16.2 (19–48 ms for the entity, 86–89 ms for the
 * summary). The second is not redundant: it is DataHub's own statement that this
 * incident is attached to that table, which is the thing a person opening the
 * dataset will see.
 *
 * **A confirmation that does not complete is reported, never thrown, because the
 * URN must survive it.** By the time either read runs, `raiseIncident` has
 * already minted an incident that is open on that table, and this URN is the
 * only handle anything has on it — `resolveClosedIncidents` and
 * `resolveResetIncidents` take their candidates from change records, and a
 * record is only written for a URN the caller received. Throwing here left the
 * incident ACTIVE and the dataset's health at FAIL with nothing in obsel able to
 * name it again. Both polls stay: the loop is what tells a delay apart from a
 * failure, and the answer it produces is now `confirmed: false` instead of
 * nothing at all.
 */
export async function raiseStaleWorkIncident(input: {
  /** The dataset whose output moved. The incident is raised on this. */
  dataset: string;
  title: string;
  description: string;
  /** When obsel marked the work, as an ISO instant. */
  startedAt: string;
}): Promise<IncidentRaise | null> {
  if (!(await datasetExists(input.dataset))) return null;

  const urn = await mutate<string>(
    RAISE,
    {
      input: {
        type: "CUSTOM",
        customType: INCIDENT_CUSTOM_TYPE,
        title: input.title,
        description: input.description,
        resourceUrn: input.dataset,
        startedAt: Date.parse(input.startedAt),
        status: { state: "ACTIVE", stage: "TRIAGE" },
        source: { type: "MANUAL" },
      },
    },
    "raiseIncident",
  );

  try {
    await confirmWrite(
      async () => ((await readIncidentState(urn)) === "ACTIVE" ? urn : null),
      15_000,
    );
    await confirmWrite(
      async () => ((await activeIncidentsOn(input.dataset)).includes(urn) ? urn : null),
      15_000,
    );
  } catch (error) {
    return {
      urn,
      confirmed: false,
      unconfirmed: error instanceof Error ? error.message : "unknown error",
    };
  }

  return { urn, confirmed: true };
}

/**
 * Move one incident to RESOLVED, and confirm both aspect reads agree.
 *
 * Unlike the raise, this has a real existence signal: on an invented incident
 * URN the mutation answers with `Incident does not exist` in `errors` and null
 * in `data`, which `mutate` turns into a thrown error (§16.4).
 *
 * The dataset is passed in rather than read off the incident so the summary
 * confirmation costs no extra read. Leaving `activeIncidentDetails` is the half
 * that matters to a person: the dataset's `health` goes back to `PASS` with it.
 */
export async function resolveIncident(input: {
  urn: string;
  dataset: string;
  message: string;
}): Promise<void> {
  await mutate<boolean>(
    UPDATE,
    {
      urn: input.urn,
      input: { state: "RESOLVED", stage: "FIXED", message: input.message },
    },
    "updateIncidentStatus",
  );

  await confirmWrite(
    async () => ((await readIncidentState(input.urn)) === "RESOLVED" ? input.urn : null),
    15_000,
  );
  await confirmWrite(
    async () => (!(await activeIncidentsOn(input.dataset)).includes(input.urn) ? input.urn : null),
    15_000,
  );
}
