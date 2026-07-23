/**
 * `agents/codex_runner.py` against a real Codex session.
 *
 * The module's own self-check (`pnpm test:python`) covers the prompt and every branch of
 * `_validate` over real files, and needs nothing installed. What it cannot cover is the one
 * thing this file exists for: **that the invocation works at all.**
 *
 * That is not a formality. The two flags in `run_agent` were, in the module's own words,
 * learned by running it rather than by reading about it:
 *
 *   - `--sandbox workspace-write`, without which the agent cannot write its output;
 *   - `--skip-git-repo-check`, because the data directory is gitignored and Codex otherwise
 *     refuses to run outside a repository.
 *
 * Neither can be checked by inspection, both are silent when wrong in the way that matters
 * (the agent runs, writes nothing, and the run fails at validation looking like a model
 * problem), and no stand-in can tell you whether today's Codex still accepts them. So one
 * real session runs here.
 *
 * **This file makes a real model call.** It is the only one in the repository that does.
 * It is kept to a single session over a two-row table with an unambiguous job, because the
 * subject is the invocation and the contract, not the model's reasoning. Expect it to
 * dominate this suite's wall-clock.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { requireCodex } from "./reachable";

const REPO = new URL("../../", import.meta.url).pathname;

/** Two rows and one obvious job, so the agent's answer is checkable without judging prose. */
const INPUT = {
  columns: ["order_id", "amount"],
  rows: [
    { order_id: 1, amount: 10 },
    { order_id: 2, amount: 32 },
  ],
};

let version: string;
let root: string;

/**
 * Call `codex_runner.run_agent` for real, and return its result as JSON.
 *
 * The whole call goes through `python3 -c` rather than being reimplemented here, so what
 * runs is the function the demo runs, with its own argument list and its own validation.
 */
function runAgent(options: {
  instruction: string;
  outputFile: string;
  expectColumns: string[] | null;
  timeout?: number;
}):
  | { ok: true; table: { columns: string[]; rows: unknown[] }; seconds: number; version: string }
  | {
      ok: false;
      error: string;
    } {
  const script = [
    "import json",
    "from pathlib import Path",
    "from agents import codex_runner",
    "try:",
    "    table, seconds, version = codex_runner.run_agent(",
    `        instruction=${JSON.stringify(options.instruction)},`,
    `        input_files=["input.json"],`,
    `        output_file=${JSON.stringify(options.outputFile)},`,
    `        working_dir=Path(${JSON.stringify(root)}),`,
    `        expect_columns=${options.expectColumns ? JSON.stringify(options.expectColumns) : "None"},`,
    `        timeout=${options.timeout ?? 600},`,
    "    )",
    "    print(json.dumps({'ok': True, 'table': table, 'seconds': seconds, 'version': version}))",
    "except BaseException as error:",
    "    print(json.dumps({'ok': False, 'error': f'{type(error).__name__}: {error}'}))",
  ].join("\n");

  const out = execFileSync("python3", ["-c", script], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(out.trim().split("\n").pop()!);
}

beforeAll(() => {
  version = requireCodex();
  root = mkdtempSync(join(tmpdir(), "obsel-codex-"));
  writeFileSync(join(root, "input.json"), `${JSON.stringify(INPUT, null, 2)}\n`);

  return () => rmSync(root, { recursive: true, force: true });
});

describe("the CLI is found before any work is attempted", () => {
  it("reports a version, so a missing CLI fails at preflight and not mid-demo", () => {
    // `codex_version` is the demo's own preflight. Its value is recorded on the run and
    // printed, so an operator can say which agent produced a table.
    expect(version).toMatch(/\d+\.\d+/);
  });

  it("names the CLI and the fix when it is not on PATH", () => {
    /*
     * Real, not simulated: the subprocess is given a PATH that genuinely does not contain
     * `codex`. This is the message an operator sees before anything has run, and it has to
     * name the thing that is missing rather than surface a FileNotFoundError from deep in
     * subprocess.
     *
     * Python is invoked by absolute path for that reason. Emptying PATH removes `python3`
     * along with `codex`, and the first attempt at this test failed with a spawn ENOENT
     * that proved only that the test could not start.
     */
    const python = execFileSync("sh", ["-c", "command -v python3"], {
      encoding: "utf8",
    }).trim();

    const out = execFileSync(
      python,
      [
        "-c",
        [
          "from agents import codex_runner",
          "try:",
          "    codex_runner.codex_version()",
          "except codex_runner.CodexUnavailable as error:",
          "    print(error)",
        ].join("\n"),
      ],
      { cwd: REPO, encoding: "utf8", env: { ...process.env, PATH: "/nonexistent" } },
    );

    expect(out).toContain("`codex` CLI is not on PATH");
  });
});

describe("a stale output cannot be mistaken for this run's work", () => {
  it("removes the output file before the agent starts", () => {
    /*
     * The property, isolated. `run_agent` unlinks the target first, and the reason is
     * specific: if a previous run's table survived and this run wrote nothing, validation
     * would accept the OLD table, obsel would fingerprint it, find it unchanged, and
     * report that the agent produced identical output. A failed run would read as a
     * successful no-change re-run — the demo's quiet step, arrived at by accident.
     *
     * Isolated by giving Codex a one-second ceiling it cannot possibly meet, so the run
     * dies before the agent can write anything. What is then observable is whether the
     * stale file survived. No model call completes here, so this costs a second.
     */
    const stale = { columns: ["marker"], rows: [{ marker: "left over from an earlier run" }] };
    writeFileSync(join(root, "stale.json"), `${JSON.stringify(stale)}\n`);
    expect(existsSync(join(root, "stale.json"))).toBe(true);

    const result = runAgent({
      instruction: "Copy the input.",
      outputFile: "stale.json",
      expectColumns: null,
      timeout: 1,
    });

    expect(result.ok).toBe(false);
    expect(existsSync(join(root, "stale.json"))).toBe(false);
  });
});

describe("a real Codex session does the work and meets its contract", () => {
  /** A real session, over the network, with the CLI's own startup on top. */
  const AGENT_TIMEOUT = 600_000;

  it(
    "reads the input, writes the output, and returns what is on disk",
    async () => {
      /*
       * The one real agent run. Everything asserted below is a property of the
       * invocation rather than of the model's judgement: that Codex could read a file in
       * the working directory it was given, could write to it (`--sandbox
       * workspace-write`), was not refused for being outside a git repository
       * (`--skip-git-repo-check`), and produced a table matching the exact column
       * contract the demo depends on.
       *
       * The job is arithmetic over two rows so that "did it do the work" has one answer.
       */
      const result = runAgent({
        instruction:
          "Copy every row through, keeping order_id and amount unchanged, and add a " +
          "column called amount_doubled holding amount multiplied by two.",
        outputFile: "output.json",
        expectColumns: ["order_id", "amount", "amount_doubled"],
      });

      if (!result.ok) throw new Error(`the agent run failed: ${result.error}`);

      expect(result.table.columns).toEqual(["order_id", "amount", "amount_doubled"]);
      expect(result.table.rows).toHaveLength(2);

      // It did the arithmetic, which is the only way to tell an agent that worked from one
      // that wrote a well-shaped empty-headed table.
      const doubled = (result.table.rows as { amount_doubled: number }[])
        .map((row) => Number(row.amount_doubled))
        .sort((a, b) => a - b);
      expect(doubled).toEqual([20, 64]);

      // A measured number, recorded on the run and printed by the demo. Nothing here
      // asserts how fast it was, only that the measurement is real.
      expect(result.seconds).toBeGreaterThan(0);
      expect(result.version).toBe(version);

      // What came back is what is on disk, not what the agent said it wrote. The next
      // agent reads the file, and obsel fingerprints the file.
      const onDisk = JSON.parse(readFileSync(join(root, "output.json"), "utf8"));
      expect(onDisk.columns).toEqual(result.table.columns);
    },
    AGENT_TIMEOUT,
  );
});
