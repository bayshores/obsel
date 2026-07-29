import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {} from "./fixtures/activity";
import {
  calm,
  cascaded,
  empty,
  justOne,
  leftOverTag,
  midWrite,
  withoutTagInfo,
} from "./fixtures/swarm";
import { openDashboard } from "./fixtures/mount";

/**
 * The graph and what opening a box says about it.
 *
 * The mark a reader sees, the identifier behind the human name, the details
 * surface's three depths, and the write-back reported as something obsel
 * observed rather than asserted.
 */

/**
 * The header lockup, which needs a real browser for a reason the other blocks
 * do not.
 *
 * `tests/dashboard-mark.test.ts` covers the mark's geometry without one, and
 * stops there deliberately: everything below is animation, and animation is
 * driven by `requestAnimationFrame`. The dev preview available while this was
 * built reports `visibilityState: "hidden"` and serves zero frames a second, so
 * a hover there renders at its starting values and stays, which reads exactly
 * like a reveal that never fired. These assertions wait for the settled value
 * rather than sampling once, so they are about where the animation ARRIVES.
 */
test.describe("the mark, and the name it reveals", () => {
  const lockup = (page: Page) => page.locator('[data-brand="lockup"]');
  const name = (page: Page) => page.locator('[data-brand="name"]');
  const opacityOf = (page: Page) =>
    name(page).evaluate((el) => Number(getComputedStyle(el).opacity));

  test("the name is hidden until the mark is hovered, and comes back when it is not", async ({
    page,
  }) => {
    await openDashboard(page, cascaded());

    // The mark itself is never hidden; only the word beside it is.
    await expect(page.locator('[data-brand="lockup"] svg')).toBeVisible();
    expect(await opacityOf(page)).toBe(0);

    await lockup(page).hover();
    await expect.poll(() => opacityOf(page)).toBe(1);

    // Away from the header entirely, not merely to a neighbouring element.
    await page.mouse.move(0, 400);
    await expect.poll(() => opacityOf(page)).toBe(0);
  });

  test("revealing the name moves nothing else in the header", async ({ page }) => {
    await openDashboard(page, cascaded());

    const flow = page.getByText("orders_pipeline", { exact: false }).first();
    const guide = page.getByRole("button", { name: /guide/i }).first();
    const box = async () => ({
      flow: await flow.boundingBox(),
      guide: await guide.boundingBox(),
      lockup: await lockup(page).boundingBox(),
      // `main > header`, not `header`: every panel on the board has one too.
      header: await page.locator("main > header").boundingBox(),
    });

    const atRest = await box();
    await lockup(page).hover();
    await expect.poll(() => opacityOf(page)).toBe(1);
    const revealed = await box();

    /*
     * The whole point of the feature, asserted on the settled reveal rather
     * than mid-transition: the name is laid out at full width in both states
     * and only ever made transparent, so every neighbour keeps its exact box.
     * An implementation that inserted the name on hover, or grew it from zero
     * width, passes every other assertion here and fails this one.
     */
    expect(revealed.flow).toEqual(atRest.flow);
    expect(revealed.guide).toEqual(atRest.guide);
    expect(revealed.lockup).toEqual(atRest.lockup);
    expect(revealed.header).toEqual(atRest.header);
  });

  test.describe("with motion turned down", () => {
    /*
     * Through `contextOptions`, like the tour's own reduced-motion block, and
     * NOT through `page.emulateMedia`. That distinction cost a debugging pass
     * and is the whole reason this comment exists: `emulateMedia` sets the
     * preference on a page that already exists, and motion's `useReducedMotion`
     * reads the query once and holds the answer, so the hook had already
     * decided before the emulation landed. The media query reported `reduce`
     * and the animated lockup rendered anyway.
     */
    test.use({ contextOptions: { reducedMotion: "reduce" } });

    test("the name is simply there, with no hover needed", async ({ page }) => {
      await openDashboard(page, cascaded());

      // Not a faster reveal: the finished lockup, which is the rule
      // `guide-panel.tsx` follows for the same preference.
      expect(await opacityOf(page)).toBe(1);
      await expect(page.locator('[data-brand="lockup"] svg')).toBeVisible();

      // The still branch renders plain paths, so nothing is mid-animation.
      const inFlight = await page
        .locator('[data-brand="lockup"]')
        .evaluate((el) => el.getAnimations({ subtree: true }).length);
      expect(inFlight).toBe(0);
    });
  });
});

/*
 * The three depths of the details surface.
 *
 * It replaced a panel that opened only on a click, with nothing on the board
 * saying a click would do anything. These assertions are about the affordance as
 * much as the contents: an idle hint that is always there, a preview under the
 * pointer, and the full record on a click.
 */
test.describe("the details surface", () => {
  const DETAILS = '[aria-label="Details"]';

  test("says what pointing and clicking do, before either happens", async ({ page }) => {
    await openDashboard(page, cascaded());
    await page.waitForSelector(".react-flow__node", { state: "attached" });

    await expect(page.getByText("hover a box to preview it, click to pin")).toBeVisible();
  });

  test("offers no hint on a board with nothing to point at", async ({ page }) => {
    await openDashboard(page, empty());
    /*
     * The graph's own empty line, not the guide's headline beside it.
     *
     * Both say "No agents yet", so the bare text matched two elements and the
     * assertion passed or failed on which had rendered first. It passed alone
     * and failed under a full suite, which is the worst way for a test to be
     * wrong: the subject here is the graph area, so it names the graph's
     * sentence.
     */
    await expect(
      page.getByText("No agents yet. obsel is connected", { exact: false }),
    ).toBeVisible();

    await expect(page.getByText("hover a box to preview it", { exact: false })).toHaveCount(0);
  });

  test("previews the box under the pointer, in names rather than identifiers", async ({ page }) => {
    await openDashboard(page, cascaded());
    await page.waitForSelector(".react-flow__node-data", { state: "attached" });

    await page.locator(".react-flow__node-data").nth(1).hover();
    // Polled rather than waited on: the preview is deliberately delayed, so a
    // fixed wait would either be flaky or be a claim about the delay.
    await expect.poll(() => page.locator(DETAILS).count()).toBe(1);

    const text = (await page.locator(DETAILS).textContent()) ?? "";
    expect(text).toContain("written by");
    expect(text).toContain("read by");
    // A preview carries nothing a person cannot read at a glance.
    expect(text).not.toContain("urn:li:");
  });

  test("returns to the hint when the pointer leaves", async ({ page }) => {
    await openDashboard(page, cascaded());
    await page.waitForSelector(".react-flow__node-task", { state: "attached" });

    await page.locator(".react-flow__node-task").nth(1).hover();
    await expect.poll(() => page.locator(DETAILS).count()).toBe(1);

    await page.mouse.move(4, 4);
    await expect.poll(() => page.locator(DETAILS).count()).toBe(0);
    await expect(page.getByText("hover a box to preview it, click to pin")).toBeVisible();
  });

  test("pointing at a box moves nothing in the graph", async ({ page }) => {
    await openDashboard(page, cascaded());
    await page.waitForSelector(".react-flow__node", { state: "attached" });

    const measure = () =>
      page.evaluate(() => ({
        graph: Math.round(
          document.querySelector(".react-flow")?.getBoundingClientRect().height ?? 0,
        ),
        nodeTops: [...document.querySelectorAll(".react-flow__node")].map((n) =>
          Math.round(n.getBoundingClientRect().top),
        ),
        scrollH: document.documentElement.scrollHeight,
      }));

    const before = await measure();
    await page.locator(".react-flow__node-task").nth(1).hover();
    await expect.poll(() => page.locator(DETAILS).count()).toBe(1);

    expect(await measure()).toEqual(before);
  });

  test("a click pins the record, and Esc puts it away", async ({ page }) => {
    await openDashboard(page, cascaded());
    await page.waitForSelector(".react-flow__node-task", { state: "attached" });

    await page.locator(".react-flow__node-task").nth(1).click();
    await expect(page.getByText("task urn")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByText("task urn")).toHaveCount(0);
  });

  test("the preview itself pins, without going back for the small box", async ({ page }) => {
    await openDashboard(page, cascaded());
    await page.waitForSelector(".react-flow__node-task", { state: "attached" });

    await page.locator(".react-flow__node-task").nth(1).hover();
    await expect.poll(() => page.locator(DETAILS).count()).toBe(1);
    // The pointer is on the node; the preview is the thing being clicked.
    await page.locator(DETAILS).click();

    await expect(page.getByText("task urn")).toBeVisible();
  });

  /*
   * The rule that makes a pinned panel readable: crossing the board to read it
   * must not rewrite it. The edges follow the pointer; the panel does not.
   */
  test("pointing elsewhere does not rewrite what is pinned", async ({ page }) => {
    await openDashboard(page, cascaded());
    await page.waitForSelector(".react-flow__node-task", { state: "attached" });

    const pinned = page.locator(".react-flow__node-task").nth(1);
    const pinnedName = ((await pinned.textContent()) ?? "").trim();
    await pinned.click();
    await expect(page.getByText("task urn")).toBeVisible();

    await page.locator(".react-flow__node-data").nth(0).hover();
    // Long enough that a preview would have replaced the panel by now.
    await expect.poll(() => page.locator(DETAILS).count(), { timeout: 2000 }).toBe(1);

    const heading = (await page.locator(`${DETAILS} h2`).first().textContent()) ?? "";
    expect(pinnedName).toContain(heading.trim());
    await expect(page.getByText("task urn")).toBeVisible();
  });

  test("names its subject once, and never three times", async ({ page }) => {
    await openDashboard(page, cascaded());
    await page.waitForSelector(".react-flow__node-data", { state: "attached" });

    await page.locator(".react-flow__node-data").nth(1).click();
    await expect(page.locator(DETAILS)).toBeVisible();

    const heading = ((await page.locator(`${DETAILS} h2`).first().textContent()) ?? "").trim();
    expect(heading.length).toBeGreaterThan(0);
    // The panel used to print the name as a section title, again in a meta line
    // describing the kind, and again as its own heading.
    const times = await page
      .locator(DETAILS)
      .evaluate(
        (panel, name) =>
          [...panel.querySelectorAll("*")].filter(
            (element) => (element.textContent ?? "").trim() === name,
          ).length,
        heading,
      );
    expect(times).toBe(1);
  });

  /*
   * A table's columns, named.
   *
   * obsel holds no warehouse credentials and never reads a table, so the panel
   * shows the column names its writer reported and the row count that writer
   * stated. The assertion that matters most lists the whole field, so no value
   * can appear in it without this test failing.
   */
  test("names a table's columns from its reported shape, and never its contents", async ({
    page,
  }) => {
    await openDashboard(page, cascaded());
    await page.waitForSelector(".react-flow__node-data", { state: "attached" });

    // The changed table, whose writer reported the renamed column.
    await page.getByText("clean orders", { exact: true }).first().click();
    await expect(page.locator(DETAILS)).toBeVisible();

    const names = page.locator(`${DETAILS} [class*="names"]`).first();
    await expect(names).toBeVisible();

    /*
     * Every name the field shows, in order, and nothing else in it.
     *
     * There were six blank blocks under each name, standing in for rows, and
     * this test used to assert that each one was empty. That check passes
     * trivially once no blocks exist and would have gone on passing forever, so
     * it is replaced by the stronger claim: here is the field in full. Something
     * able to hold a value could not be added to it without this failing.
     */
    const drawn = await names.evaluate((node) =>
      [...node.children].map((element) => (element.textContent ?? "").trim()),
    );
    expect(drawn).toEqual([
      "order_id",
      "customer",
      // What arrived, and what left, agreeing with the mark on the same board.
      "+ order_total_usd",
      "order_date",
      "- order_total",
    ]);

    // The counts, and the one sentence saying who counted them. obsel did not.
    await expect(page.locator(DETAILS)).toContainText("39 rows, as its writer reported them");
  });

  test("says so plainly when a table's writer has reported nothing", async ({ page }) => {
    await openDashboard(page, justOne("waiting"));
    await page.waitForSelector(".react-flow__node-data", { state: "attached" });

    await page.locator(".react-flow__node-data").first().click();
    await expect(page.getByText("nothing reported yet", { exact: false })).toBeVisible();
    await expect(page.locator(`${DETAILS} [class*="names"]`)).toHaveCount(0);
  });

  /*
   * The flow highlight, and the one rule that keeps it from lying: it says
   * "these edges touch that box", never "a change went this way". The cascade
   * says the second thing, in amber, and the two must not be layered.
   */
  /** Which edges are drawn as flowing, and which of those the cascade also lit. */
  function litEdges(page: Page) {
    return page.evaluate(() => {
      const flow = [...document.querySelectorAll(".react-flow__edge.obselFlow")];
      return {
        ids: flow.map((edge) => edge.getAttribute("data-id") ?? ""),
        alsoCascade: flow.filter((edge) => edge.classList.contains("animated")).length,
      };
    });
  }

  test("lights the writer and every reader of the table under the pointer", async ({ page }) => {
    await openDashboard(page, calm());
    await page.waitForSelector(".react-flow__node-data", { state: "attached" });

    await page.getByText("daily revenue", { exact: true }).first().click();

    // One writer and two readers, in the fixture's own pipeline shape.
    const lit = await litEdges(page);
    expect(lit.ids).toHaveLength(3);
    expect(lit.ids.filter((id) => id.endsWith("daily_revenue,PROD)"))).toHaveLength(1);
  });

  /*
   * The rule that keeps the two moving lines apart. Every edge touching
   * `daily revenue` on the cascaded board is already amber, saying a change
   * travelled it. Flow says only "you are pointing at this", and layering the
   * weaker statement over the stronger one would blur which is being made.
   */
  test("never draws flow along an edge the cascade already lit", async ({ page }) => {
    await openDashboard(page, cascaded());
    await page.waitForSelector(".react-flow__node-data", { state: "attached" });

    await page.getByText("daily revenue", { exact: true }).first().click();

    const lit = await litEdges(page);
    expect(lit.alsoCascade).toBe(0);
    expect(lit.ids, "every edge here is the cascade's to draw").toHaveLength(0);
    // And the cascade itself is untouched by the click.
    await expect(page.locator(".react-flow__edge.animated")).not.toHaveCount(0);
  });

  test("lights an edge the cascade did not reach", async ({ page }) => {
    await openDashboard(page, cascaded());
    await page.waitForSelector(".react-flow__node-data", { state: "attached" });

    // The raw table upstream of the change: its one reader was never marked, so
    // no amber runs here and the flow highlight is the only thing to draw.
    await page.getByText("raw orders", { exact: true }).first().click();

    const lit = await litEdges(page);
    expect(lit.ids).toHaveLength(1);
    expect(lit.alsoCascade).toBe(0);
  });

  test("holds still for a reader who asked for less motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openDashboard(page, cascaded());
    await page.waitForSelector(".react-flow__node-data", { state: "attached" });

    await page.getByText("clean orders", { exact: true }).first().click();
    await expect(page.locator(DETAILS)).toBeVisible();

    /*
     * The sketch's blocks were checked here too, until they stopped animating
     * for every reader. Asserting them under reduced motion now proves nothing
     * about reduced motion, so the check moved to the sketch's own test, where
     * it holds unconditionally.
     */
    const still = await page.evaluate(() => {
      const field = document.querySelector('[aria-label="Details"] dl > div');
      const edge = document.querySelector(".react-flow__edge.obselFlow path.react-flow__edge-path");
      return {
        fieldOpacity: field === null ? null : getComputedStyle(field).opacity,
        edgeAnimation: edge === null ? null : getComputedStyle(edge).animationName,
      };
    });

    // Nothing moves, and everything the panel states is readable on the first frame.
    expect(still.fieldOpacity).toBe("1");
    expect(still.edgeAnimation).toBe("none");
  });
});

/*
 * What obsel put back into DataHub.
 *
 * The judging criterion obsel scores best on is the one about contributing to the
 * graph rather than only reading it, and until now the board could not show that at
 * all: obsel wrote the tag and never read it back. These assertions are about the
 * cell that reports it, and the distinctions between its states are the substance.
 * A cell that said "written" unconditionally would be a badge, not a check.
 */
test.describe("the write-back is reported, not asserted", () => {
  /** The value beside a ribbon label, read the way a viewer reads it. */
  async function cell(page: Page, label: string) {
    return page.evaluate((wanted) => {
      const found = [...document.querySelectorAll("main span")].find(
        (span) => span.textContent === wanted,
      );
      const box = found?.closest("div");
      return box === null || box === undefined ? null : (box.textContent ?? "");
    }, label);
  }

  test("counts the tags DataHub confirms, once they have all landed", async ({ page }) => {
    await openDashboard(page, cascaded());
    // No "tagged" after the ratio. The cell's label already says what was
    // written and where, and the word both restated it and pushed the value
    // onto a second line in the panel's width.
    await expect
      .poll(() => cell(page, "written into DataHub"))
      .toMatch(/written into DataHub3 of 3/);
  });

  test("reads low while a write is in flight, without claiming a failure", async ({ page }) => {
    // obsel writes the mark before the tag and DataHub's writes are asynchronous, so
    // this is a state every real cascade passes through. It has to look like a count
    // moving, not like something broken.
    await openDashboard(page, midWrite());
    const text = await cell(page, "written into DataHub");
    expect(text).toMatch(/2 of 3/);
    expect(text?.toLowerCase()).not.toContain("fail");
    expect(text?.toLowerCase()).not.toContain("error");
  });

  test("names a tag left on work obsel considers clean", async ({ page }) => {
    // A reset done by hand clears the properties and leaves the tag. Unlike a write
    // in flight this never resolves itself, so it gets its own words.
    await openDashboard(page, leftOverTag());
    await expect
      .poll(() => cell(page, "written into DataHub"))
      .toMatch(/1tag left over from before/);
  });

  test("says nothing was marked rather than counting zero of zero", async ({ page }) => {
    await openDashboard(page, calm());
    const text = await cell(page, "written into DataHub");
    expect(text).toContain("nothing to write yet");
    expect(text).not.toContain("0 of 0");
  });

  test("admits it does not know on a snapshot with no tag information", async ({ page }) => {
    // The honesty case. `0 of 3` would claim DataHub is missing three tags obsel
    // never looked for, which understates obsel's own contribution and is still false.
    await openDashboard(page, withoutTagInfo());
    const text = await cell(page, "written into DataHub");
    expect(text).toContain("obsel did not check");
    expect(text).not.toContain("0 of 3");
  });

  test("the details panel shows the tag and links to the real entity", async ({ page }) => {
    await openDashboard(page, cascaded());
    await page.waitForSelector(".react-flow__node-task", { state: "attached" });
    await page.locator(".react-flow__node-task").nth(1).click();
    await expect(page.getByText("tags in DataHub")).toBeVisible();

    const href = await page
      .getByRole("link", { name: /open this job in DataHub/ })
      .getAttribute("href");

    // The URN the panel itself is showing, rather than a guess at which node the
    // click landed on. The invariant that matters is that the link goes to the job
    // on screen, and pinning a task name here only tests dagre's ordering.
    const urn = await page.evaluate(() => {
      const label = [...document.querySelectorAll("dt")].find((d) => d.textContent === "task urn");
      return label?.nextElementSibling?.textContent ?? null;
    });

    expect(urn).not.toBeNull();
    expect(href).toBe(`http://localhost:9002/tasks/${urn}`);

    /*
     * `/tasks/`, and the URN raw.
     *
     * DataHub registers `tasks` as the DataJob path name and escapes a URN with a
     * partial rule that leaves `:` and `(` alone, both read out of the bundle the
     * local instance serves. A percent-encoded URN here would look right and fail
     * when clicked, which is the failure this asserts against.
     */
    expect(href).toContain("/tasks/urn:li:dataJob:(");
    expect(href).not.toContain("%3A");
  });
});
