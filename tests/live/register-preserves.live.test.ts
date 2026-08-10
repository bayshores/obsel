/**
 * Re-registering a task that has already finished, over the real HTTP door.
 *
 * The defect: `POST /api/tasks/register` called `registerTask` unconditionally,
 * and `registerTask` rebuilt `dataJobInfo.customProperties` from the declaration
 * alone. The OpenAPI v3 upsert replaces the whole aspect, so the recorded
 * fingerprints, `finishedAt`, the previous and observed fingerprints and any
 * stale mark went with it, while the lineage edges stayed — a record that looks
 * intact with no baseline behind it. The producer's next completion then found
 * nothing to compare against, `compareFingerprints` read it as a first run, and
 * a genuinely changed table marked nothing downstream. The MCP door already
 * refused to re-POST for this reason; this door did not, and it is the one the
 * page's form and every curl caller use.
 *
 * The last test is the one that matters: it is not about a field surviving, it
 * is about the mark a real change is supposed to produce still being produced
 * after somebody re-declared the task in between.
 *
 * Nothing is stood in for. Real DataHub, a real `next start` serving the real
 * route, real bearer auth, and the erasing call is a real POST of the same body
 * an agent would send.
 *
 * ADDED 2026-08-10 AND NOT RUN. The machine it was written on had DataHub out of
 * bounds. Its evidence line in `docs/coverage.md` says so, and stays that way
 * until a run against a live stack replaces it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireDataHub, requireStaleTag, requireUvx } from "./reachable";
import { API_TOKEN, startObsel, type ObselServer } from "./obsel-server";

const { coordinateCompletion, registerTask } = await import("@/src/server/coordinator/engine");
const { readTask } = await import("@/src/server/datahub/client");
const { closeMcpClient } = await import("@/src/server/datahub/mcp");
const { datasetUrn, taskUrn } = await import("@/src/server/datahub/urns");

const PORT = 3122;
const FLOW_ID = "obsel_integration_tests";

// Registration is permanent by design, so every name here is this run's own.
const STAMP = String(Date.now());
const PRODUCER = `reregister_producer_${STAMP}`;
const READER = `reregister_reader_${STAMP}`;
const SOURCE = `reregister_source_${STAMP}`;
const TABLE = `reregister_table_${STAMP}`;

const FIRST = { schema: "schema-v1", content: "content-v1" };
const CHANGED = { schema: "schema-v1", content: "content-v2" };

let server: ObselServer;

/** The registration body an agent sends, through the door an agent uses. */
async function register(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${server.url}/api/tasks/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_TOKEN}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const reply = (await response.json()) as Record<string, unknown>;
  if (!response.ok)
    throw new Error(`register answered ${response.status}: ${JSON.stringify(reply)}`);
  return reply;
}

beforeAll(async () => {
  await requireDataHub();
  await requireStaleTag();
  requireUvx();

  server = await startObsel(PORT, FLOW_ID);

  await register({
    name: PRODUCER,
    reads: [SOURCE],
    writes: [TABLE],
    title: "Producer",
    description: "writes the table",
  });
  await registerTask(READER, [TABLE], [`${TABLE}_summary`], "reads it", "Reader");

  // Both finish honestly, so there is a baseline to destroy and finished
  // downstream work for its loss to hide a change from.
  await coordinateCompletion({
    taskUrn: taskUrn(PRODUCER),
    fingerprints: { [datasetUrn(TABLE)]: FIRST },
    finishedAt: new Date().toISOString(),
  });
  await coordinateCompletion({
    taskUrn: taskUrn(READER),
    fingerprints: { [datasetUrn(`${TABLE}_summary`)]: { schema: "s", content: "c" } },
    finishedAt: new Date().toISOString(),
  });
}, 600_000);

afterAll(async () => {
  await server?.stop();
  await closeMcpClient();
});

describe("re-registering a task that has already finished", () => {
  it("writes nothing when the declaration is the one on file", async () => {
    const before = await readTask(taskUrn(PRODUCER));

    const reply = await register({
      name: PRODUCER,
      reads: [SOURCE],
      writes: [TABLE],
      title: "Producer",
      description: "writes the table",
    });

    expect(reply.alreadyRegistered).toBe(true);

    const after = await readTask(taskUrn(PRODUCER));
    expect(after?.fingerprints[datasetUrn(TABLE)]).toEqual(FIRST);
    expect(after?.finishedAt).toBe(before?.finishedAt);
    expect(after?.status).toBe("complete");
  }, 300_000);

  it("keeps the baseline when the declaration genuinely differs", async () => {
    // A widened read list is a real re-declaration, so this one is written. What
    // it may not do is take the evidence of the finished run with it.
    const before = await readTask(taskUrn(PRODUCER));

    const reply = await register({
      name: PRODUCER,
      reads: [SOURCE, `${SOURCE}_extra`],
      writes: [TABLE],
      title: "Producer",
      description: "writes the table",
    });

    expect(reply.alreadyRegistered).toBe(false);

    const after = await readTask(taskUrn(PRODUCER));
    expect(after?.reads).toHaveLength(2);
    expect(after?.fingerprints[datasetUrn(TABLE)]).toEqual(FIRST);
    expect(after?.finishedAt).toBe(before?.finishedAt);
    expect(after?.status).toBe("complete");
  }, 300_000);

  it("still marks downstream work when the table really changes afterwards", async () => {
    // The consequence, not the field. With the baseline gone this completion is
    // a first run, and the reader below is left saying it is current over a
    // table that moved under it.
    const result = await coordinateCompletion({
      taskUrn: taskUrn(PRODUCER),
      fingerprints: { [datasetUrn(TABLE)]: CHANGED },
      finishedAt: new Date().toISOString(),
    });

    expect(result.affected.map((entry) => entry.task.name)).toContain(READER);

    const reader = await readTask(taskUrn(READER));
    expect(reader?.status).toBe("stale");
    expect(reader?.stale?.causedBy).toBe(datasetUrn(TABLE));
  }, 300_000);
});
