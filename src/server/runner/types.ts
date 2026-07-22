/**
 * Shapes shared between the demo runner and the cockpit.
 *
 * Types only — no runtime imports — so browser code can `import type` from
 * here without pulling `child_process` into a client bundle.
 */

/** The demo steps the cockpit may launch. Exactly `agents.run`'s commands. */
export type DemoStep = "setup" | "register" | "run" | "rerun-same" | "change" | "reset";

/** A step currently executing on this machine. */
export interface RunningStep {
  step: DemoStep;
  /** ISO timestamp, stamped by the server that spawned it. */
  startedAt: string;
}

/** How the most recent step ended. */
export interface StepResult {
  step: DemoStep;
  /**
   * The process's own exit code — 0 is the step's self-assertions all passing.
   * `null` when the process was killed by a signal instead of exiting.
   */
  exitCode: number | null;
  signal: string | null;
  startedAt: string;
  finishedAt: string;
  /** Wall time of the step, start to exit, measured on one clock (the server's). */
  durationMs: number;
}

/** One environment check: what was observed, and the exact fix when it failed. */
export interface PreflightCheck {
  ok: boolean;
  /** What was actually observed, e.g. "GMS answered at http://localhost:8080". */
  detail: string;
  /** The command that fixes it, or null when ok or when another check must pass first. */
  fix: string | null;
}

/**
 * Everything the demo needs before an agent can run, each genuinely checked.
 *
 * `vocabulary` is whether `agents.run setup` has registered obsel's tag in
 * DataHub — without it staleness is detected and silently not recorded.
 */
export interface Preflight {
  datahub: PreflightCheck;
  vocabulary: PreflightCheck;
  venv: PreflightCheck;
  codex: PreflightCheck;
}

/** The body of `GET /api/demo/activity`. */
export interface DemoActivity {
  running: RunningStep | null;
  lastResult: StepResult | null;
  /**
   * Bounded tail of the running (or last) step's own stdout and stderr — the
   * same assertions the CLI prints, so the cockpit shows the step's own
   * evidence rather than a paraphrase.
   */
  log: string[];
  preflight: Preflight;
}
