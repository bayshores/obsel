/**
 * Shapes shared between the demo runner and the cockpit.
 *
 * Types only — no runtime imports — so browser code can `import type` from
 * here without pulling `child_process` into a client bundle.
 */

/**
 * The demo steps the cockpit may launch.
 *
 * Almost exactly `agents.run`'s commands. The one exception is
 * `scale-change-mid`, a step id for `scale-run --change-during` — the run
 * whose requirement changes while agents are still working — because the
 * launcher passes one step token and that command is a command plus a flag.
 * `stepArgv` in `steps.ts` owns the translation.
 */
export type DemoStep =
  | "setup"
  | "register"
  | "run"
  | "rerun-same"
  | "change"
  | "repair"
  | "reset"
  | "scale-register"
  | "scale-run"
  | "scale-change"
  | "scale-change-mid"
  | "scale-repair";

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
 *
 * `uvx` is the same failure one step later: obsel writes its tag through
 * DataHub's own MCP server, which is started with `uvx`, so without it the
 * staleness engine still decides correctly and the recording of what it decided
 * is what fails.
 */
export interface Preflight {
  datahub: PreflightCheck;
  vocabulary: PreflightCheck;
  venv: PreflightCheck;
  uvx: PreflightCheck;
  codex: PreflightCheck;
}

/** The body of `GET /api/demo/activity`. */
export interface DemoActivity {
  running: RunningStep | null;
  lastResult: StepResult | null;
  /**
   * Every step this server has finished, oldest first, bounded.
   *
   * The journey rail is derived from it: which acts of the walk have actually
   * been performed on this machine is a fact about what ran, and nothing else
   * on the board records it. `lastResult` cannot answer it — it holds one step,
   * so a board that has run the change would have forgotten the identical
   * re-run before it.
   *
   * It is a record, never a position. Nothing here says which act is current;
   * `journey()` in `src/features/cockpit/guide.ts` derives that from this plus
   * the board, and it re-derives on every poll like everything else the guide
   * shows. It does not survive a server restart, and the acts that board state
   * alone can see survive it anyway.
   */
  history: StepResult[];
  /**
   * Bounded tail of the running (or last) step's own stdout and stderr — the
   * same assertions the CLI prints, so the cockpit shows the step's own
   * evidence rather than a paraphrase.
   */
  log: string[];
  preflight: Preflight;
  /**
   * The command that connects an outside MCP agent to this obsel, with this
   * machine's real absolute interpreter path already in it.
   *
   * Computed on the server because only the server knows where the repository
   * lives; a browser rendering a placeholder path would hand the reader a
   * command that fails, which is worse than no command. Display only — nothing
   * decides on it.
   */
  joinCommand: string;
}
