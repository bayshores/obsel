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

import type { DemoActivity, DemoStep, PreflightCheck } from "@/src/server/runner/types";

function ok(detail: string): PreflightCheck {
  return { ok: true, detail, fix: null };
}

/** Machine ready, nothing running, nothing run yet — the default backdrop. */
export function idle(): DemoActivity {
  return {
    running: null,
    lastResult: null,
    log: [],
    preflight: {
      datahub: ok("DataHub answered at http://localhost:8080"),
      vocabulary: ok("urn:li:tag:obsel-stale is registered"),
      venv: ok("agents/.venv exists"),
      codex: ok("the Codex CLI is signed in"),
    },
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
  return {
    ...idle(),
    lastResult: {
      step,
      exitCode: 0,
      signal: null,
      startedAt: "2026-07-22T09:00:00.000Z",
      finishedAt: "2026-07-22T09:01:11.400Z",
      durationMs: 71_400,
    },
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

/** The machine not ready: Codex signed out. */
export function codexSignedOut(): DemoActivity {
  const base = idle();
  return {
    ...base,
    preflight: {
      ...base.preflight,
      codex: { ok: false, detail: "the Codex CLI is not signed in", fix: "codex login" },
    },
  };
}
