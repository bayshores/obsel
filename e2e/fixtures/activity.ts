/**
 * Canned `GET /api/demo/activity` bodies for the browser suite.
 *
 * Typed as `DemoActivity` for the same reason the swarm fixtures are typed:
 * if the shape the cockpit reads drifts from what these describe,
 * `pnpm typecheck` fails before any browser runs.
 *
 * These are invented values. Nothing here may be screenshotted into the
 * submission or quoted as a measurement.
 */

import type { DemoActivity, DemoStep, PreflightCheck, StepResult } from "@/src/server/runner/types";

function ok(detail: string): PreflightCheck {
  return { ok: true, detail, fix: null };
}

/**
 * A machine that has been all the way through the demonstration: every step
 * performed, in order, each exiting 0.
 *
 * The board this goes with is a settled one, which is the state a completed run
 * ends in — and the state an untouched one starts in. The tour's repair act is
 * the one thing on the board that cannot tell those apart without this record,
 * which is why it is the only act that consults it.
 */
export function walked(): DemoActivity {
  const steps: DemoStep[] = ["register", "run", "rerun-same", "change", "repair"];
  return {
    ...idle(),
    history: steps.map((step, index) => ({
      step,
      exitCode: 0,
      signal: null,
      startedAt: `2026-07-22T09:0${index}:00.000Z`,
      finishedAt: `2026-07-22T09:0${index}:30.000Z`,
      durationMs: 30_000,
    })),
  };
}

/** Machine ready, nothing running, nothing run yet — the default backdrop. */
export function idle(): DemoActivity {
  return {
    running: null,
    lastResult: null,
    log: [],
    // Nothing has run on this machine, so the tour is carried entirely by what
    // the board shows. The one fixture that wants a step read out of the record
    // instead is `walked()`.
    history: [],
    preflight: {
      datahub: ok("DataHub answered at http://localhost:8080"),
      vocabulary: ok("urn:li:tag:obsel-stale is registered"),
      venv: ok("agents/.venv exists"),
      uvx: ok("uv is installed"),
      codex: ok("the Codex CLI is signed in"),
    },
    // A plausible absolute path, so the join panel renders the way it does on a
    // real machine. Invented like everything else here, and marked as such by
    // the placeholder home directory.
    joinCommand:
      "claude mcp add obsel -- /home/operator/obsel/agents/.venv/bin/python -m agents.mcp_server",
  };
}

/**
 * A step that has finished, which is what the board looks like for most of the demo.
 *
 * `idle()` reports nothing ever having run, so the guide's result line is absent and
 * a board built on it is thinner than any board a judge sees: every state after the
 * first click has a finished step behind it. The word-count ceiling was calibrated
 * against `idle()` and came out 18 words under the live figure, which made the guard
 * looser than the thing it guards.
 *
 * The step's own output is included and long on purpose. It sits behind a collapsed
 * `<details>`, so it must not count toward what is on screen, and a fixture with an
 * empty log could not catch it if it ever did.
 */
export function finishedStep(step: DemoStep = "change"): DemoActivity {
  const result: StepResult = {
    step,
    exitCode: 0,
    signal: null,
    startedAt: "2026-07-22T09:00:00.000Z",
    finishedAt: "2026-07-22T09:01:11.400Z",
    durationMs: 71_400,
  };
  return {
    ...idle(),
    lastResult: result,
    // The same step in the record it left behind. A board showing a finished
    // step and a rail claiming that step never ran would be two halves of one
    // panel disagreeing.
    history: [result],
    log: [
      `$ agents/.venv/bin/python -m agents.run ${step}`,
      `${step}: started`,
      "obsel called the change to clean_orders: schema",
      "obsel reached: build_revenue at 1, write_docs at 2, write_report at 2 hops",
      `${step}: exit 0`,
    ],
  };
}

/** A launched step in flight, with a few of its own lines. */
export function runningStep(step: DemoStep): DemoActivity {
  return {
    ...idle(),
    running: { step, startedAt: "2026-07-22T09:00:00.000Z" },
    log: [`$ agents/.venv/bin/python -m agents.run ${step}`, `${step}: started`],
  };
}

/**
 * A machine with nothing set up yet, which is what a stranger's first load looks like.
 *
 * `codexSignedOut()` fails exactly one check, so the setup screen it produces is a
 * single line and cannot show whether that line is the first of one problem or the
 * last of four. Three failures is the state worth rendering well: it is the one where
 * a reader needs to know what order to do things in and how much is left.
 */
export function nothingInstalled(): DemoActivity {
  const base = idle();
  return {
    ...base,
    preflight: {
      ...base.preflight,
      // Verbatim from `src/server/runner/preflight.ts`. If these drift, the
      // identifier guard in `cockpit.spec.ts` is checking sentences the server
      // never sends, which is a guard that passes about nothing.
      vocabulary: {
        ok: false,
        detail:
          "The obsel-stale tag is not in DataHub yet. obsel cannot create it while running, so it would find out-of-date work and have nowhere to record it.",
        fix: "agents/.venv/bin/python -m agents.run setup",
      },
      venv: {
        ok: false,
        detail:
          "They are separate from the Node packages, and `pnpm install` does not create them.",
        fix: "python3 -m venv agents/.venv && agents/.venv/bin/python -m pip install -r agents/requirements.txt",
      },
      codex: {
        ok: false,
        detail: "Each demo agent is a real Codex session, so no agent can run until it is.",
        fix: "codex login",
      },
    },
  };
}

/** The machine not ready: Codex signed out. */
export function codexSignedOut(): DemoActivity {
  const base = idle();
  return {
    ...base,
    preflight: {
      ...base.preflight,
      codex: {
        ok: false,
        detail: "Each demo agent is a real Codex session, so no agent can run until it is.",
        fix: "codex login",
      },
    },
  };
}
