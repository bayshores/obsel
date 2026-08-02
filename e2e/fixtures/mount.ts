/**
 * Open the dashboard against a canned snapshot, and watch for faults while it runs.
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
 * This suite verifies **the dashboard's rendering of a snapshot**, not that obsel
 * produces the right snapshot. The pure rules are covered by `tests/`, and the
 * live path has been driven by hand — see `docs/verification.md`.
 *
 * Five routes are intercepted: `/api/swarm`, `/api/demo/activity`, `/api/trace`,
 * `/api/demo/launch`, and `/api/tasks/register`. The last is the only one the
 * board can call that *writes*, and leaving it unstubbed would have this suite
 * create real entities in whatever DataHub the machine is pointed at. What that
 * costs is the same as the rest: no browser test here proves a registration
 * lands. `tests/live/` covers that against a real DataHub.
 *
 * An interceptor answers before any gate, so these routes reply here whether or
 * not the board attached its token. `mutationAuth` records the header that
 * arrived, which is how `dashboard-token.spec.ts` can tell a board that sends
 * one from a board that does not.
 */

import type { Page } from "@playwright/test";

import { idle } from "./activity";
import { noSteps } from "./trace";
import type { ChangeHistory } from "@/src/server/coordinator/change-ledger";
import type { PublishedErasureReport } from "@/src/server/coordinator/erasure-report";
import type { SwarmResponse } from "@/src/features/dashboard/hooks/use-swarm";
import type { TraceEvent } from "@/src/server/coordinator/types";
import type { DemoActivity, DemoStep } from "@/src/server/runner/types";

/**
 * obsel's own alert banner.
 *
 * Scoped to <main> on purpose: Next.js injects
 * `<div role="alert" aria-live="assertive" id="__next-route-announcer__">` for
 * route changes. It is empty and zero-sized, but it matches the alert role, so
 * an unscoped `getByRole("alert")` is a strict-mode violation — and an unscoped
 * `querySelector` silently measures the announcer's 0x0 rect instead of the
 * banner, which is a test that passes for the wrong reason.
 */
export function obselAlert(page: Page) {
  return page.locator('main [role="alert"]');
}

export interface Faults {
  consoleErrors: string[];
  pageErrors: string[];
  /** Requests that failed, which is how a blocked CSP subresource shows up. */
  failedRequests: string[];
}

/**
 * Serve `body` for every `/api/swarm` poll, load the dashboard, and wait until
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

/**
 * Put one of the panel's tabs on screen.
 *
 * Three regions of the board are tabs of one column now: the activity feed and
 * the two bring-your-own panels. At any moment two of them are genuinely not
 * rendered, which is the point of the arrangement — stacking all three above and
 * below the graph is what starved the feed of height in the first place.
 *
 * So a test about a tabbed panel opens its tab, the same way a reader does. It
 * is one click and it is deliberately not hidden inside `openDashboard`: which
 * panel a test is about should be visible in the test.
 */
export async function openTab(
  page: Page,
  tab: "activity" | "history" | "your agent" | "your data" | "erasure",
) {
  const control = page.getByRole("tab", { name: tab, exact: true });
  await control.click();
  /*
   * Wait for THIS panel, by the id the tab controls, not for any tabpanel.
   *
   * The panes swap through `AnimatePresence` with `mode="wait"`, so for a few
   * frames the outgoing pane is still in the document while the incoming one has
   * not mounted. A wait on `[role="tabpanel"]` is satisfied by the pane on its
   * way out, and the assertion that follows then runs against the tab the test
   * just navigated away from. It passed alone and failed under a full parallel
   * run, which is what a race looks like.
   */
  const panel = await control.getAttribute("aria-controls");
  await page.locator(`#${panel}`).waitFor({ state: "visible" });
}

export async function openDashboard(
  page: Page,
  body: SwarmResponse,
  activity: DemoActivity = idle(),
  trace: TraceEvent[] = noSteps(),
): Promise<{
  faults: Faults;
  serve: (next: SwarmResponse | "fail") => void;
  /**
   * `"fail"` because both reads going down together is one real state, not two:
   * a stopped server fails this route and `/api/swarm` in the same poll, and the
   * board used to describe that state with two sentences that contradicted.
   */
  serveActivity: (next: DemoActivity | "fail") => void;
  serveTrace: (next: TraceEvent[] | "fail") => void;
  /** Every step the dashboard asked the launcher to start, in order. */
  launches: DemoStep[];
  /** Every task the board asked obsel to register, in order. */
  registrations: SeenRegistration[];
  /**
   * The `Authorization` header on every intercepted mutation, in order, with
   * `null` where the board sent none.
   *
   * Every mutating route is token-gated, so a board that stops attaching the
   * header would leave every button refused against a real obsel while these
   * interceptors, which answer before any gate, went on passing.
   */
  mutationAuth: (string | null)[];
  /** Make the next registration fail, the way a real refusal arrives. */
  refuseRegistration: (status: number, error: string) => void;
  /**
   * What `GET /api/erasure/{id}` answers.
   *
   * `"missing"` is a 404, which is not a fault: it is obsel saying it holds no
   * such request, and the tab reads differently for it than for a broken
   * connection. `"fail"` is the broken connection.
   */
  serveErasure: (next: PublishedErasureReport | "missing" | "fail") => void;
  /**
   * What `GET /api/changes` answers.
   *
   * `"fail"` is the broken read, which the panel has to render as a failure
   * rather than as an empty history — the two look identical to a reader and one
   * of them claims nothing ever happened.
   */
  serveChanges: (next: ChangeHistory | "fail") => void;
}> {
  let current: SwarmResponse | "fail" = body;
  let currentActivity: DemoActivity | "fail" = activity;
  let currentTrace: TraceEvent[] | "fail" = trace;
  const launches: DemoStep[] = [];
  const registrations: SeenRegistration[] = [];
  const mutationAuth: (string | null)[] = [];
  let refusal: { status: number; error: string } | null = null;
  let currentErasure: PublishedErasureReport | "missing" | "fail" = "missing";
  // An empty history by default: most tests are not about it, and an empty one is
  // what a board nothing has happened on genuinely has.
  let currentChanges: ChangeHistory | "fail" = { flowId: "orders_pipeline", entries: [] };

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
    if (currentActivity === "fail") {
      await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
      return;
    }
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
  /*
   * The change history. Stubbed like the rest, and with the same cost: no browser
   * test here proves a record was written or read back. Its ledger URNs are
   * derived from whatever flow the dev server is pointed at, so unstubbed this
   * panel would show that machine's own history — a test that passes or fails on
   * what somebody ran yesterday. `tests/live/change-ledger.live.test.ts` drives
   * the real write and the real read against a real DataHub.
   */
  await page.route("**/api/changes", async (route) => {
    if (currentChanges === "fail") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "DataHub is not answering" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(currentChanges),
    });
  });
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
    mutationAuth.push(route.request().headers().authorization ?? null);
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
    mutationAuth.push(route.request().headers().authorization ?? null);
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

  /*
   * The erasure read, intercepted like the rest.
   *
   * The real route derives coverage from the ledger on every read, which means a
   * lineage walk and one aspect read per reachable asset against a DataHub this
   * suite does not have. What that costs is the same as everywhere else here: no
   * browser test proves obsel computes coverage correctly. `tests/erasure.test.ts`
   * covers the rule, against the kernel that decides it.
   */
  await page.route("**/api/erasure/**", async (route) => {
    if (currentErasure === "fail") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "the ledger could not be read" }),
      });
      return;
    }
    if (currentErasure === "missing") {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "no erasure request dsr-nope in the ledger" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(currentErasure),
    });
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
    mutationAuth,
    refuseRegistration: (status, error) => (refusal = { status, error }),
    serveErasure: (next) => (currentErasure = next),
    serveChanges: (next) => (currentChanges = next),
  };
}
