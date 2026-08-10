/**
 * `worker.run_task` end to end: the sequence, not its ends.
 *
 * Both ends of this function are already covered against the real thing. The in-flight guard
 * has `worker.live.test.ts`, each runner's invocation has `runners.live.test.ts`, and the
 * canonicalization and fingerprint properties have 23 offline self-checks. What none of them
 * touch is the join: announce, run the agent, canonicalize, save, remember, fingerprint,
 * report, clear the marker. That sequence is what an agent actually is, and until this file
 * it was exercised only by running the demo by hand.
 *
 * Three things about it are worth checking rather than assuming, and each is a decision the
 * code makes deliberately and documents:
 *
 *   - **A missing input must not move obsel.** Inputs are loaded before the announcement, so
 *     an agent that cannot read its upstream table fails without ever telling obsel it began.
 *     The failure is this machine's, not the swarm's.
 *   - **A failed agent must hand its announcement back.** obsel only marks *finished* work
 *     stale, so a task left at `running` is skipped by every later traversal while the board
 *     still shows work in flight. That is a false negative, the one answer obsel must never
 *     give.
 *   - **And handing it back must not erase a good run.** `priorStatus` restores what a dead
 *     run left untouched, so a failure while re-running an already-complete task returns it to
 *     `complete`, not to `registered`.
 *
 * **These tests are a sequence.** Each one's end state is the next one's premise, which is
 * how the demo behaves too. Each therefore asserts its own premise before acting, so a change
 * in ordering fails loudly instead of quietly testing something else.
 *
 * One real agent session runs here, on whichever runner this machine selects.
 * `report=False` is not covered: nothing calls it.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { API_TOKEN, startObsel } from "./obsel-server";
import type { ObselServer } from "./obsel-server";
import {
  requireDataHub,
  requireRunner,
  requireStaleTag,
  requireUvx,
  selectedRunner,
} from "./reachable";
import type { LiveRunner } from "./reachable";

const { registerTask } = await import("@/src/server/coordinator/engine");
const { readTask } = await import("@/src/server/datahub/client");
const { closeMcpClient } = await import("@/src/server/datahub/mcp");
const { taskUrn } = await import("@/src/server/datahub/urns");

const REPO = new URL("../../", import.meta.url).pathname;
/**
 * Python by absolute path, so a test can empty PATH without removing the interpreter.
 *
 * One test here produces a genuine agent failure by taking the agent CLI off PATH.
 * Spawning `python3` by name under that PATH fails to start at all, which proves only that
 * the test could not run.
 */
const PYTHON = execFileSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).trim();
const FLOW_ID = "obsel_integration_tests";
/** Its own port: 3000 is the operator's, 3099 and 3098 belong to the other two live files. */
const PORT = 3097;

const SUBJECT = "run_task_subject";
const INPUT_TABLE = "run_task_input";
const OUTPUT_TABLE = "run_task_output";
const CONTRACT = ["id", "amount", "amount_doubled"];
const INSTRUCTION =
  "Copy every row through, keeping id and amount unchanged, and add a column called " +
  "amount_doubled holding amount multiplied by two.";

/**
 * Two rows, so "did the agent do the work" has exactly one right answer.
 *
 * One amount is fractional on purpose. Doubling 10.5 gives a whole number an agent may hand
 * over as either `21` or `21.0`, and that is precisely what `canonicalise_numbers` exists to
 * normalize: a live run wrote a money value as `217` where the run before wrote `217.0`, and
 * the two hash differently. With whole inputs throughout, the agent has no occasion to write
 * a `.0` at all and the check on the saved file below would not be exercising anything.
 */
const INPUT_ROWS = [
  { id: 1, amount: 10.5 },
  { id: 2, amount: 32 },
];

let obselServer: ObselServer;
/** The root a successful run happens under. Holds the input table and the marker. */
let root: string;
/**
 * The runner this machine would really pick, resolved once.
 *
 * The subject here is a whole `run_task` rather than any one CLI's invocation, which
 * `runners.live.test.ts` covers per runner. So this file runs exactly one session and
 * runs it on whatever the demo would have used.
 */
let RUNNER: LiveRunner;

interface RunTaskResult {
  ok: boolean;
  error?: string;
  result?: {
    task: string;
    output_table: string;
    output_path: string;
    columns: string[];
    row_count: number;
    fingerprints: Record<string, { schema: string; content: string }>;
    plan_source: string;
    model_seconds: number;
    total_seconds: number;
    coordination: Record<string, unknown>;
    start: string;
  };
  /** Recomputed from the file on disk, so the recorded hash can be checked against it. */
  onDisk?: { schema: string; content: string } | null;
  remembered?: { instruction: string; columns: string[] } | null;
}

/**
 * Call the real `worker.run_task` in a subprocess, and report what came back.
 *
 * The whole call runs in Python rather than being reassembled here, so what is under test is
 * the function the demo calls, with its own ordering and its own failure handling. `env`
 * exists for one test only: removing the agent CLI from PATH is how a genuine agent failure
 * is produced without breaking anything else.
 */
function runTask(options: { root: string; env?: Record<string, string> }): RunTaskResult {
  const script = [
    "import json",
    "from dataclasses import asdict",
    "from pathlib import Path",
    "from agents import pipeline, worker",
    "from agents.fingerprint import fingerprint",
    `root = Path(${JSON.stringify(options.root)})`,
    "task = pipeline.AgentTask(",
    `    name=${JSON.stringify(SUBJECT)},`,
    "    kind='clean',",
    "    title='Run task subject',",
    "    summary='doubles a column, for the integration suite',",
    `    reads=(${JSON.stringify(INPUT_TABLE)},),`,
    `    writes=${JSON.stringify(OUTPUT_TABLE)},`,
    `    output_columns=tuple(${JSON.stringify(CONTRACT)}),`,
    `    instruction=${JSON.stringify(INSTRUCTION)},`,
    ")",
    "try:",
    "    result = worker.run_task(",
    `        task, obsel_url=${JSON.stringify(obselServer.url)}, root=root`,
    "    )",
    "except BaseException as error:",
    "    print(json.dumps({'ok': False, 'error': f'{type(error).__name__}: {error}'}))",
    "else:",
    // Recomputed from the saved file, so the fingerprint obsel recorded can be compared
    // against the bytes the next agent will actually read.
    "    saved = worker.load_table(task.writes, root)",
    "    print(json.dumps({",
    "        'ok': True,",
    "        'result': asdict(result),",
    "        'onDisk': fingerprint(saved['rows'], saved['columns']),",
    "        'remembered': worker.last_run(task.name, root),",
    "    }))",
  ].join("\n");

  const out = spawnSync(PYTHON, ["-c", script], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, OBSEL_FLOW_ID: FLOW_ID, OBSEL_API_TOKEN: API_TOKEN, ...options.env },
  });
  const text = `${out.stdout ?? ""}`.trim();
  if (!text) {
    throw new Error(
      `run_task produced no output.\nspawn: ${out.error ?? "started"}\nstderr:\n${out.stderr}`,
    );
  }
  return JSON.parse(text.split("\n").pop()!);
}

/** obsel's own view of the subject, read out of DataHub. */
async function statusOf(): Promise<string | undefined> {
  return (await readTask(taskUrn(SUBJECT)))?.status;
}

function markerExists(under: string): boolean {
  return existsSync(join(under, ".obsel", "state", "inflight", `${SUBJECT}.json`));
}

beforeAll(async () => {
  await requireDataHub();
  await requireStaleTag();
  requireUvx();
  RUNNER = selectedRunner();
  requireRunner(RUNNER);

  await registerTask(SUBJECT, [INPUT_TABLE], [OUTPUT_TABLE], undefined, "Run task subject");
  root = mkdtempSync(join(tmpdir(), "obsel-runtask-"));

  // The upstream table, written the way an upstream agent would write it.
  spawnSync(
    "python3",
    [
      "-c",
      [
        "from pathlib import Path",
        "from agents import worker",
        `worker.save_table(${JSON.stringify(INPUT_TABLE)}, ` +
          `{'columns': ['id', 'amount'], 'rows': ${JSON.stringify(INPUT_ROWS)}}, ` +
          `Path(${JSON.stringify(root)}))`,
      ].join("\n"),
    ],
    { cwd: REPO, encoding: "utf8" },
  );

  obselServer = await startObsel(PORT, FLOW_ID);

  return async () => {
    rmSync(root, { recursive: true, force: true });
    await obselServer.stop();
    await closeMcpClient();
  };
});

describe("an agent that cannot read its input never tells obsel it began", () => {
  it("fails on the missing table and leaves obsel exactly as it was", async () => {
    expect(await statusOf(), "premise: the subject has not run yet").toBe("registered");

    /*
     * A root with no input table in it. Real: this is what an operator gets when they run an
     * agent before the one upstream of it, and it is why `run_task` loads its inputs before
     * announcing anything. Announcing first would leave the task at `running` over a failure
     * that has nothing to do with the swarm.
     */
    const empty = mkdtempSync(join(tmpdir(), "obsel-noinput-"));
    try {
      const outcome = runTask({ root: empty });

      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain("FileNotFoundError");
      expect(outcome.error).toContain(`${INPUT_TABLE}.json`);
      // Untouched on both sides: obsel never heard about it, and no marker was written.
      expect(await statusOf()).toBe("registered");
      expect(markerExists(empty)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("a full run, from announcement to confirmed completion", () => {
  /** One real Codex session, plus obsel's bounded polling on every DataHub write. */
  const RUN_TIMEOUT = 600_000;

  it(
    "runs the agent, saves what it wrote, and reports it to obsel",
    async () => {
      expect(await statusOf(), "premise: nothing has completed yet").toBe("registered");

      const outcome = runTask({ root });
      if (!outcome.ok) throw new Error(`run_task failed: ${outcome.error}`);
      const result = outcome.result!;

      // The agent did the job, and to the contract.
      expect(result.columns).toEqual(CONTRACT);
      expect(result.row_count).toBe(2);
      expect(result.start).toBe("announced");
      expect(result.plan_source).toContain("codex");

      // Both measurements are real, and the total covers the model rather than excluding it.
      expect(result.model_seconds).toBeGreaterThan(0);
      expect(result.total_seconds).toBeGreaterThanOrEqual(result.model_seconds);

      // What is on disk is what the next agent reads, so it is what must be there.
      const saved = JSON.parse(readFileSync(result.output_path, "utf8"));
      expect(saved.columns).toEqual(CONTRACT);
      const doubled = (saved.rows as { amount_doubled: number }[])
        .map((row) => Number(row.amount_doubled))
        .sort((a, b) => a - b);
      expect(doubled).toEqual([21, 64]);

      /*
       * The serialized form the next agent will read, which is what the recorded fingerprint
       * below was taken over.
       *
       * `canonicalise_numbers` decides value by value: a whole number is written as an integer
       * whichever way the agent spelled it, and the 10.5 beside it decides nothing. So the file
       * must hold `32` and `64` and `21`, and must not hold `32.0`, `64.0` or `21.0` -- the
       * doubling of 10.5 is the one an agent is most likely to hand over as a float, and if it
       * does, this is the conversion that removed the `.0`. An agent that already wrote an
       * integer leaves nothing to convert, and the assertion then holds without exercising it;
       * a surviving `.0` fails it either way.
       */
      expect(readFileSync(join(root, ".obsel", "data", `${INPUT_TABLE}.json`), "utf8")).toContain(
        '"amount": 32,',
      );
      const savedText = readFileSync(result.output_path, "utf8");
      expect(savedText).toContain('"amount": 32,');
      expect(savedText).not.toMatch(/"(amount|amount_doubled)": \d+\.0\b/);

      /*
       * The fingerprint obsel recorded describes the bytes on disk, not the table as the agent
       * handed it over. `canonicalise_numbers` runs before both the save and the hash for
       * exactly this reason: hashing a canonical table and saving a non-canonical one would put
       * the record and the file permanently out of step, and every later comparison would be
       * against something that was never written.
       */
      const recorded = Object.values(result.fingerprints)[0];
      expect(recorded).toEqual(outcome.onDisk);

      // obsel's own view, read back out of DataHub rather than inferred from the call
      // returning. It is the record; the terminal output is not.
      expect(await statusOf()).toBe("complete");

      // The coordination reply is present and shaped, so `run.py` has something to check its
      // printed claims against rather than a missing key it would have to interpret.
      expect(result.coordination).toHaveProperty("changedOutputs");
      expect(result.coordination).toHaveProperty("affected");

      // The marker is gone, so the next run of this agent is an ordinary run and not a resume.
      expect(markerExists(root)).toBe(false);

      // And the pair `rerun-same` replays: the instruction together with the columns it
      // actually produced. Separating them reverted a rename live on 2026-07-22.
      expect(outcome.remembered?.instruction).toBe(INSTRUCTION);
      expect(outcome.remembered?.columns).toEqual(CONTRACT);
    },
    RUN_TIMEOUT,
  );
});

describe("a failed agent hands its announcement back without erasing the run before it", () => {
  it("returns the task to complete, not to registered", async () => {
    expect(await statusOf(), "premise: the previous test completed this task").toBe("complete");

    /*
     * A genuine agent failure, produced without breaking anything: the subprocess gets a PATH
     * that does not contain the agent CLI, so the runner's own `*_version` raises inside
     * `_run_agent` — after the announcement has already moved obsel to `running`. That is the
     * window this test is about.
     *
     * OBSEL_RUNNER is pinned to the runner this machine selected. Without it, an empty PATH
     * would make detection find neither CLI and raise `NoRunnerAvailable`, which is a real
     * error but a different one: it happens before a runner is chosen, so it would not prove
     * that a *chosen* runner failing hands the announcement back.
     *
     * Two things then have to happen. The announcement must be handed back, or the task sits
     * at `running` forever and every later cascade skips it while the board looks healthy. And
     * it must be handed back to what it was, because a failed re-run of a good result must not
     * report that the good result never happened.
     */
    const outcome = runTask({ root, env: { PATH: "/nonexistent", OBSEL_RUNNER: RUNNER } });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain(RUNNER === "codex" ? "CodexUnavailable" : "ClaudeUnavailable");

    expect(await statusOf()).toBe("complete");
    expect(markerExists(root)).toBe(false);
  });

  it("leaves the previous run's output and record in place", async () => {
    // The failure touched nothing it did not own. The table the last good run wrote is still
    // there for downstream agents, and the fingerprints obsel compares against are still
    // recorded, so the next successful run is compared against a real baseline.
    const record = await readTask(taskUrn(SUBJECT));

    expect(Object.keys(record?.fingerprints ?? {})).toHaveLength(1);
    expect(record?.finishedAt).not.toBeNull();
    expect(existsSync(join(root, ".obsel", "data", `${OUTPUT_TABLE}.json`))).toBe(true);
  });
});
