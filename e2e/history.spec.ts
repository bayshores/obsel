/**
 * The history panel: what obsel has decided here, after the fact.
 *
 * The states worth painting are the ones a live board cannot be driven into on
 * demand — a read that broke, a record this build cannot parse — plus the two that
 * matter most and take minutes of real agent time to reach: a cascade recorded,
 * and the clearance recorded beside it.
 *
 * The bodies come from `e2e/fixtures/changes.ts`, whose header says they are
 * invented rather than recorded. What the real write and the real read-back are
 * proven by is `tests/live/change-ledger.live.test.ts`, against a real DataHub.
 */

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  cascadeRecorded,
  noChanges,
  repairRecorded,
  unreadableRecorded,
  unreportedRecorded,
} from "./fixtures/changes";
import { openDashboard, openTab } from "./fixtures/mount";
import { calm, cascaded } from "./fixtures/swarm";
import { idle } from "./fixtures/activity";

/** The history panel itself, by the label it carries for a screen reader. */
const panel = (page: Page) => page.locator('[aria-label="What obsel has decided"]');

test.describe("what obsel has decided", () => {
  test("an empty history says what will fill it, and what deliberately will not", async ({
    page,
  }) => {
    const { serveChanges } = await openDashboard(page, calm(), idle());
    serveChanges(noChanges());
    await openTab(page, "history");

    // States the rule rather than apologising: a reader has to know both that it
    // will fill, and that a quiet re-run is not a missing record.
    await expect(panel(page).getByText(/Nothing recorded yet/)).toBeVisible();
    await expect(
      panel(page).getByText(/re-run that changes nothing records nothing/),
    ).toBeVisible();
  });

  test("a recorded cascade names the cause, the columns and every task it flagged", async ({
    page,
  }) => {
    const { serveChanges } = await openDashboard(page, cascaded(), idle());
    serveChanges(cascadeRecorded());
    await openTab(page, "history");

    // Counted in the headline, named in the lines below it, never both.
    await expect(panel(page).getByText("3 tasks went out of date")).toBeVisible();
    await expect(panel(page).getByText(/clean orders: columns changed/)).toBeVisible();
    await expect(
      panel(page).getByText("left: order_total · arrived: order_total_usd"),
    ).toBeVisible();
    await expect(panel(page).getByText(/build_revenue \(1 hop\)/)).toBeVisible();
    await expect(panel(page).getByText(/write_docs \(2 hops\)/)).toBeVisible();
    // A measured figure, labelled as one.
    await expect(panel(page).getByText("decided in 5399 ms")).toBeVisible();
  });

  test("the repair is a record beside the marking, not instead of it", async ({ page }) => {
    /*
     * The whole reason this panel exists. On the board itself a repaired page is
     * indistinguishable from a page nothing happened to: the flags are gone,
     * which is correct and is the entire problem. Here both records stand, newest
     * first.
     */
    const { serveChanges } = await openDashboard(page, calm(), idle());
    serveChanges(repairRecorded());
    await openTab(page, "history");

    await expect(panel(page).getByText("2 flags came off")).toBeVisible();
    await expect(panel(page).getByText("3 tasks went out of date")).toBeVisible();

    const rows = panel(page).locator("ol li");
    await expect(rows).toHaveCount(2);
    // Newest first, the opposite of the activity feed beside it: a reader arriving
    // at a history came for the last thing that happened.
    await expect(rows.first()).toContainText("flags came off");
    await expect(rows.last()).toContainText("went out of date");
  });

  test("a change nobody reported credits the observation, never the producer", async ({ page }) => {
    const { serveChanges } = await openDashboard(page, cascaded(), idle());
    serveChanges(unreportedRecorded());
    await openTab(page, "history");

    await expect(panel(page).getByText(/nothing reported/)).toBeVisible();
    await expect(panel(page).getByText(/an outside observation/)).toBeVisible();
    // The producer is not blamed for bytes it never reported writing.
    await expect(panel(page).getByText(/reported by clean_orders/)).toBeHidden();
  });

  test("a record it cannot read stays on screen and says so", async ({ page }) => {
    // Dropping it would make the history claim fewer decisions happened than
    // obsel recorded, and a gap reads as "nothing happened here".
    const { serveChanges } = await openDashboard(page, calm(), idle());
    serveChanges(unreadableRecorded());
    await openTab(page, "history");

    await expect(panel(page).locator("ol li")).toHaveCount(2);
    await expect(panel(page).getByText(/cannot read/)).toBeVisible();
  });

  test("a failed read is a failure, never an empty history", async ({ page }) => {
    /*
     * The honesty rule this board keeps everywhere. An empty history and a read
     * that broke look identical to a reader, and one of them is a claim that
     * nothing ever happened here.
     */
    const { serveChanges } = await openDashboard(page, calm(), idle());
    serveChanges("fail");
    await openTab(page, "history");

    await expect(panel(page).getByText(/history could not be read/)).toBeVisible();
    await expect(panel(page).getByText(/Nothing recorded yet/)).toBeHidden();
    // And it does not speak for the board, which is a separate read that worked.
    await expect(panel(page).getByText(/board beside it is still current/)).toBeVisible();
  });

  test("the tab is its own, beside the activity feed rather than inside it", async ({ page }) => {
    const { serveChanges } = await openDashboard(page, calm(), idle());
    serveChanges(cascadeRecorded());

    const tabs = await page.evaluate(() =>
      [...document.querySelectorAll('[role="tab"]')].map((node) => node.textContent?.trim() ?? ""),
    );
    // Adjacent to the feed, because that is the panel it most needs
    // distinguishing from, and after it, because one is the present tense.
    expect(tabs.indexOf("history")).toBe(tabs.indexOf("activity") + 1);

    // Two panels showing overlapping facts is the thing to avoid, so only one is
    // ever mounted.
    await openTab(page, "history");
    await expect(page.getByText("what obsel is doing")).toBeHidden();
    await expect(page.getByText("what obsel has decided")).toBeVisible();
  });

  test("five labels fit the strip, and read as five words", async ({ page }) => {
    /*
     * The regression the fifth tab caused, measured rather than eyeballed.
     *
     * At zero gap the four existing labels had room to read as four words. The
     * fifth removed it: the strip needed 346px of a 339px track and rendered
     * "activityhistoryyour agentyour dataerasure" as one string with the last
     * label flush against the edge. The type floor is 13px and not negotiable —
     * `panel.module.css` records why — so horizontal padding paid for the fifth
     * label, and a gap now keeps the words apart at any width.
     */
    await openDashboard(page, calm(), idle());

    const strip = await page.evaluate(() => {
      const node = document.querySelector('[role="tablist"]');
      if (node === null) return null;
      const tabs = [...node.querySelectorAll('[role="tab"]')];
      return {
        overflowing: node.scrollWidth > node.clientWidth,
        gaps: tabs
          .slice(1)
          .map((tab, index) =>
            Math.round(
              tab.getBoundingClientRect().left - tabs[index].getBoundingClientRect().right,
            ),
          ),
      };
    });

    // At the panel's default width, all five fit without scrolling sideways.
    expect(strip?.overflowing).toBe(false);
    // And no two labels ever touch, whatever the width.
    for (const gap of strip?.gaps ?? []) expect(gap).toBeGreaterThan(0);
  });

  test("and still fit when the panel is dragged to its narrowest", async ({ page }) => {
    /*
     * The width the test above does not reach.
     *
     * `MIN_WIDTH` was 340 against a strip needing 346, so at the minimum
     * "erasure" went under the panel's edge — and `.tabs` hides its scrollbar,
     * so the tab that opens the erasure half was gone with nothing saying it
     * was reachable. The floor is 360 now. This asserts the property at the one
     * width where it can fail, because the default has 70px of slack and would
     * keep passing through any regression that mattered.
     */
    await page.addInitScript(() => {
      // Below the floor on purpose: `clampWidth` is what has to pull it back up.
      window.localStorage.setItem(
        "obsel.panel.v1",
        JSON.stringify({ side: "right", width: 1, collapsed: false }),
      );
    });
    await openDashboard(page, calm(), idle());

    const strip = await page.evaluate(() => {
      const node = document.querySelector('[role="tablist"]');
      if (node === null) return null;
      return { width: node.clientWidth, overflowing: node.scrollWidth > node.clientWidth };
    });

    expect(strip?.overflowing).toBe(false);
    // The clamp actually took effect, so the assertion above is about the
    // narrowest panel rather than about a width the store happened to keep.
    expect(strip?.width).toBeLessThan(400);
  });
});
