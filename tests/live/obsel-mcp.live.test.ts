/**
 * obsel's own MCP server, driven by a real MCP client, against a real obsel.
 *
 * This is the door an outside agent joins through, and nothing about it can be checked
 * without standing the whole thing up: a real `@modelcontextprotocol/sdk` client, over
 * real stdio, into the real Python server, talking to a real obsel server backed by a
 * real DataHub that really writes the `obsel-stale` tag. Every layer here is one an
 * agent will actually meet.
 *
 * The suite's own subject names are prefixed `mcpjoin_`. Registration creates permanent
 * DataHub entities in the integration flow (`OBSEL_FLOW_ID`), so these tasks are this
 * file's alone and assertions are containment-style: other suites share the flow.
 *
 * Because those entities are permanent, **the suite normalises before it asserts.** The
 * first version of this file passed once and failed on its second run: the cascade test
 * leaves `mcpjoin_clean` holding a renamed schema, so the next run's "nothing changed"
 * was comparing against the wrong baseline. `establishBaseline` drives the chain to a
 * known state first, which is what makes every run after the first one mean the same
 * thing as the first. A suite that only passes against a fresh DataHub is a suite that
 * cannot be re-run, and an assertion that depends on run order is not evidence.
 *
 * The two failure tests point a second and third server at ports that genuinely are not
 * obsel: one where nothing listens, and one where the real GMS answers. Neither is
 * simulated, because the thing under test is whether the error an agent reads names the
 * cause, and a stand-in would only be asserting the message this file also wrote.
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startObsel, type ObselServer } from "./obsel-server";
import { requireDataHub, requireObselMcpEnv, requireStaleTag, requireUvx } from "./reachable";

const { readTask } = await import("@/src/server/datahub/client");
const { datasetUrn, taskUrn, STALE_TAG_URN } = await import("@/src/server/datahub/urns");

/** 3097, 3098 and 3099 belong to the other live suites; 3100 to Playwright. */
const PORT = 3096;
const FLOW_ID = "obsel_integration_tests";
const REPO = new URL("../../", import.meta.url).pathname;

/** A three-task chain, so the cascade has somewhere transitive to reach. */
const SEED = "mcpjoin_raw";
const CLEAN = "mcpjoin_clean";
const AGG = "mcpjoin_agg";
const REPORT = "mcpjoin_report";
const CLEAN_OUT = "mcpjoin_clean_t";
const AGG_OUT = "mcpjoin_agg_t";
const REPORT_OUT = "mcpjoin_report_t";

const CLEAN_TABLE = {
  columns: ["order_id", "order_total"],
  rows: [
    { order_id: 1, order_total: 217 },
    { order_id: 2, order_total: 233.08 },
  ],
};
const AGG_TABLE = { columns: ["total"], rows: [{ total: 450.08 }] };
const REPORT_TABLE = { columns: ["line"], rows: [{ line: "two orders" }] };

let obselServer: ObselServer;
let python: string;
let agent: Client;
const clients: Client[] = [];

/** A client wired to a freshly spawned server, pointed at `obselUrl`. */
async function connect(obselUrl: string): Promise<Client> {
  const client = new Client({ name: "obsel-live-test", version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    // Absolute interpreter path, never the name. Other files in this directory empty
    // PATH, and a `python3` resolved by name under an emptied PATH fails to start at
    // all, which proves only that the test could not run.
    command: python,
    args: ["-m", "agents.mcp_server"],
    cwd: REPO,
    env: { ...getDefaultEnvironment(), OBSEL_URL: obselUrl, OBSEL_FLOW_ID: FLOW_ID },
  });
  await client.connect(transport, { timeout: 60_000 });
  clients.push(client);
  return client;
}

interface ToolTextContent {
  type: string;
  text?: string;
}

/**
 * One tool call, with its JSON parsed. Throws if the tool reported an error.
 *
 * The content field is narrowed rather than assumed, the same way
 * `src/server/datahub/mcp.ts` narrows it: `callTool` returns a union that includes a
 * legacy shape carrying no `content` at all.
 *
 * The return is `any` deliberately. These are obsel's own reply shapes, already typed on
 * the server in `src/server/coordinator/types.ts`, and re-declaring them here would be
 * asserting against a second copy of the contract rather than against what crossed the
 * wire. A mistyped field surfaces as a failed assertion, which is the point.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  const content = (result as { content?: unknown }).content;
  const text = Array.isArray(content)
    ? (content as ToolTextContent[])
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("")
    : "";
  if (result.isError) throw new Error(text || "the tool failed and returned no detail");
  return JSON.parse(text);
}

/** Index a list of obsel's records by one of their fields, for assertion by name. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function byKey(items: any[], key: string): Map<string, any> {
  return new Map(items.map((item) => [String(item[key]), item]));
}

/** The error text a failing tool call produced, or "" if it unexpectedly succeeded. */
async function callError(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    await call(client, name, args);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Drive the chain to a known state: all three tasks complete, `mcpjoin_clean` holding
 * the baseline schema.
 *
 * Order is load-bearing. Reporting clean first may cascade and mark the two downstream
 * tasks stale (it will, on any run after one that ended with the rename); completing
 * them afterwards is what clears those marks, because a task that has re-run is
 * trustworthy again. Doing it the other way round would leave marks behind and the
 * freshness test would pass for the wrong reason.
 */
async function establishBaseline(client: Client): Promise<void> {
  await call(client, "report_complete", {
    taskUrn: taskUrn(CLEAN),
    outputs: { [CLEAN_OUT]: CLEAN_TABLE },
  });
  await call(client, "report_complete", {
    taskUrn: taskUrn(AGG),
    outputs: { [AGG_OUT]: AGG_TABLE },
  });
  await call(client, "report_complete", {
    taskUrn: taskUrn(REPORT),
    outputs: { [REPORT_OUT]: REPORT_TABLE },
  });
}

beforeAll(async () => {
  await requireDataHub();
  await requireStaleTag();
  // obsel writes the stale tag through `uvx mcp-server-datahub`, so the cascade test
  // below cannot confirm a tag landed without it.
  requireUvx();
  python = requireObselMcpEnv();
  obselServer = await startObsel(PORT, FLOW_ID);

  // Registration through the tool itself, so the suite's own setup is the path an
  // outside agent takes. It is idempotent by design: a second run returns the existing
  // tasks rather than clearing their baselines.
  agent = await connect(obselServer.url);
  await call(agent, "register_task", {
    name: CLEAN,
    reads: [SEED],
    writes: [CLEAN_OUT],
    title: "MCP join: clean",
  });
  await call(agent, "register_task", { name: AGG, reads: [CLEAN_OUT], writes: [AGG_OUT] });
  await call(agent, "register_task", { name: REPORT, reads: [AGG_OUT], writes: [REPORT_OUT] });
  await establishBaseline(agent);
}, 300_000);

afterAll(async () => {
  // Put the board back: the cascade test deliberately leaves two tasks marked, and the
  // operator's own flow is a different one but this flow is shared with three other
  // suites. `beforeAll` is what guarantees correctness on the next run; this is
  // courtesy, so it is allowed to fail without failing the suite.
  await establishBaseline(agent).catch(() => undefined);
  // Every client owns a child process. vitest does not exit while one is alive.
  await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
  await obselServer?.stop();
}, 180_000);

describe("the tools an agent finds when it connects", () => {
  it("registers exactly the nine tools, verified and not assumed", async () => {
    const client = await connect(obselServer.url);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "abandon_task",
      "announce_start",
      "check_freshness",
      "erasure_board",
      "read_board",
      "register_task",
      "report_complete",
      "request_challenge",
      "submit_attestation",
    ]);
  });

  it("offers no tool that marks anything covered, freshened or cleared", async () => {
    /*
     * The inventory is the door, and this asserts what is deliberately not
     * behind it. obsel clears a stale flag only through work that was genuinely
     * redone, and an asset becomes covered only when a signed attestation obsel
     * verified arrives. A tool that took a name and called it done would be a
     * tool for silencing the one thing obsel is for, and it is exactly the kind
     * of convenience a later commit adds.
     */
    const client = await connect(obselServer.url);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const forbidden of [
      "clear_stale",
      "mark_fresh",
      "dismiss",
      "mark_covered",
      "attest",
      "close_obligation",
    ]) {
      expect(names, `${forbidden} must not exist`).not.toContain(forbidden);
    }
    // And the one tool that does change coverage says whose decision it is.
    const submit = tools.find((tool) => tool.name === "submit_attestation");
    expect(submit?.description).toContain("obsel never checks the data");
  });

  it("describes each tool in words a model can act on", async () => {
    const client = await connect(obselServer.url);
    const { tools } = await client.listTools();
    const report = tools.find((tool) => tool.name === "report_complete");
    // The description IS the interface: a model chooses this tool from it and nothing
    // else. The two rules that make the reply trustworthy have to be in there.
    expect(report?.description).toContain("do not hash anything yourself");
    expect(report?.description).toContain("Report even when you believe nothing changed");
  });
});

describe("an outside agent joins, works, and finishes", () => {
  it("registered the chain in DataHub with real lineage, short names in and urns out", async () => {
    // Read back off DataHub rather than trusting the tool's own reply: the point of
    // registering is that the edge exists for a later traversal to walk.
    const record = await readTask(taskUrn(CLEAN));
    expect(record?.reads).toContain(datasetUrn(SEED));
    expect(record?.writes).toContain(datasetUrn(CLEAN_OUT));
    // Lineage only, not the title. The reuse guard writes nothing when the task already
    // exists, so a title is set on first registration and never after -- asserting it
    // here would be asserting a property of a fresh DataHub rather than of the tool.

    const board = await call(agent, "read_board", {});
    const onBoard = byKey(board.tasks, "name");
    expect([...onBoard.keys()]).toEqual(expect.arrayContaining([CLEAN, AGG, REPORT]));
    // The board reports tables the way the agent named them, not as urns.
    expect(onBoard.get(CLEAN).writes).toEqual([CLEAN_OUT]);
  }, 120_000);

  it("reports a seed table as having no registered producer, not as fresh", async () => {
    const client = await connect(obselServer.url);
    const answer = await call(client, "check_freshness", { reads: [SEED] });
    expect(answer.verdicts[0].status).toBe("no-registered-producer");
    // The distinction that matters: obsel does not know, which is not the same as fine.
    expect(answer.staleInputs).toEqual([]);
  });

  it("announces a start, and obsel holds the work in flight", async () => {
    const announced = await call(agent, "announce_start", { taskUrn: taskUrn(CLEAN) });
    expect(announced.task.status).toBe("running");
    // Confirmed on the entity, because this is what excludes the task from every
    // traversal while it works: in-flight work will read its own inputs.
    expect((await readTask(taskUrn(CLEAN)))?.status).toBe("running");
  }, 120_000);

  it("hands the announcement back on failure, restoring what was there before", async () => {
    // The counterpart, and the reason it exists: obsel skips running work, so a task
    // wedged at `running` by a dead agent is invisible to every later traversal while
    // the board still shows a healthy swarm.
    const handed = await call(agent, "abandon_task", { taskUrn: taskUrn(CLEAN) });
    expect(handed.reverted).toBe(true);
    expect(handed.task.status).toBe("complete");
    // Back to complete, not to registered: a failed re-run must not erase the good
    // result the previous run recorded.
    expect((await readTask(taskUrn(CLEAN)))?.status).toBe("complete");
  }, 120_000);

  it("an identical re-run marks nothing, and does not disturb the recorded fingerprint", async () => {
    const client = await connect(obselServer.url);
    const before = await readTask(taskUrn(CLEAN));

    const again = await call(client, "report_complete", {
      taskUrn: taskUrn(CLEAN),
      outputs: { [CLEAN_OUT]: CLEAN_TABLE },
      runner: "obsel-live-test",
      ms: 1234,
    });
    expect(again.computedFingerprints[datasetUrn(CLEAN_OUT)].schema).toMatch(/^[0-9a-f]{64}$/);

    // obsel's central rule, arrived at through the MCP path rather than the worker's.
    expect(again.coordination.changedOutputs).toEqual([]);
    expect(again.coordination.affected).toEqual([]);
    expect(again.summary[0]).toContain("no outputs changed");

    const after = await readTask(taskUrn(CLEAN));
    expect(after?.fingerprints[datasetUrn(CLEAN_OUT)]).toEqual(
      before?.fingerprints[datasetUrn(CLEAN_OUT)],
    );
  }, 120_000);

  it("the same number written two ways is not a change", async () => {
    const client = await connect(obselServer.url);
    // 217 becomes 217.0. A live run produced exactly this drift across four runs of the
    // same agent over the same seed, and without canonicalisation the content hash moves
    // and obsel reports a change nobody made.
    const restyled = {
      columns: ["order_id", "order_total"],
      rows: [
        { order_id: 1, order_total: 217.0 },
        { order_id: 2, order_total: 233.08 },
      ],
    };
    const answer = await call(client, "report_complete", {
      taskUrn: taskUrn(CLEAN),
      outputs: { [CLEAN_OUT]: restyled },
    });
    expect(answer.coordination.changedOutputs).toEqual([]);
    expect(answer.coordination.affected).toEqual([]);
  }, 120_000);
});

describe("a real change cascades to work that never read it", () => {
  it("marks both hops, each with its own reason, and tags them in DataHub", async () => {
    const client = await connect(obselServer.url);

    // A pure column rename: same rows, same values, different schema.
    const renamed = {
      columns: ["order_id", "order_total_usd"],
      rows: [
        { order_id: 1, order_total_usd: 217 },
        { order_id: 2, order_total_usd: 233.08 },
      ],
    };
    const answer = await call(client, "report_complete", {
      taskUrn: taskUrn(CLEAN),
      outputs: { [CLEAN_OUT]: renamed },
    });

    expect(answer.coordination.changedOutputs).toHaveLength(1);
    expect(answer.coordination.changedOutputs[0].kind).toBe("schema");

    // Each mark, keyed by the name of the task it landed on.
    const marked = byKey(
      answer.coordination.affected.map(
        (entry: { task: { name: string }; mark: Record<string, unknown> }) => ({
          name: entry.task.name,
          ...entry.mark,
        }),
      ),
      "name",
    );
    expect([...marked.keys()].sort()).toEqual([AGG, REPORT].sort());
    // The whole reason lineage traversal is needed rather than a file watcher: the
    // report task never read the table that changed.
    expect(marked.get(AGG).hops).toBe(1);
    expect(marked.get(REPORT).hops).toBe(2);
    for (const mark of marked.values()) {
      expect(mark.reason.length).toBeGreaterThan(0);
      expect(mark.causedBy).toBe(datasetUrn(CLEAN_OUT));
    }

    // Confirmed in DataHub itself, not from obsel's own reply. The tag is what a person
    // sees in DataHub's UI, and it is written through a different path than the mark.
    const record = await readTask(taskUrn(REPORT));
    expect(record?.status).toBe("stale");
    expect(record?.tags).toContain(STALE_TAG_URN);
  }, 180_000);

  it("check_freshness then reports the stale input with the reason obsel recorded", async () => {
    const client = await connect(obselServer.url);
    const answer = await call(client, "check_freshness", { reads: [CLEAN_OUT, AGG_OUT] });

    const byTable = byKey(answer.verdicts, "table");
    // clean itself is fine: it is the thing that changed, not a victim of it.
    expect(byTable.get(CLEAN_OUT).status).toBe("fresh");
    expect(byTable.get(AGG_OUT).status).toBe("stale");
    expect(answer.staleInputs).toEqual([AGG_OUT]);

    // The mark is carried through untouched rather than summarised, so an agent can
    // hand its operator the same sentence obsel recorded.
    const record = await readTask(taskUrn(AGG));
    expect(byTable.get(AGG_OUT).stale.reason).toBe(record?.stale?.reason);
  }, 120_000);

  it("refuses to re-register over a recorded baseline", async () => {
    const client = await connect(obselServer.url);
    const before = await readTask(taskUrn(CLEAN));

    const again = await call(client, "register_task", {
      name: CLEAN,
      reads: [SEED],
      writes: [CLEAN_OUT],
    });

    // The surviving baseline is asserted BEFORE the flag, deliberately. The flag is a
    // label; the fingerprint is the thing that would be destroyed. Checking the label
    // first meant a broken guard failed here and never reached the assertion that says
    // what the breakage costs.
    const after = await readTask(taskUrn(CLEAN));
    expect(after?.fingerprints[datasetUrn(CLEAN_OUT)]).toEqual(
      before?.fingerprints[datasetUrn(CLEAN_OUT)],
    );
    expect(Object.keys(after?.fingerprints ?? {})).not.toHaveLength(0);
    expect(again.alreadyRegistered).toBe(true);
  }, 120_000);
});

describe("a redo that comes out identical reaches the agent as restored work", () => {
  it("clears the two-hop task without a re-run, and the reply says so in both forms", async () => {
    /*
     * Runs against the state the cascade describe left: `mcpjoin_clean` holds
     * the renamed schema, `mcpjoin_agg` is flagged at one hop and
     * `mcpjoin_report` at two. The agent redoes `mcpjoin_agg` over the renamed
     * table and its own table comes out byte-identical — so the report task,
     * which never read the renamed table, was flagged for ground that never
     * moved, and the reply an agent reads has to carry that in the structured
     * half and in the sentences, because an agent that relays only one of them
     * to its operator must still tell the whole story.
     */
    const client = await connect(obselServer.url);

    await call(client, "announce_start", { taskUrn: taskUrn(AGG) });
    const answer = await call(client, "report_complete", {
      taskUrn: taskUrn(AGG),
      outputs: { [AGG_OUT]: AGG_TABLE },
    });

    expect(answer.coordination.changedOutputs).toEqual([]);
    expect(
      answer.coordination.restored.map((entry: { task: { name: string } }) => entry.task.name),
    ).toEqual([REPORT]);
    expect(answer.coordination.restored[0].reason).toContain("came out identical");

    const sentences = answer.summary.join("\n");
    expect(sentences).toContain(`cleared ${REPORT} without a re-run`);

    // Confirmed in DataHub itself: both flags are off and both tags are gone,
    // one earned by the redo, one by what the redo proved.
    for (const name of [AGG, REPORT]) {
      const record = await readTask(taskUrn(name));
      expect(record?.status, name).toBe("complete");
      expect(record?.stale, name).toBeNull();
      expect(record?.tags, name).not.toContain(STALE_TAG_URN);
    }
  }, 180_000);
});

describe("what an agent is refused", () => {
  it("refuses an output the task never declared it writes", async () => {
    const client = await connect(obselServer.url);
    const message = await callError(client, "report_complete", {
      taskUrn: taskUrn(CLEAN),
      outputs: { invented_table: { columns: ["x"], rows: [{ x: 1 }] } },
    });
    // obsel would accept the fingerprint and record it against lineage that does not
    // exist, so a real change to that dataset could never reach anything downstream.
    expect(message).toContain("invented_table");
    expect(message).toContain(CLEAN_OUT);
  }, 120_000);

  it("names an unreachable obsel rather than failing mutely", async () => {
    // Nothing listens on port 1. Not a simulated outage: the connection genuinely fails.
    const client = await connect("http://127.0.0.1:1");

    // The server still starts and still lists its tools. Dying at boot would hand the
    // agent's MCP client a connection error with no cause in it.
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(9);

    const message = await callError(client, "check_freshness", { reads: [CLEAN_OUT] });
    expect(message).toContain("could not reach obsel");
    expect(message).toContain("127.0.0.1:1");
  }, 120_000);

  it("names a port that is answering but is not obsel", async () => {
    // The real GMS: listening, healthy, and genuinely not obsel. This is the mistake an
    // operator actually makes, because 8080 is the port they were last told to use.
    const gms = process.env.DATAHUB_GMS_URL ?? "http://localhost:8080";
    const client = await connect(gms);
    const message = await callError(client, "read_board", {});
    expect(message.length).toBeGreaterThan(0);
    // Whatever GMS answered, the failure must not read as an empty board.
    expect(message).not.toContain("counts");
  }, 120_000);
});

describe("tables reported as files, and reads reported alongside writes", () => {
  /*
   * The file form exists because a model pasting rows into a tool call can drift
   * them, and a drifted row is a change nobody made. What is under test here is
   * the whole wire: a real file on disk, the real MCP server hashing it, the real
   * obsel comparing it.
   */
  it("a table reported as a path is the same table reported inline", async () => {
    const client = await connect(obselServer.url);

    // Inline first, so the recorded baseline is known regardless of what the
    // cascade tests above left behind.
    await call(client, "report_complete", {
      taskUrn: taskUrn(CLEAN),
      outputs: { [CLEAN_OUT]: CLEAN_TABLE },
    });

    const dir = await fs.mkdtemp(join(tmpdir(), "obsel-mcp-live-"));
    const file = join(dir, `${CLEAN_OUT}.json`);
    await fs.writeFile(file, JSON.stringify(CLEAN_TABLE), "utf-8");

    const answer = await call(client, "report_complete", {
      taskUrn: taskUrn(CLEAN),
      outputs: { [CLEAN_OUT]: { path: file } },
    });
    // Identical: the file form must not be a second definition of what was produced.
    expect(answer.coordination.changedOutputs).toEqual([]);
    expect(answer.coordination.affected).toEqual([]);
  }, 120_000);

  it("a read that disagrees with the record comes back as an observed change", async () => {
    const client = await connect(obselServer.url);

    // What mcpjoin_agg "read": a version of clean_t with a renamed column that
    // no completion ever reported. The file is real; the disagreement between
    // this file and the recorded fingerprint is the entire observable event.
    const dir = await fs.mkdtemp(join(tmpdir(), "obsel-mcp-live-"));
    const file = join(dir, `${CLEAN_OUT}.json`);
    await fs.writeFile(
      file,
      JSON.stringify({
        columns: ["order_id", "order_total_eur"],
        rows: [
          { order_id: 1, order_total_eur: 217 },
          { order_id: 2, order_total_eur: 233.08 },
        ],
      }),
      "utf-8",
    );

    const answer = await call(client, "report_complete", {
      taskUrn: taskUrn(AGG),
      outputs: { [AGG_OUT]: AGG_TABLE },
      inputs: { [CLEAN_OUT]: { path: file } },
    });

    expect(answer.coordination.observedChanges).toEqual([
      { dataset: datasetUrn(CLEAN_OUT), kind: "schema" },
    ]);
    // Nothing is marked, and that is correct rather than a shrug: the only reader
    // of clean_t is the reporter itself, whose own fresh output was just compared.
    // Marking with a second reader present is proven in engine.live.test.ts.
    expect(answer.coordination.affected).toEqual([]);

    // Leave the record the way the other tests expect it: the producer completing
    // again supersedes the observation.
    await call(client, "report_complete", {
      taskUrn: taskUrn(CLEAN),
      outputs: { [CLEAN_OUT]: CLEAN_TABLE },
    });
  }, 120_000);

  it("refuses a path with no file behind it, naming the path", async () => {
    const client = await connect(obselServer.url);
    const message = await callError(client, "report_complete", {
      taskUrn: taskUrn(CLEAN),
      outputs: { [CLEAN_OUT]: { path: "/nowhere/never_written.json" } },
    });
    expect(message).toContain("never_written.json");
    expect(message).toContain("no file there");
  }, 120_000);
});
