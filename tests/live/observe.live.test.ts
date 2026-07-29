/**
 * A write nobody reported, caught by an observer that is not an agent.
 *
 * The gap: obsel's reader-side cross-check only fires when an instrumented task
 * next reads the changed table, so between a silent write and that read obsel is
 * blind. `POST /api/datasets/observe` and `agents/observe.py` close it.
 *
 * Nothing is stood in for. The silent write is a real edit to a real file on
 * disk, the bridge is the real script spawned by absolute path, the server is a
 * real `next start`, and the graph is real DataHub. The hostile case — no token
 * — is a real request without the header.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireDataHub, requireStaleTag, requireUvx } from "./reachable";
import { API_TOKEN, startObsel, type ObselServer } from "./obsel-server";

const { registerTask, coordinateCompletion } = await import("@/src/server/coordinator/engine");
const { readTask } = await import("@/src/server/datahub/client");
const { closeMcpClient } = await import("@/src/server/datahub/mcp");
const { datasetUrn, taskUrn } = await import("@/src/server/datahub/urns");

const REPO = new URL("../../", import.meta.url).pathname;
const PYTHON = execFileSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).trim();

const PORT = 3120;
const FLOW_ID = "obsel_integration_tests";

const STAMP = String(Date.now());
const PRODUCER = `observe_producer_${STAMP}`;
const READER = `observe_reader_${STAMP}`;
const TABLE = `observe_table_${STAMP}`;

let server: ObselServer;
let root: string;
let file: string;

const COLUMNS = ["order_id", "amount"];
const ORIGINAL = [
  { order_id: 1, amount: 10.5 },
  { order_id: 2, amount: 20.25 },
];

/** The fingerprint the producer would have reported, through the real path. */
function fingerprintOf(rows: Record<string, unknown>[]): { schema: string; content: string } {
  const script = [
    "import json, sys",
    "from agents.tables import canonicalise_numbers",
    "from agents.fingerprint import fingerprint",
    "table = canonicalise_numbers(json.loads(sys.argv[1]))",
    "print(json.dumps(fingerprint(table['rows'], table['columns'])))",
  ].join("\n");
  const out = execFileSync(PYTHON, ["-c", script, JSON.stringify({ columns: COLUMNS, rows })], {
    cwd: REPO,
    encoding: "utf8",
  });
  return JSON.parse(out) as { schema: string; content: string };
}

/** Run the real bridge against the real server, exactly as a cron job would. */
function runObserver(): { ok: boolean; observation?: { verdict: string }; error?: string } {
  const out = execFileSync(PYTHON, ["-m", "agents.observe"], {
    cwd: REPO,
    encoding: "utf8",
    input: JSON.stringify({ table: TABLE, path: file, obselUrl: server.url }),
    env: { ...process.env, OBSEL_API_TOKEN: API_TOKEN },
  });
  return JSON.parse(out) as { ok: boolean; observation?: { verdict: string }; error?: string };
}

beforeAll(async () => {
  await requireDataHub();
  await requireStaleTag();
  requireUvx();

  root = mkdtempSync(join(tmpdir(), "obsel-observe-"));
  file = join(root, "table.json");
  writeFileSync(file, JSON.stringify({ columns: COLUMNS, rows: ORIGINAL }));

  await registerTask(PRODUCER, ["raw_source"], [TABLE], "writes the table", "Producer");
  await registerTask(READER, [TABLE], [`${TABLE}_summary`], "reads it", "Reader");

  // Both finish honestly, so there is a recorded claim for an observation to
  // contradict and finished downstream work for it to invalidate.
  await coordinateCompletion({
    taskUrn: taskUrn(PRODUCER),
    fingerprints: { [datasetUrn(TABLE)]: fingerprintOf(ORIGINAL) },
    finishedAt: new Date().toISOString(),
    run: {
      runner: "integration-test",
      ms: 1,
      outputs: { [datasetUrn(TABLE)]: { rows: ORIGINAL.length, columns: COLUMNS } },
    },
  });
  await coordinateCompletion({
    taskUrn: taskUrn(READER),
    fingerprints: { [datasetUrn(`${TABLE}_summary`)]: { schema: "s", content: "c" } },
    finishedAt: new Date().toISOString(),
  });

  server = await startObsel(PORT, FLOW_ID);

  return async () => {
    rmSync(root, { recursive: true, force: true });
    await server.stop();
    await closeMcpClient();
  };
}, 300_000);

afterAll(async () => {
  await server?.stop();
  await closeMcpClient();
});

describe("an observation of a table nothing reported changing", () => {
  it("compares clean while the file still matches what was reported", async () => {
    // The quiet answer, and it has to be quiet: an observer that flagged an
    // unchanged table would make every scheduled run a false alarm.
    const result = runObserver();

    expect(result.ok).toBe(true);
    expect(result.observation?.verdict).toBe("current");
    expect((await readTask(taskUrn(READER)))?.stale).toBeNull();
  }, 120_000);

  it("marks downstream work when the file is edited behind obsel's back", async () => {
    /*
     * A real silent write: the bytes on disk change and no task reports it.
     * This is the case obsel was otherwise blind to until somebody happened to
     * read the table.
     */
    const edited = JSON.parse(readFileSync(file, "utf8")) as { rows: Record<string, number>[] };
    edited.rows[0].amount = 99.99;
    writeFileSync(file, JSON.stringify({ columns: COLUMNS, rows: edited.rows }));

    const result = runObserver();
    expect(result.observation?.verdict).toBe("changed");

    const reader = await readTask(taskUrn(READER));
    expect(reader?.status).toBe("stale");
    // Nobody is blamed: the producer did not write these bytes, and naming it
    // would send whoever acts on the mark to interrogate the wrong agent.
    expect(reader?.stale?.causedByTask).toBeNull();
    expect(reader?.stale?.reason).toContain("an outside observer reported");
  }, 120_000);

  it("compares clean on a second run over the same bytes", async () => {
    // The observation was recorded on the producer, so the same silent change is
    // raised once rather than every time anything looks at it.
    const result = runObserver();
    expect(result.observation?.verdict).toBe("current");
  }, 120_000);

  it("refuses an unauthenticated observation", async () => {
    // It writes marks, so it carries the same gate as a completion.
    const response = await fetch(`${server.url}/api/datasets/observe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dataset: TABLE,
        fingerprint: { schema: "s", content: "c" },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    expect(response.status).toBe(401);
  }, 120_000);

  it("says so rather than guessing when nothing has recorded writing the table", async () => {
    /*
     * "obsel holds no claim about this" and "nothing changed" are different
     * answers, and collapsing them would let an observation of a table obsel
     * never watched read as an all-clear.
     */
    const response = await fetch(`${server.url}/api/datasets/observe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({
        dataset: `nothing_writes_this_${STAMP}`,
        fingerprint: { schema: "s", content: "c" },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await response.json()) as { verdict: string; affected: unknown[] };
    expect(body.verdict).toBe("no-record");
    expect(body.affected).toEqual([]);
  }, 120_000);
});
