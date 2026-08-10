/**
 * The erasure half, on screen.
 *
 * Most of these are about what the board is NOT allowed to say. obsel holds no
 * warehouse credentials and never reads warehouse data, so it cannot prove
 * absence, and the specification forbids a short list of words that would claim
 * it had: "proven clean", "proof", "complete", and a percentage. Those rules are
 * written down in `docs/erasure-coverage.md` and enforced in `coverage-view.ts`;
 * these check that nothing between that module and a reader's eye put them back.
 *
 * The other half is the reverse of the staleness board's rule, and it is the one
 * a later reader is most likely to break: **the default is unattested.** An
 * asset nobody has spoken for must never render as an asset somebody cleared,
 * and an asset the walk never reached must never render as either.
 */

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { finishedStep } from "./fixtures/activity";
import { dayOne, mixed } from "./fixtures/erasure";
import { openDashboard, openTab } from "./fixtures/mount";
import { cascaded } from "./fixtures/swarm";

const tab = (page: Page) => page.locator('[aria-label="Erasure coverage"]');

/** Open the board, serve a report, and go to the tab that reads it. */
async function arrive(page: Page, report: ReturnType<typeof mixed> | "missing" | "fail") {
  const handle = await openDashboard(page, cascaded(), finishedStep());
  handle.serveErasure(report);
  await openTab(page, "erasure");
  return handle;
}

/** Type a request id into the field and read it. */
async function watch(page: Page, request: string) {
  await page.getByLabel("Erasure request to read").fill(request);
  await page.getByRole("button", { name: "read", exact: true }).click();
}

test.describe("erasure coverage on the board", () => {
  test("says there is no request rather than showing an empty report", async ({ page }) => {
    await openDashboard(page, cascaded(), finishedStep());
    await openTab(page, "erasure");

    /*
     * The distinction this protects: nothing to show, versus nothing found. A
     * blank list would read as an estate with no assets in it, which is the most
     * reassuring thing this panel could possibly say and is not an answer at all.
     */
    const body = page.locator('[role="tabpanel"]');
    await expect(body).toContainText("has not been given a request to read");
    await expect(body).toContainText("which of the assets their data reached");
    await expect(tab(page)).toHaveCount(0);

    // The way to open one, as a command rather than a button. The board could
    // offer one now that it holds a pasted token and deliberately does not;
    // `erasure-tab.tsx` records the two reasons.
    await expect(body.locator("code")).toContainText("/api/erasure");
  });

  test("reports an id obsel does not hold, in obsel's own words", async ({ page }) => {
    await arrive(page, "missing");
    await watch(page, "dsr-nope");

    await expect(page.locator('[role="tabpanel"]')).toContainText("no erasure request");
    // Not a coverage list. A request obsel has never seen has no assets, and
    // rendering zero of them would be a report about an estate nobody walked.
    await expect(tab(page)).toHaveCount(0);
  });

  test("withholds the report when the ledger cannot be read", async ({ page }) => {
    await arrive(page, "fail");
    await watch(page, "dsr-2f9c");

    const body = page.locator('[role="tabpanel"]');
    await expect(body).toContainText("could not read this request");
    // The same rule the board's numbers keep: a held-over answer beside a broken
    // read is exactly the false all-clear obsel exists to prevent.
    await expect(tab(page)).toHaveCount(0);
  });

  test("leads with what is covered and what is not, and never with a percentage", async ({
    page,
  }) => {
    await arrive(page, mixed());
    await watch(page, "dsr-2f9c");

    const body = page.locator('[role="tabpanel"]');
    await expect(body).toContainText(
      "2 of 6 assets covered, 3 unattested, 1 reported still present",
    );
    await expect(body).not.toContainText("%");
    // The reach, because coverage stops where the walk did and "2 of 6" alone
    // cannot tell a covered estate from a small one.
    await expect(body).toContainText("Walked 3 hops downstream, reached 6 assets");
  });

  test("names a state for every asset, in the report's own sentences", async ({ page }) => {
    await arrive(page, mixed());
    await watch(page, "dsr-2f9c");

    await expect(tab(page).locator("li[data-state]")).toHaveCount(6);
    // The kernel's explanation verbatim, not a summary of it. Same discipline a
    // stale mark's reason is held to: a summary is where a claim grows.
    await expect(tab(page)).toContainText(
      "raw orders is attested absent over version v7 by warehouse-team",
    );
    await expect(tab(page)).toContainText(
      "archive-team reports the subject is still present in order archive",
    );
    // And every remaining reason, not only the one the explanation leads with.
    // The sentence for daily revenue ends "and 1 more"; this is that one.
    await expect(tab(page)).toContainText("more than one run contributed to this version");
  });

  test("reports a dropped key, which nothing else on the board would catch", async ({ page }) => {
    await arrive(page, mixed());
    await watch(page, "dsr-2f9c");

    /*
     * Key compromise is the only way coverage is lost without anybody touching
     * data. Every other check on this board is triggered by a write, so a report
     * that stayed silent here would keep showing coverage backed by signatures
     * nobody should trust.
     */
    const body = page.locator('[role="tabpanel"]');
    await expect(body).toContainText("because the key that signed");
    await expect(body).toContainText("docs-bot");
    await expect(body).toContainText("key compromised");
  });

  test("a day-one request is a list of assets nobody has spoken for", async ({ page }) => {
    await arrive(page, dayOne());
    await watch(page, "dsr-2f9c");

    const body = page.locator('[role="tabpanel"]');
    await expect(body).toContainText("0 of 3 assets covered, 3 unattested");
    const states = await tab(page).evaluate((node) =>
      [...node.querySelectorAll("li[data-state]")].map((li) => li.getAttribute("data-state")),
    );
    // The default is unattested, and on day one that is every asset. A default
    // of covered would turn missing information into a certificate of erasure,
    // which is the inversion the kernel's own header warns about.
    expect(states).toEqual(["UNPROVEN", "UNPROVEN", "UNPROVEN"]);
  });

  test("never uses a word that would claim more than obsel can support", async ({ page }) => {
    await arrive(page, mixed());
    await watch(page, "dsr-2f9c");
    await expect(tab(page).locator("li[data-state]").first()).toBeVisible();

    const said = (await page.evaluate(() => document.body.innerText)).toLowerCase();
    for (const banned of ["proven clean", "proof", "complete", "certified", "guaranteed"]) {
      expect(said, `"${banned}" must not reach the board`).not.toContain(banned);
    }
    // The enum spellings are internal identifiers and belong in the DOM's data
    // attributes, never in a sentence.
    const visible = await page.evaluate(() => document.body.innerText);
    for (const spelling of ["ATTESTED", "UNPROVEN", "CONTRADICTED"]) {
      expect(visible, `${spelling} is an internal name`).not.toContain(spelling);
    }
  });

  test("offers no way to mark an asset covered", async ({ page }) => {
    await arrive(page, mixed());
    await watch(page, "dsr-2f9c");
    await expect(tab(page).locator("li[data-state]").first()).toBeVisible();

    /*
     * There is no route that would accept one, and there must be no control that
     * suggests there is. A tool for declaring the work done is a tool for
     * silencing the one thing this half of the product is for, and a button is
     * the likeliest form a future convenience change would take.
     */
    const controls = await page.evaluate(() =>
      [...document.querySelectorAll('[role="tabpanel"] button')].map((node) =>
        (node.textContent ?? "").trim().toLowerCase(),
      ),
    );
    for (const label of controls) {
      for (const word of ["cover", "clear", "approve", "accept", "resolve", "dismiss", "done"]) {
        expect(label, `"${label}" reads as a way to close a gap`).not.toContain(word);
      }
    }
  });
});

test.describe("the graph read as an erasure report", () => {
  /** Turn the canvas over to coverage, once a report has been read. */
  async function colorTheGraph(page: Page) {
    await watch(page, "dsr-2f9c");
    await expect(page.locator("li[data-state]").first()).toBeVisible();
    await page.getByRole("checkbox", { name: /color the graph/i }).check();
    await page.waitForTimeout(400);
  }

  test("cannot be switched on before a report has been read", async ({ page }) => {
    await openDashboard(page, cascaded(), finishedStep());
    await openTab(page, "erasure");

    const toggle = page.getByRole("checkbox", { name: /color the graph/i });
    await expect(toggle).toBeDisabled();
    // Disabled with the reason on screen, rather than hidden. A control that
    // vanishes when it cannot be used teaches a reader nothing.
    await expect(page.locator('[role="tabpanel"]')).toContainText(
      "needs a report to be read first",
    );
  });

  test("colors the tables by coverage, and never in the stale amber", async ({ page }) => {
    await arrive(page, mixed());
    await colorTheGraph(page);

    const states = await page.evaluate(() =>
      [...document.querySelectorAll("[data-coverage]")].map((node) => ({
        state: node.getAttribute("data-coverage"),
        bar: getComputedStyle(node).borderLeftColor,
      })),
    );
    expect(states.length, "every table reports a coverage state").toBeGreaterThan(0);

    /*
     * Amber means one thing on this board: finished work went out of date. An
     * erasure gap is not that, nothing is out of date, and the two boards appear
     * minutes apart during a demonstration. This is the color reservation, held
     * across the whole canvas rather than only in the module that maps it.
     */
    const amber = ["rgb(255, 176, 32)", "rgb(255, 211, 166)"];
    const painted = await page.evaluate(() =>
      [...document.querySelectorAll(".react-flow__node, .react-flow__node *")].map((node) => {
        const style = getComputedStyle(node);
        return [style.color, style.borderLeftColor, style.borderTopColor, style.backgroundColor];
      }),
    );
    for (const colors of painted) {
      for (const color of colors) {
        expect(amber, "no amber anywhere on the erasure board").not.toContain(color);
      }
    }
  });

  test("a table the walk never reached says so, rather than showing nothing", async ({ page }) => {
    await arrive(page, mixed());
    await colorTheGraph(page);

    /*
     * The demo board draws five tables and this report names six assets, only
     * some of which are on it. Whatever the overlap, a table absent from the
     * report must render as "not reached" rather than as an uncolored box: an
     * absent claim and a clean one look identical, and only one of them is true.
     */
    const unreached = await page.evaluate(() =>
      [...document.querySelectorAll('[data-coverage="not-reached"]')].map(
        (node) => node.textContent ?? "",
      ),
    );
    for (const text of unreached) {
      expect(text, "an unreached table must say so").toContain("not reached");
    }
  });

  /*
   * The details panel on the coverage board.
   *
   * A reader who colors the board by coverage and then opens a table was told
   * nothing about the question they were asking: the panel reported writers,
   * readers and shape, all of which are staleness vocabulary, and said nothing
   * about erasure. The field is gated on the board actually being colored, so
   * a report read for the panel's tab does not put an erasure verdict on a table
   * a reader is inspecting for a completely different reason.
   */
  test("a table opened on the coverage board reports its coverage state", async ({ page }) => {
    await arrive(page, mixed());
    await colorTheGraph(page);

    await page.locator(".react-flow__node-data").first().click();
    const panel = page.locator('[aria-label="Details"]');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("erasure report says");
  });

  test("a table opened on the staleness board says nothing about erasure", async ({ page }) => {
    await arrive(page, mixed());
    // The report is read for the tab, and the graph is deliberately NOT
    // colored by it: `colorTheGraph` is the step this test leaves out.
    await watch(page, "dsr-2f9c");
    await expect(page.locator("li[data-state]").first()).toBeVisible();

    await page.locator(".react-flow__node-data").first().click();
    const panel = page.locator('[aria-label="Details"]');
    await expect(panel).toBeVisible();
    await expect(panel).not.toContainText("erasure report says");
  });

  test("puts the staleness board back when it is switched off", async ({ page }) => {
    await arrive(page, mixed());
    await colorTheGraph(page);
    expect(await page.locator("[data-coverage]").count()).toBeGreaterThan(0);

    await page.getByRole("checkbox", { name: /color the graph/i }).uncheck();
    await page.waitForTimeout(600);

    await expect(page.locator("[data-coverage]")).toHaveCount(0);
    // The cascade is back, with the amber it always had.
    await expect(page.locator('[data-origin="true"]')).toHaveCount(1);
    await expect(page.locator(".react-flow__edge.animated")).not.toHaveCount(0);
  });
});
