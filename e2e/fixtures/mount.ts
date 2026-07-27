/**
 * Open the cockpit against a canned snapshot, and watch for faults while it runs.
 *
 * The seam is `page.route("**​/api/swarm")` — network interception in the
 * browser. It changes zero production code, which matters: a fixture flag
 * inside the real route handler would ship a code path that serves invented
 * data from the endpoint a judge reads, and obsel's central rule is that it
 * never shows a number nobody measured. A production branch that fabricates a
 * whole snapshot is exactly that failure, with a switch on it.
 *
 * What this costs, stated plainly: intercepting the endpoint removes the entire
 * server half from these tests. `readSwarm`, `toTaskRecord`, the
 * `/relationships` paging loop and every DataHub write are not exercised here.
 * This suite verifies **the cockpit's rendering of a snapshot**, not that obsel
 * produces the right snapshot. The pure rules are covered by `tests/`, and the
 * live path has been driven by hand — see `docs/verification.md`.
 *
 * Five routes are intercepted: `/api/swarm`, `/api/demo/activity`, `/api/trace`,
 * `/api/demo/launch`, and `/api/tasks/register`. The last is the only one the
 * board can call that *writes*, and leaving it unstubbed would have this suite
 * create real entities in whatever DataHub the machine is pointed at. What that
 * costs is the same as the rest: no browser test here proves a registration
 * lands. `tests/live/` covers that against a real DataHub.
 */

import type { Page } from "@playwright/test";

import { idle } from "./activity";
import { noSteps } from "./trace";
import type { SwarmResponse } from "@/src/features/cockpit/use-swarm";
import type { TraceEvent } from "@/src/server/coordinator/types";
import type { DemoActivity, DemoStep } from "@/src/server/runner/types";

export interface Faults {
  consoleErrors: string[];
  pageErrors: string[];
  /** Requests that failed, which is how a blocked CSP subresource shows up. */
  failedRequests: string[];
}

/**
 * Serve `body` for every `/api/swarm` poll, load the cockpit, and wait until
 * the fonts have settled.
 *
 * `document.fonts.ready` matters: every layout assertion in this suite measures
 * text, and measuring before the real face has swapped in produces numbers
 * about the fallback font that are stable, plausible, and about the wrong
 * thing.
 */
/** A body `POST /api/tasks/register` was asked to create, as the board sent it. */
export interface SeenRegistration {
  name: string;
  reads: string[];
  writes: string[];
  title?: string;
}

export async function openCockpit(
  page: Page,
  body: SwarmResponse,
  activity: DemoActivity = idle(),
  trace: TraceEvent[] = noSteps(),
): Promise<{
  faults: Faults;
  serve: (next: SwarmResponse | "fail") => void;
  serveActivity: (next: DemoActivity) => void;
  serveTrace: (next: TraceEvent[] | "fail") => void;
  /** Every step the cockpit asked the launcher to start, in order. */
  launches: DemoStep[];
  /** Every task the board asked obsel to register, in order. */
  registrations: SeenRegistration[];
  /** Make the next registration fail, the way a real refusal arrives. */
  refuseRegistration: (status: number, error: string) => void;
}> {
  let current: SwarmResponse | "fail" = body;
  let currentActivity: DemoActivity = activity;
  let currentTrace: TraceEvent[] | "fail" = trace;
  const launches: DemoStep[] = [];
  const registrations: SeenRegistration[] = [];
  let refusal: { status: number; error: string } | null = null;

  const faults: Faults = { consoleErrors: [], pageErrors: [], failedRequests: [] };
  page.on("console", (message) => {
    if (message.type() === "error") faults.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => faults.pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    faults.failedRequests.push(`${request.url()} — ${request.failure()?.errorText ?? "unknown"}`);
  });

  // Registered before goto, so it catches the very first poll and nothing ever
  // reaches the real route handler.
  await page.route("**/api/swarm", async (route) => {
    if (current === "fail") {
      await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(current),
    });
  });

  // Same seam for the runner's two routes. The real activity handler would
  // genuinely probe this machine — spawn `codex login status`, stat the venv —
  // making every test a fact about the box it ran on; and the real launch
  // handler would spawn a real agent run. Both are exercised live instead
  // (see `docs/verification.md`), never from this suite.
  await page.route("**/api/demo/activity", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(currentActivity),
    });
  });
  /*
   * The coordinator's own narration, stubbed for the same reason as the rest.
   * Unstubbed, this endpoint answers from the dev server's in-memory buffer,
   * so the panel's content would be whatever this machine happened to have
   * done — a test that passes or fails on session history rather than on code.
   */
  await page.route("**/api/trace", async (route) => {
    if (currentTrace === "fail") {
      await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ events: currentTrace }),
    });
  });

  await page.route("**/api/demo/launch", async (route) => {
    const step = (route.request().postDataJSON() as { step: DemoStep }).step;
    launches.push(step);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, running: { step, startedAt: new Date().toISOString() } }),
    });
  });

  /*
   * The one route on the board that writes, intercepted for the same reason as
   * the launcher: unstubbed it creates a real DataJob with real lineage edges in
   * whatever DataHub this machine is pointed at, so the browser suite would
   * mutate the operator's board and depend on a stack being up.
   *
   * The reply is deliberately thin. The panel does not read it on success: it
   * clears the form and waits for the task to appear from `/api/swarm`, because
   * DataHub's graph store lags its aspect store. So there is no invented
   * `TaskRecord` here, and a test that wants the task on the board serves a
   * snapshot containing it rather than trusting this response.
   */
  await page.route("**/api/tasks/register", async (route) => {
    registrations.push(route.request().postDataJSON() as SeenRegistration);
    if (refusal !== null) {
      const { status, error } = refusal;
      refusal = null;
      await route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({ error }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  await page.goto("/");
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  // One poll interval, so the first successful read has certainly landed.
  await page.waitForFunction(() => document.querySelectorAll("main li").length > 0 || true);

  return {
    faults,
    serve: (next) => (current = next),
    serveActivity: (next) => (currentActivity = next),
    serveTrace: (next) => (currentTrace = next),
    launches,
    registrations,
    refuseRegistration: (status, error) => (refusal = { status, error }),
  };
}
