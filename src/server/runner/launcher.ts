import "server-only";

/**
 * Runs the demo steps the cockpit's buttons ask for — the same
 * `python -m agents.run <step>` commands the README documents, spawned
 * verbatim. Nothing here decides anything: the step's own process does the
 * work, prints its own assertions, and exits honestly, and this module only
 * relays that. The decisions live in `steps.ts`, pure and tested.
 *
 * One step at a time, enforced here rather than hoped for in the UI: the
 * steps assume they run in sequence (a `change` during a `run` would race the
 * same tables), so a second launch while one is live is refused with a 409.
 *
 * This executes local processes by design. obsel's demo is a local tool on
 * the machine that owns the Codex login — nothing in this repository exposes
 * these routes beyond localhost, and the owner has explicitly decided against
 * hosting.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { LOG_MAX_LINES, appendBounded, refusal, splitLines, stepArgv, venvPython } from "./steps";
import type { LaunchRefusal } from "./steps";
import type { DemoStep, RunningStep, StepResult } from "./types";

interface LauncherState {
  running: RunningStep | null;
  lastResult: StepResult | null;
  log: string[];
}

// Survives Next's dev-server module reloads: a recompile must not forget a
// child process that is still doing real work against DataHub.
const globalRef = globalThis as typeof globalThis & { __obselLauncher?: LauncherState };

function state(): LauncherState {
  globalRef.__obselLauncher ??= { running: null, lastResult: null, log: [] };
  return globalRef.__obselLauncher;
}

/**
 * Launch one demo step. Returns the refusal instead when it cannot start.
 *
 * The child's stdout and stderr become the activity log verbatim — the step's
 * own printed assertions are the evidence the cockpit shows, not a paraphrase.
 *
 * `origin` is the server's own address as the request that asked for the
 * launch saw it, and passing it down is load-bearing, found the hard way on
 * 2026-07-24. The agents default to `http://localhost:3000`, so a step spawned
 * by an obsel on any other port reported to whatever was listening on 3000
 * instead of to the server whose button was pressed. With two obsels up (an
 * operator's and an isolated one) the isolated board's reset button reset the
 * operator's flow, and its register button put one foreign task into the
 * operator's pipeline before the step's own URN-mismatch guard stopped it.
 * The child now reports to the origin it was launched from, whatever that is.
 */
export function launchStep(
  step: DemoStep,
  origin?: string,
): LaunchRefusal | { running: RunningStep } {
  const current = state();
  const repoRoot = process.cwd();
  const python = venvPython(repoRoot);

  const refused = refusal(current.running, existsSync(python));
  if (refused) return refused;

  const startedAtMs = Date.now();
  const running: RunningStep = { step, startedAt: new Date(startedAtMs).toISOString() };

  // -u: unbuffered, so the step's lines reach the log as they are printed
  // rather than all at once at exit. The argv comes from `stepArgv` over the
  // DemoStep union, never from raw request text, and there is no shell involved.
  // The origin is not request text either: the route derives it from the URL
  // Next resolved, not from a header a client typed.
  const argv = stepArgv(step);
  const child = spawn(python, ["-u", "-m", "agents.run", ...argv], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      ...(origin ? { OBSEL_URL: origin } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  current.running = running;
  current.log = [`$ agents/.venv/bin/python -m agents.run ${argv.join(" ")}`];

  let restOut = "";
  let restErr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    const split = splitLines(restOut, chunk.toString("utf8"));
    restOut = split.rest;
    current.log = appendBounded(current.log, split.lines, LOG_MAX_LINES);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const split = splitLines(restErr, chunk.toString("utf8"));
    restErr = split.rest;
    current.log = appendBounded(current.log, split.lines, LOG_MAX_LINES);
  });

  // Node emits 'close' after 'error' when a spawn fails outright, so a failed
  // start would otherwise settle twice and double-append the flushed tail.
  let settled = false;
  const settle = (exitCode: number | null, signal: string | null): void => {
    if (settled) return;
    settled = true;
    // Flush an unterminated final line — a step that dies mid-print still
    // gets its last words shown.
    const tail = [restOut, restErr].filter((line) => line !== "");
    current.log = appendBounded(current.log, tail, LOG_MAX_LINES);
    const finishedAtMs = Date.now();
    current.lastResult = {
      step,
      exitCode,
      signal,
      startedAt: running.startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      // Start and finish stamped by this process on this clock. Never mix in
      // a timestamp from the child.
      durationMs: finishedAtMs - startedAtMs,
    };
    current.running = null;
  };

  child.on("error", (cause) => {
    current.log = appendBounded(current.log, [`failed to start: ${cause.message}`], LOG_MAX_LINES);
    settle(null, null);
  });
  child.on("close", (exitCode, signal) => settle(exitCode, signal));

  return { running };
}

/** What is running, how the last step ended, and the step's own output tail. */
export function activity(): {
  running: RunningStep | null;
  lastResult: StepResult | null;
  log: string[];
} {
  const current = state();
  return { running: current.running, lastResult: current.lastResult, log: current.log };
}
