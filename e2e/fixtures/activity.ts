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
