/**
 * `agents/codex_runner.py` and `agents/claude_runner.py`, each against a real session.
 *
 * The shared self-check (`pnpm test:python`) covers the prompt and every branch of
 * `agent_contract.validate` over real files, and needs nothing installed. What it cannot
 * cover is the one thing this file exists for: **that each invocation works at all.**
 *
 * That is not a formality. Every flag in both `run_agent` functions was learned by
 * running the CLI rather than by reading about it:
 *
 *   - Codex `--sandbox workspace-write`, without which the agent cannot write its output;
 *   - Codex `--skip-git-repo-check`, because the data directory is gitignored and Codex
 *     otherwise refuses to run outside a repository;
 *   - Claude Code `-p`, without which the CLI opens an interactive session and never returns;
 *   - Claude Code `--permission-mode acceptEdits`, without which writing a file that does
 *     not exist yet stops to ask;
 *   - Claude Code `--allowedTools "Bash(python3 *)"`, so a non-interactive scale agent can
 *     execute its table transformation without granting unrestricted Bash;
 *   - Claude Code `--model claude-sonnet-5` and `--effort medium`, so measured runs do not
 *     inherit account defaults that can change between sessions;
 *   - Claude Code `--safe-mode`, because the working directory is inside this repository
 *     and Claude Code otherwise reads obsel's own CLAUDE.md, skills and hooks on the way
 *     to doing a two-column rename. Two runs of the same prompt in the same directory
 *     differed by exactly that flag, and the run without it obeyed a parent CLAUDE.md and
 *     added a key the prompt never asked for.
 *
 * None can be checked by inspection, all are silent when wrong in the way that matters
 * (the agent runs, writes nothing or writes something subtly different, and the run fails
 * at validation looking like a model problem), and no stand-in can tell you whether
 * today's CLI still accepts them. So one real session runs per runner.
 *
 * **This file makes real model calls, one per installed runner.** Each is kept to a single
 * session over a two-row table with an unambiguous job, because the subject is the
 * invocation and the contract, not the model's reasoning. Expect it to dominate this
 * suite's wall-clock.
 *
 * A runner that is not installed is **skipped here and only here**, and the skip is
 * announced. Requiring both would make a machine with one CLI unable to run the suite at
 * all, which is the wall this whole change exists to remove. Everything with a single
 * runner as its subject still uses `selectedRunner()` and still refuses to skip.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { requireRunner, type LiveRunner } from "./reachable";

const REPO = new URL("../../", import.meta.url).pathname;

/** Two rows and one obvious job, so the agent's answer is checkable without judging prose. */
const INPUT = {
  columns: ["order_id", "amount"],
  rows: [
    { order_id: 1, amount: 10 },
    { order_id: 2, amount: 32 },
  ],
};

/** What each runner is called in Python, and the message its own preflight produces. */
const RUNNERS: {
  runner: LiveRunner;
  module: string;
  unavailable: string;
  missingMessage: string;
}[] = [
  {
    runner: "codex",
    module: "codex_runner",
    unavailable: "CodexUnavailable",
    missingMessage: "`codex` CLI is not on PATH",
  },
  {
    runner: "claude",
    module: "claude_runner",
    unavailable: "ClaudeUnavailable",
    missingMessage: "`claude` CLI is not on PATH",
  },
];

/** Whether this machine has the CLI, asked the way `which` would, without failing the run. */
function installed(cli: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${cli}`], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Call one runner's `run_agent` for real, and return its result as JSON.
 *
 * The whole call goes through `python3 -c` rather than being reimplemented here, so what
 * runs is the function the demo runs, with its own argument list and its own validation.
 */
function runAgent(
  module: string,
  root: string,
  options: {
    instruction: string;
    outputFile: string;
    expectColumns: string[] | null;
    timeout?: number;
  },
):
  | { ok: true; table: { columns: string[]; rows: unknown[] }; seconds: number; version: string }
  | { ok: false; error: string } {
  const script = [
    "import json",
    "from pathlib import Path",
    `from agents import ${module}`,
    "try:",
    `    table, seconds, version = ${module}.run_agent(`,
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

for (const { runner, module, unavailable, missingMessage } of RUNNERS) {
  const here = installed(runner);

  describe.skipIf(!here)(`${runner}: a real session does the work and meets its contract`, () => {
    let version: string;
    let root: string;

    beforeAll(() => {
      version = requireRunner(runner);
      root = mkdtempSync(join(tmpdir(), `obsel-${runner}-`));
      writeFileSync(join(root, "input.json"), `${JSON.stringify(INPUT, null, 2)}\n`);
      return () => rmSync(root, { recursive: true, force: true });
    });

    it("reports a version, so a missing CLI fails at preflight and not mid-demo", () => {
      // The runner's own preflight. Its value is recorded on the run and printed, so an
      // operator can say which agent produced a table.
      expect(version).toMatch(/\d+\.\d+/);
    });

    it("names the CLI and the fix when it is not on PATH", () => {
      /*
       * Real, not simulated: the subprocess is given a PATH that genuinely does not
       * contain the CLI. This is the message an operator sees before anything has run,
       * and it has to name the thing that is missing rather than surface a
       * FileNotFoundError from deep in subprocess.
       *
       * Python is invoked by absolute path for that reason. Emptying PATH removes
       * `python3` along with the CLI, and the first attempt at this test failed with a
       * spawn ENOENT that proved only that the test could not start.
       */
      const python = execFileSync("sh", ["-c", "command -v python3"], {
        encoding: "utf8",
      }).trim();

      const out = execFileSync(
        python,
        [
          "-c",
          [
            `from agents import ${module}`,
            "try:",
            `    ${module}.${runner}_version()`,
            `except ${module}.${unavailable} as error:`,
            "    print(error)",
          ].join("\n"),
        ],
        { cwd: REPO, encoding: "utf8", env: { ...process.env, PATH: "/nonexistent" } },
      );

      expect(out).toContain(missingMessage);
      // It offers the other runner, which is the whole point of there being two: an
      // operator missing one CLI has a second way forward that does not involve
      // installing anything they did not want.
      expect(out).toContain("OBSEL_RUNNER=");
    });

    it("removes the output file before the agent starts", () => {
      /*
       * The property, isolated. `run_agent` unlinks the target first, and the reason is
       * specific: if a previous run's table survived and this run wrote nothing,
       * validation would accept the OLD table, obsel would fingerprint it, find it
       * unchanged, and report that the agent produced identical output. A failed run
       * would read as a successful no-change re-run — the demo's quiet step, arrived at
       * by accident.
       *
       * Isolated by giving the CLI a one-second ceiling it cannot possibly meet, so the
       * run dies before the agent can write anything. What is then observable is whether
       * the stale file survived. No model call completes here, so this costs a second.
       */
      const stale = { columns: ["marker"], rows: [{ marker: "left over from an earlier run" }] };
      writeFileSync(join(root, "stale.json"), `${JSON.stringify(stale)}\n`);
      expect(existsSync(join(root, "stale.json"))).toBe(true);

      const result = runAgent(module, root, {
        instruction: "Copy the input.",
        outputFile: "stale.json",
        expectColumns: null,
        timeout: 1,
      });

      expect(result.ok).toBe(false);
      expect(existsSync(join(root, "stale.json"))).toBe(false);
    });

    it("reads the input, writes the output, and returns what is on disk", async () => {
      /*
       * The one real agent run for this runner. Everything asserted below is a
       * property of the invocation rather than of the model's judgement: that the CLI
       * could read a file in the working directory it was given, could write to it,
       * was not refused for where that directory sits, and produced a table matching
       * the exact column contract the demo depends on.
       *
       * The job is arithmetic over two rows so that "did it do the work" has one
       * answer.
       */
      const result = runAgent(module, root, {
        instruction:
          "Copy every row through, keeping order_id and amount unchanged, and add a " +
          "column called amount_doubled holding amount multiplied by two.",
        outputFile: "output.json",
        expectColumns: ["order_id", "amount", "amount_doubled"],
      });

      if (!result.ok) throw new Error(`the agent run failed: ${result.error}`);

      expect(result.table.columns).toEqual(["order_id", "amount", "amount_doubled"]);
      expect(result.table.rows).toHaveLength(2);

      // It did the arithmetic, which is the only way to tell an agent that worked from
      // one that wrote a well-shaped empty-headed table.
      const doubled = (result.table.rows as { amount_doubled: number }[])
        .map((row) => Number(row.amount_doubled))
        .sort((a, b) => a - b);
      expect(doubled).toEqual([20, 64]);

      /*
       * Exactly the declared columns and nothing else.
       *
       * This is the Claude Code `--safe-mode` assertion, and it is here for both
       * runners because the contract is shared. Without that flag a CLAUDE.md above
       * the working directory reached the agent and put an extra top-level key in the
       * table it wrote. `validate` accepts undeclared keys inside a row on purpose, so
       * a leak of that shape does not fail loudly on its own — it has to be looked for.
       */
      const onDisk = JSON.parse(readFileSync(join(root, "output.json"), "utf8"));
      expect(onDisk.columns).toEqual(result.table.columns);
      expect(Object.keys(onDisk).sort()).toEqual(["columns", "rows"]);

      // A measured number, recorded on the run and printed by the demo. Nothing here
      // asserts how fast it was, only that the measurement is real.
      expect(result.seconds).toBeGreaterThan(0);
      expect(result.version).toBe(version);
    }, 600_000); // A real session, over the network, with the CLI's own startup on top.
  });

  if (!here) {
    // Announced rather than silent. A skipped runner is the one case where this suite
    // reports less than it claims to, so it has to say which one and why.
    describe(`${runner}: not installed on this machine, so its session was not run`, () => {
      it("is skipped deliberately, and the other runner still ran", () => {
        expect(RUNNERS.some((other) => other.runner !== runner && installed(other.runner))).toBe(
          true,
        );
      });
    });
  }
}
