/**
 * The launcher's decisions, pure and testable — `launcher.ts` does the
 * spawning and owns the state; everything here is a function of its inputs,
 * the same split as `staleness.ts` against `engine.ts`.
 */

import path from "node:path";

import type { DemoStep, RunningStep } from "./types";

export const DEMO_STEPS: readonly DemoStep[] = [
  "setup",
  "register",
  "run",
  "rerun-same",
  "change",
  "reset",
];

/** Longest line kept, and how many lines — enough for any step's full output. */
export const LOG_MAX_LINES = 500;
export const LOG_MAX_LINE_CHARS = 2000;

/**
 * A refusal to launch, with the HTTP status the route should answer.
 * `null` from `refusal` means the launch may proceed.
 */
export interface LaunchRefusal {
  status: number;
  error: string;
  fix: string | null;
}

/** The interpreter the README's setup step creates. Checked, never assumed. */
export function venvPython(repoRoot: string): string {
  return path.join(repoRoot, "agents", ".venv", "bin", "python");
}

/**
 * Split a stream chunk into whole lines, carrying the unterminated remainder.
 *
 * Pure so it is testable: a chunk boundary in the middle of a line must not
 * produce two half-lines in the log the cockpit shows.
 */
export function splitLines(rest: string, chunk: string): { lines: string[]; rest: string } {
  const whole = rest + chunk;
  const parts = whole.split("\n");
  const remainder = parts.pop() ?? "";
  return {
    lines: parts.map((line) => line.replace(/\r$/, "").slice(0, LOG_MAX_LINE_CHARS)),
    rest: remainder,
  };
}

/** Append keeping only the newest `cap` lines. Pure; returns a new array. */
export function appendBounded(log: string[], lines: string[], cap: number): string[] {
  if (lines.length === 0) return log;
  const joined = log.concat(lines);
  return joined.length > cap ? joined.slice(joined.length - cap) : joined;
}

/**
 * Why a launch must be refused right now, or `null` to proceed.
 *
 * Pure — the caller supplies what it observed. The venv is checked here and
 * not left to the spawn failing, because "ENOENT" teaches nobody anything and
 * the fix is two exact commands.
 */
export function refusal(running: RunningStep | null, venvPresent: boolean): LaunchRefusal | null {
  if (running !== null) {
    return {
      status: 409,
      error: `${running.step} is already running. One step at a time, they share the same tables`,
      fix: null,
    };
  }
  if (!venvPresent) {
    return {
      status: 409,
      error: "the agents' Python environment (agents/.venv) does not exist yet",
      fix: "python3 -m venv agents/.venv && agents/.venv/bin/python -m pip install -r agents/requirements.txt",
    };
  }
  return null;
}
