/**
 * Columns a task registered as meaningless, against a real DataHub.
 *
 * The decisive case: a re-run whose ONLY difference is a load timestamp must
 * mark nothing. That is a claim about what obsel treats as evidence, so it is
 * proven the whole way through — a real registration carrying the declaration,
 * a real DataHub property read back, real files hashed by the real Python
 * fingerprint path, and the real coordinator deciding.
 *
 * Nothing is stood in for. The tables are written to a real temporary directory
 * and hashed by spawning the interpreter by absolute path, so what is compared
 * here is what an agent would actually produce.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireDataHub, requireStaleTag, requireUvx } from "./reachable";

const { coordinateCompletion, registerTask } = await import("@/src/server/coordinator/engine");
const { readTask } = await import("@/src/server/datahub/client");
const { closeMcpClient } = await import("@/src/server/datahub/mcp");
const { datasetUrn, taskUrn } = await import("@/src/server/datahub/urns");

const REPO = new URL("../../", import.meta.url).pathname;
const PYTHON = execFileSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).trim();

/** Unique per run, so a re-run of this file starts from no recorded baseline. */
const STAMP = String(Date.now());
const PRODUCER = `volatile_producer_${STAMP}`;
const READER = `volatile_reader_${STAMP}`;
const TABLE = `volatile_table_${STAMP}`;

let root: string;

/**
 * The fingerprint a real agent would compute for this table, through the real
 * path: `canonicalise_numbers` then `fingerprint`, with the producer's declared
 * exclusions applied exactly as `mcp_core.completion_body` applies them.
 *
 * Spawned by absolute path, per the repository's rule: a test that resolved
 * `python3` off PATH would prove only that the test could run.
 */
function fingerprintOf(
  rows: Record<string, unknown>[],
  columns: string[],
  exclude: string[],
): { schema: string; content: string } {
  const script = [
    "import json, sys",
    "from agents.tables import canonicalise_numbers",
    "from agents.fingerprint import fingerprint",
    "table = canonicalise_numbers(json.loads(sys.argv[1]))",
    "print(json.dumps(fingerprint(table['rows'], table['columns'], exclude=json.loads(sys.argv[2]))))",
  ].join("\n");
  const out = execFileSync(
    PYTHON,
    ["-c", script, JSON.stringify({ columns, rows }), JSON.stringify(exclude)],
    { cwd: REPO, encoding: "utf8" },
  );
  return JSON.parse(out) as { schema: string; content: string };
}

const COLUMNS = ["order_id", "amount", "loaded_at"];
const ROWS_AT_ONE = [
  { order_id: 1, amount: 10.5, loaded_at: "2026-07-29T01:00:00Z" },
  { order_id: 2, amount: 20.25, loaded_at: "2026-07-29T01:00:00Z" },
];
/** The same data, loaded again an hour later. Nothing about the orders moved. */
const ROWS_AT_TWO = ROWS_AT_ONE.map((row) => ({ ...row, loaded_at: "2026-07-29T02:00:00Z" }));
/** A genuine change, with the timestamp moving too, as it would in a real run. */
const ROWS_CHANGED = ROWS_AT_TWO.map((row) =>
  row.order_id === 1 ? { ...row, amount: 99.99 } : row,
);

async function report(rows: Record<string, unknown>[]): Promise<void> {
  await coordinateCompletion({
    taskUrn: taskUrn(PRODUCER),
    fingerprints: { [datasetUrn(TABLE)]: fingerprintOf(rows, COLUMNS, ["loaded_at"]) },
    finishedAt: new Date().toISOString(),
    run: {
      runner: "integration-test",
      ms: 1,
      outputs: { [datasetUrn(TABLE)]: { rows: rows.length, columns: COLUMNS } },
    },
  });
}

beforeAll(async () => {
  await requireDataHub();
  await requireStaleTag();
  requireUvx();

  root = mkdtempSync(join(tmpdir(), "obsel-volatile-"));
  writeFileSync(join(root, "table.json"), JSON.stringify({ columns: COLUMNS, rows: ROWS_AT_ONE }));

  await registerTask(PRODUCER, ["raw_source"], [TABLE], "writes a stamped table", "Producer", {
    [TABLE]: ["loaded_at"],
  });
  await registerTask(READER, [TABLE], [`${TABLE}_summary`], "reads it", "Reader");

  return async () => {
    rmSync(root, { recursive: true, force: true });
    await closeMcpClient();
  };
}, 300_000);

afterAll(async () => {
  await closeMcpClient();
});

describe("a column registered as volatile", () => {
  it("is recorded on the task in DataHub, keyed by the dataset URN", async () => {
    // Readable by anyone, off the entity, which is what makes the exclusion
    // auditable rather than a private arrangement inside one process.
    const producer = await readTask(taskUrn(PRODUCER));
    expect(producer?.volatile).toEqual({ [datasetUrn(TABLE)]: ["loaded_at"] });
  });

  it("refuses a re-registration that changes the list", async () => {
    /*
     * The exclusions decide what the recorded fingerprints MEAN, so two
     * fingerprints taken under different lists are not comparable. Accepting
     * this silently would make the next comparison a difference in method
     * reported as a difference in data.
     */
    await expect(
      registerTask(PRODUCER, ["raw_source"], [TABLE], undefined, undefined, {
        [TABLE]: ["loaded_at", "amount"],
      }),
    ).rejects.toThrow(/different set of volatile columns/);
  });

  it("marks nothing when a re-run differs only in that column", async () => {
    /*
     * The whole point. `loaded_at` moves on every run and carries no
     * information; without the exclusion this cascades to every downstream task
     * every single time, and the marks become noise people mute.
     */
    await report(ROWS_AT_ONE);
    await coordinateCompletion({
      taskUrn: taskUrn(READER),
      fingerprints: { [datasetUrn(`${TABLE}_summary`)]: { schema: "s", content: "c" } },
      finishedAt: new Date().toISOString(),
    });

    // The same orders, loaded an hour later. Only `loaded_at` differs.
    const result = await coordinateCompletion({
      taskUrn: taskUrn(PRODUCER),
      fingerprints: { [datasetUrn(TABLE)]: fingerprintOf(ROWS_AT_TWO, COLUMNS, ["loaded_at"]) },
      finishedAt: new Date().toISOString(),
    });

    expect(result.changedOutputs).toEqual([]);
    expect(result.affected).toEqual([]);
    expect((await readTask(taskUrn(READER)))?.stale).toBeNull();
  });

  it("still marks when a column that is not excluded moves", async () => {
    // The exclusion must not be a way to go quiet. `amount` changing is a real
    // change, and the timestamp moving alongside it changes nothing about that.
    await report(ROWS_AT_TWO);
    await coordinateCompletion({
      taskUrn: taskUrn(READER),
      fingerprints: { [datasetUrn(`${TABLE}_summary`)]: { schema: "s", content: "c" } },
      finishedAt: new Date().toISOString(),
    });

    const result = await coordinateCompletion({
      taskUrn: taskUrn(PRODUCER),
      fingerprints: { [datasetUrn(TABLE)]: fingerprintOf(ROWS_CHANGED, COLUMNS, ["loaded_at"]) },
      finishedAt: new Date().toISOString(),
    });

    expect(result.changedOutputs.map((change) => change.kind)).toEqual(["content"]);
    expect(result.affected.map((entry) => entry.task.name)).toEqual([READER]);

    // And the mark says what the comparison ignored, so a reader can tell this
    // apart from the clock moving.
    const reader = await readTask(taskUrn(READER));
    expect(reader?.stale?.reason).toContain("loaded_at");
    expect(reader?.stale?.reason).toContain("registered as changing every run");
  });
});
