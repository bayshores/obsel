import { defineConfig } from "@playwright/test";

const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * Browser checks for the page, deliberately separate from `pnpm verify`.
 *
 * `pnpm verify` is what the README asks a judge to run, so it must stay fast
 * and need no Docker, no DataHub and no browser download. This suite is the
 * other half: the things only a real browser can establish — that the font
 * actually resolved, that no text escapes its box in pixels, that the WebGL
 * backdrop really painted, that a failed read withholds every number.
 *
 * Run with `pnpm e2e`.
 */
export default defineConfig({
  // Vitest owns tests/**. Without this, Playwright's default testMatch would
  // also collect tests/staleness.test.ts and fail on the wrong runner's globals.
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // Deliberately zero. Every assertion here is deterministic against a fixed
  // fixture; a test that only passes on the second try is a flake this suite
  // exists to surface, not one to paper over.
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    browserName: "chromium",
    // clockTime() calls toLocaleTimeString. Unpinned, the same fixture renders
    // 14:05:52 in UTC and 09:05:52 in New York, and every clock assertion
    // becomes a fact about the machine rather than about the page.
    timezoneId: "UTC",
    locale: "en-US",
    // The ADVANCE table in graph/layout.ts is in CSS px and the backdrop's
    // pixel counts are over the canvas backing store. Pin both to 1:1.
    deviceScaleFactor: 1,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    // A full-frame browser on a 1080p display, which is what
    // the recording needs now that the demo is
    // driven from the guide panel rather than a terminal beside the window.
    // 990 ≈ 1080 minus the browser chrome.
    { name: "recording-1920x990", use: { viewport: { width: 1920, height: 990 } } },
    // A laptop. The page may scroll vertically here — the fit test asserts
    // what must stay above the fold instead.
    { name: "laptop-1280x800", use: { viewport: { width: 1280, height: 800 } } },
  ],

  webServer: {
    // Never `next dev`: next.config.ts adds 'unsafe-eval' to script-src outside
    // production, so a CSP assertion under dev would test a policy no judge
    // will ever run.
    command: `pnpm build && pnpm start --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      // Point the server at a closed port. Every test intercepts /api/swarm in
      // the browser, so nothing should reach GMS — and if an interception is
      // ever missed, the read fails in milliseconds on every machine instead of
      // silently succeeding on a developer's box that happens to have DataHub
      // running and turning the suite into a fact about that machine.
      DATAHUB_GMS_URL: "http://127.0.0.1:9",
    },
  },
});
