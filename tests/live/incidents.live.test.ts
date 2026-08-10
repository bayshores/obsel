/**
 * DataHub incidents, raised and resolved by real cascades against a real GMS.
 *
 * `docs/environment-findings.md` §16 measured the two mutations and the reads
 * that confirm them on this instance (`GET /config` self-reports `v1.7.0`). This
 * file is the other half: that obsel raises exactly one incident for a cascade it
 * really ran, on the table that really moved, and takes it down only when the
 * work it named has really been repaired — with a partial repair leaving it open.
 *
 * **Its own flow, and its own tables.** `OBSEL_FLOW_ID` is assigned at the top of
 * this module rather than taken from `vitest.live.config.ts`, which is the one
 * place in this suite that is done. It works here for the same reason it failed
 * in `engine.live.test.ts`: every import below is a dynamic `await import`, so
 * the assignment runs before `urns.ts` is evaluated and its module-load
 * `FLOW_URN` picks this value up. Vitest gives each test file its own process, so
 * the assignment cannot reach another file. The reason for doing it: incidents
 * are raised on DATASETS, and dataset URNs carry no flow, so a suite sharing the
 * demo's table names would put its incidents on the operator's tables.
 *
 * **This file creates dataset entities, and that is deliberate.** A DataJob's
 * lineage edge does NOT materialise the dataset it points at — verified on this
 * instance 2026-08-09, where `obsel_demo.side_table` has had a `Produces` edge
 * for weeks and `GET /openapi/v3/entity/dataset/<urn>` still answers 404 for it.
 * obsel refuses to raise an incident on a URN DataHub has no entity for, because
 * raising one would CREATE that entity (§16.3), so the tables in a cascade have
 * to be there first, as they are in any real catalog. `ensureDataset` below is
 * this suite standing in for the ingestion that would have created them —
 * a real write of a real entity, not a stand-in for one.
 */

/*
 * Before every import below, which are all dynamic for exactly this reason.
 * See the header: this file's incidents land on datasets, and datasets are not
 * scoped by flow.
 */
process.env.OBSEL_FLOW_ID = "obsel_it_incidents";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { beforeAll, describe, expect, it } from "vitest";

// `obsel-server.ts` imports nothing but `node:child_process`, so it is safe to
// hoist above the assignment. `./reachable` is NOT: it imports `urns.ts` for the
// stale tag, which would fix `FLOW_URN` at the config's flow before the line
// above ran. That is the same hoisting trap `vitest.live.config.ts` describes,
// and the `beforeAll` assertion below is what caught it here.
import { API_TOKEN, startObsel } from "./obsel-server";
import type { ObselServer } from "./obsel-server";

const { requireDataHub, requireObselMcpEnv, requireStaleTag, requireUvx } =
  await import("./reachable");
const { coordinateCompletion, registerTask } = await import("@/src/server/coordinator/engine");
const { readTask } = await import("@/src/server/datahub/client");
const { closeMcpClient } = await import("@/src/server/datahub/mcp");
const { gmsUrl } = await import("@/src/server/datahub/gms");
const {
  activeIncidentsOn,
  datasetExists,
  raiseStaleWorkIncident,
  readIncidentState,
  resolveIncident,
  INCIDENT_CUSTOM_TYPE,
} = await import("@/src/server/datahub/incidents");
const { readChangesFor, forgetChangeHeads, changeHeadFor } =
  await import("@/src/server/datahub/documents");
const { datasetUrn, taskUrn, FLOW_ID } = await import("@/src/server/datahub/urns");

import type { ChangeBody } from "@/src/server/coordinator/change-ledger";
import type { CompletionReport } from "@/src/server/coordinator/types";

/** Not 3095–3099 or 3117–3120: every other live file holds one of those. */
const PORT = 3121;

/** This suite's own namespace, so nothing here can touch the demo's tables. */
const NS = "obsel_incidents";

const SOURCE = datasetUrn(`${NS}.source_table`);
const MID = datasetUrn(`${NS}.mid_table`);
const LEAF_A = datasetUrn(`${NS}.leaf_a`);
const LEAF_B = datasetUrn(`${NS}.leaf_b`);
const PROBE = datasetUrn(`${NS}.probe_table`);

let obselServer: ObselServer;

/**
 * Create a dataset entity if it is not already there.
 *
 * `async=false`, then the same genuine-404 read obsel uses, so this returns only
 * once DataHub really holds the entity. Nothing is deleted afterwards: obsel's
 * writes are additive and reversible by policy, and a suite that deleted shared
 * entities would be the one thing in this repository allowed to.
 */
async function ensureDataset(urn: string): Promise<void> {
  if (await datasetExists(urn)) return;

  const name = urn.split(",")[1].split(".").slice(-1)[0];
  const response = await fetch(`${gmsUrl()}/openapi/v3/entity/dataset?async=false`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([
      {
        urn,
        datasetProperties: {
          value: {
            name,
            description: "obsel integration suite fixture table",
            customProperties: {},
          },
        },
      },
    ]),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`creating ${urn} answered ${response.status}: ${await response.text()}`);
  }

  const deadline = Date.now() + 15_000;
  for (;;) {
    if (await datasetExists(urn)) return;
    if (Date.now() > deadline) throw new Error(`${urn} was written but never became readable`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function finished(
  name: string,
  dataset: string,
  schema: string,
  content: string,
  columns?: string[],
): CompletionReport {
  return {
    taskUrn: taskUrn(name),
    fingerprints: { [dataset]: { schema, content } },
    finishedAt: new Date().toISOString(),
    ...(columns === undefined
      ? {}
      : {
          run: {
            runner: "integration-test",
            ms: 1,
            outputs: { [dataset]: { rows: 12, columns } },
          },
        }),
  };
}

/** The four tasks finish, so there is finished work for a change to reach. */
async function runAll(sourceColumns = ["id", "amount"]): Promise<void> {
  await coordinateCompletion(finished("make_source", SOURCE, "s1", "c1", sourceColumns));
  await coordinateCompletion(finished("build_mid", MID, "m1", "n1"));
  await coordinateCompletion(finished("report_a", LEAF_A, "a1", "b1"));
  await coordinateCompletion(finished("report_b", LEAF_B, "x1", "y1"));
}

/** The newest change record's body, straight out of DataHub. */
async function latestChange(): Promise<ChangeBody | null> {
  forgetChangeHeads(FLOW_ID);
  const head = await changeHeadFor(FLOW_ID);
  if (head === 0) return null;
  const [record] = await readChangesFor(FLOW_ID, { from: head, limit: 1 });
  return record ? (JSON.parse(record.body) as ChangeBody) : null;
}

/** Whether a task currently carries a mark, read straight off DataHub. */
async function isFlagged(name: string): Promise<boolean> {
  return (await readTask(taskUrn(name)))?.stale !== null;
}

/**
 * One incident's own aspect, as DataHub holds it.
 *
 * Read here with a raw fetch rather than through `incidents.ts`, which exposes
 * only the state: the words obsel writes into an incident are for a person
 * reading DataHub, and nothing in obsel reads them back. Asserting them needs
 * the whole aspect, and widening the module's API to let a test look would put a
 * reader of that description one import away from being a decision path.
 */
async function readIncidentInfo(urn: string): Promise<Record<string, unknown>> {
  const response = await fetch(
    `${gmsUrl()}/openapi/v3/entity/incident/${encodeURIComponent(urn)}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!response.ok) throw new Error(`reading ${urn} answered ${response.status}`);
  const entity = (await response.json()) as {
    incidentInfo?: { value?: Record<string, unknown> };
  };
  return entity.incidentInfo?.value ?? {};
}

beforeAll(async () => {
  await requireDataHub();
  await requireStaleTag();
  requireUvx();

  // The flow this file writes into is its own, and the assertion is first for
  // the same reason `engine.live.test.ts` puts its version of it first: the
  // assignment at the top of this module is the kind of thing that silently
  // stops working.
  expect(FLOW_ID).toBe("obsel_it_incidents");

  for (const urn of [SOURCE, MID, LEAF_A, LEAF_B, PROBE]) await ensureDataset(urn);

  await registerTask(
    "make_source",
    [`${NS}.raw_source`],
    [`${NS}.source_table`],
    undefined,
    "Source",
  );
  await registerTask("build_mid", [`${NS}.source_table`], [`${NS}.mid_table`], undefined, "Middle");
  await registerTask("report_a", [`${NS}.mid_table`], [`${NS}.leaf_a`], undefined, "Report A");
  await registerTask("report_b", [`${NS}.mid_table`], [`${NS}.leaf_b`], undefined, "Report B");

  obselServer = await startObsel(PORT, FLOW_ID);

  return async () => {
    await obselServer.stop();
    await closeMcpClient();
  };
}, 300_000);

describe("one cascade, one incident, and the repair that takes it down", () => {
  it("raises it on the changed table, holds it through a partial repair, and resolves on the full one", async () => {
    await runAll();
    const openBefore = await activeIncidentsOn(SOURCE);

    // The change: one column renamed on the source table, values untouched.
    const cascadeStarted = Date.now();
    const cascade = await coordinateCompletion(
      finished("make_source", SOURCE, "s2", "c1", ["id", "amount_usd"]),
    );
    const cascadeMs = Date.now() - cascadeStarted;

    /*
     * The record written at decision time is where the incident is named. This
     * is the read the resolve path itself uses, so asserting on it is asserting
     * on the thing that has to be right for the resolve to be possible at all.
     */
    const marking = await latestChange();
    expect(marking?.event).toBe("marked");
    expect(marking?.affected.map((entry) => entry.name).sort()).toEqual([
      "build_mid",
      "report_a",
      "report_b",
    ]);

    const incident = marking?.incident;
    expect(incident, "the cascade should have raised an incident").toBeDefined();
    expect(incident?.urn).toMatch(/^urn:li:incident:/);
    // Raised on the table whose output moved, not on a task and not on a leaf.
    expect(incident?.dataset).toBe(SOURCE);
    expect([...(incident?.taskUrns ?? [])].sort()).toEqual(
      ["build_mid", "report_a", "report_b"].map(taskUrn).sort(),
    );

    // And DataHub says the same thing, from the aspect store both ways round.
    expect(await readIncidentState(incident!.urn)).toBe("ACTIVE");

    // ONE incident for the cascade, not one per flagged task: exactly one URN
    // appeared on the table between the two reads.
    const openAfter = await activeIncidentsOn(SOURCE);
    expect(openAfter.filter((urn) => !openBefore.includes(urn))).toEqual([incident!.urn]);

    /*
     * What it says, which is the whole reason it is on DataHub rather than only
     * on obsel's board. No new vocabulary: the body is each mark's own recorded
     * reason and hop count, and the type is the one obsel names itself with —
     * accepted with no prior registration, unlike a tag (§16.1 against §6.2).
     */
    const info = await readIncidentInfo(incident!.urn);
    expect(info.type).toBe("CUSTOM");
    expect(info.customType).toBe(INCIDENT_CUSTOM_TYPE);
    expect(info.entities).toEqual([SOURCE]);
    expect(String(info.title)).toContain("source table");
    for (const label of ["Middle", "Report A", "Report B"]) {
      expect(String(info.description)).toContain(label);
    }
    expect(String(info.description)).toContain("2 hops");

    /*
     * The partial repair. `report_a` re-runs and reports the same output, so its
     * own mark comes off — and `build_mid` and `report_b` are still flagged for
     * the same table, so the incident stays open. Resolving here would have
     * DataHub saying the opposite of obsel's own marks.
     */
    await coordinateCompletion(finished("report_a", LEAF_A, "a1", "b1"));
    expect(await isFlagged("report_a")).toBe(false);
    expect(await isFlagged("build_mid")).toBe(true);
    expect(await readIncidentState(incident!.urn)).toBe("ACTIVE");

    /*
     * No argument resolves one either. The completion route's schema drops keys
     * it does not know, so an agent that invented `resolveIncident` gets its
     * completion processed and its invention ignored. This report is identical
     * to what `report_a` last sent, so the decision is a quiet one and nothing
     * else about the board moves.
     */
    const invented = await fetch(`${obselServer.url}/api/tasks/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({
        ...finished("report_a", LEAF_A, "a1", "b1"),
        resolveIncident: incident!.urn,
        incident: { urn: incident!.urn, resolve: true },
      }),
    });
    expect(invented.ok).toBe(true);
    expect(await readIncidentState(incident!.urn)).toBe("ACTIVE");

    /*
     * The full repair, as the demo performs it: the flagged task nearest the
     * change re-runs, its own table comes back identical, and obsel clears the
     * flags on the work built on it. Every task the incident named is now clean,
     * so the incident comes down with them.
     */
    const repairStarted = Date.now();
    await coordinateCompletion(finished("build_mid", MID, "m1", "n1"));
    const repairMs = Date.now() - repairStarted;

    expect(await isFlagged("build_mid")).toBe(false);
    expect(await isFlagged("report_b")).toBe(false);
    expect(await readIncidentState(incident!.urn)).toBe("RESOLVED");
    expect(await activeIncidentsOn(SOURCE)).not.toContain(incident!.urn);

    /*
     * Both figures include the incident write, because that write happens inside
     * the call the reporting agent waits for. `elapsedMs` is obsel's own
     * measurement of the same call and is quoted beside them so the two cannot
     * drift apart in `docs/verification.md`.
     */
    console.log(
      `[incidents] cascade completion including the raise: ${cascadeMs} ms ` +
        `(obsel reported ${cascade.elapsedMs} ms, ${cascade.affected.length} flagged); ` +
        `repair completion including the resolve: ${repairMs} ms ` +
        `(incident ${incident!.urn})`,
    );
  }, 600_000);
});

describe("a table DataHub has no entity for", () => {
  it("is not raised on, and is not created by trying", async () => {
    /*
     * Trap 4 in `docs/environment-findings.md` §16.3: `raiseIncident` does not
     * check its target, and raising on a URN nothing has written CREATES that
     * dataset — after which every existence check confirms it forever. So obsel
     * establishes existence first and skips.
     *
     * A fresh name per run, deliberately. With a fixed one, the very regression
     * this test exists to catch would create the entity permanently, and the
     * check could never run again on this machine.
     */
    const stamp = String(Date.now());
    const ghostTable = `${NS}.ghost_${stamp}`;
    const ghostOut = `${NS}.ghost_out_${stamp}`;
    const ghostUrn = datasetUrn(ghostTable);
    expect(await datasetExists(ghostUrn)).toBe(false);

    await registerTask(`ghost_writer_${stamp}`, [`${NS}.raw_source`], [ghostTable]);
    await registerTask(`ghost_reader_${stamp}`, [ghostTable], [ghostOut]);

    await coordinateCompletion(finished(`ghost_writer_${stamp}`, ghostUrn, "g1", "h1"));
    await coordinateCompletion(finished(`ghost_reader_${stamp}`, datasetUrn(ghostOut), "o1", "p1"));

    // The change, on a table DataHub has no entity for.
    await coordinateCompletion(finished(`ghost_writer_${stamp}`, ghostUrn, "g2", "h1"));

    // The answer still landed: the incident is a second copy of it, and a
    // failure to write that copy must never cost the mark.
    expect(await isFlagged(`ghost_reader_${stamp}`)).toBe(true);

    const record = await latestChange();
    expect(record?.affected.map((entry) => entry.name)).toEqual([`ghost_reader_${stamp}`]);
    expect(record).not.toHaveProperty("incident");

    // And obsel did not bring the table into existence by trying.
    expect(await datasetExists(ghostUrn)).toBe(false);
  }, 600_000);
});

describe("what the two mutations cost, measured", () => {
  it("confirms a raise and a resolve from the aspect store", async () => {
    /*
     * The numbers `docs/verification.md` quotes for this feature, taken the way
     * obsel takes them: the whole call including the bounded confirmation, not
     * the mutation alone. Raised on a table of this suite's own so the scenario
     * above is untouched.
     */
    const raiseStarted = Date.now();
    const urn = await raiseStaleWorkIncident({
      dataset: PROBE,
      title: "obsel integration suite: measuring the raise",
      description: "Raised and resolved by tests/live/incidents.live.test.ts. Not a finding.",
      startedAt: new Date().toISOString(),
    });
    const raiseMs = Date.now() - raiseStarted;
    expect(urn).not.toBeNull();
    expect(await readIncidentState(urn!)).toBe("ACTIVE");

    const resolveStarted = Date.now();
    await resolveIncident({
      urn: urn!,
      dataset: PROBE,
      message: "integration suite cleanup",
    });
    const resolveMs = Date.now() - resolveStarted;
    expect(await readIncidentState(urn!)).toBe("RESOLVED");
    expect(await activeIncidentsOn(PROBE)).not.toContain(urn!);

    console.log(
      `[incidents] raise confirmed in ${raiseMs} ms, resolve confirmed in ${resolveMs} ms ` +
        `(type "${INCIDENT_CUSTOM_TYPE}")`,
    );
  }, 300_000);

  it("reports a failed mutation as a failure, whatever the status code says", async () => {
    // Trap 2: `raiseIncident` answers HTTP 200 with `data.raiseIncident` null.
    // The one that has a real signal is the resolve, on an invented URN.
    await expect(
      resolveIncident({
        urn: "urn:li:incident:00000000-0000-4000-8000-000000000000",
        dataset: PROBE,
        message: "should not happen",
      }),
    ).rejects.toThrow(/does not exist/i);
  }, 120_000);
});

describe("nothing raises or resolves an incident on request", () => {
  /*
   * The same guard the erasure suite keeps over "no route marks an asset
   * covered". An incident obsel raised says finished work is out of date; a
   * route that closed one would let a caller take that statement off DataHub
   * without redoing the work it is about, which is the thing obsel's clearing
   * rule exists to prevent. Asserted rather than assumed, because an endpoint
   * like this is exactly what a later commit adds for convenience.
   */
  it("offers no MCP tool that raises or resolves one", async () => {
    /*
     * The other door. `tests/live/obsel-mcp.live.test.ts` pins the exact ten
     * tools, so a new one would fail there as well; this names the ones a later
     * commit would reach for, against a real server over real stdio, and checks
     * that no existing tool takes an incident as an argument either.
     */
    const client = new Client({ name: "obsel-incidents-test", version: "0.0.0" }, {});
    const transport = new StdioClientTransport({
      // Absolute interpreter path, never the name: the convention this directory
      // keeps, because a name resolved under an emptied PATH proves only that
      // the test could not run.
      command: requireObselMcpEnv(),
      args: ["-m", "agents.mcp_server"],
      cwd: new URL("../../", import.meta.url).pathname,
      env: {
        ...getDefaultEnvironment(),
        OBSEL_URL: obselServer.url,
        OBSEL_FLOW_ID: FLOW_ID,
        OBSEL_API_TOKEN: API_TOKEN,
      },
    });
    await client.connect(transport, { timeout: 60_000 });
    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      for (const forbidden of [
        "raise_incident",
        "resolve_incident",
        "close_incident",
        "clear_incident",
      ]) {
        expect(names, `${forbidden} must not exist`).not.toContain(forbidden);
      }
      for (const tool of tools) {
        expect(
          JSON.stringify(tool.inputSchema).toLowerCase(),
          `${tool.name} should take no incident argument`,
        ).not.toContain("incident");
      }
    } finally {
      await client.close();
    }
  }, 180_000);

  it.each([
    "/api/incidents",
    "/api/incidents/resolve",
    "/api/incidents/raise",
    "/api/changes/incident",
    "/api/tasks/incident",
  ])(
    "has no mutation behind %s",
    async (path) => {
      const response = await fetch(`${obselServer.url}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_TOKEN}` },
        body: "{}",
        signal: AbortSignal.timeout(60_000),
      });
      // 404 for a path with no route, 405 for one whose only method is GET.
      expect([404, 405], `${path} should have no mutation behind it`).toContain(response.status);
    },
    60_000,
  );
});

describe("a board reset takes its incidents with it", () => {
  /*
   * The one way an incident comes down without redone work, and why it is not a
   * dismissal: reset wipes every mark on the flow, so the incident's own
   * condition — a named task still citing the table — is false the moment the
   * wipe lands, and DataHub keeping `health: FAIL` over marks that no longer
   * exist would be the marks-against-DataHub disagreement in the other
   * direction. The route takes no incident argument; the only way to reach this
   * is to wipe the whole board, holding the token for it.
   */
  it("resolves a cascade's incident when the marks it named are wiped", async () => {
    // A fresh cascade, so there is an ACTIVE incident to reset away.
    const cascade = await coordinateCompletion(
      finished("make_source", SOURCE, "s3", "c1", ["id", "amount_eur"]),
    );
    expect(cascade.affected.length).toBeGreaterThan(0);
    const record = await latestChange();
    const incident = record?.incident;
    expect(incident, "the cascade should have raised an incident").toBeDefined();
    expect(await readIncidentState(incident!.urn)).toBe("ACTIVE");

    const response = await fetch(`${obselServer.url}/api/demo/reset`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_TOKEN}` },
      signal: AbortSignal.timeout(120_000),
    });
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { ok: boolean; incidentsResolved: string[] };
    expect(body.ok).toBe(true);
    expect(body.incidentsResolved).toContain("source table");

    // DataHub agrees, from the aspect store both ways round, and the message
    // names the reset rather than a repair that never happened.
    expect(await readIncidentState(incident!.urn)).toBe("RESOLVED");
    expect(await activeIncidentsOn(SOURCE)).not.toContain(incident!.urn);
    const info = await readIncidentInfo(incident!.urn);
    expect(String((info.status as { message?: string })?.message)).toContain("reset");

    // And the marks really are gone: the resolve followed the wipe, never led it.
    expect(await isFlagged("build_mid")).toBe(false);
    expect(await isFlagged("report_a")).toBe(false);
    expect(await isFlagged("report_b")).toBe(false);
  }, 600_000);
});
