import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { finishedStep, idle } from "./fixtures/activity";
import { openDashboard } from "./fixtures/mount";
import { markedNames, scaleFlagged, scaleSettled } from "./fixtures/scale";
import { cascaded } from "./fixtures/swarm";
import { manyDecisions } from "./fixtures/trace";
import { boardWords, describeWords } from "./fixtures/words";

/**
 * The forty-task board, against two recordings of a real run.
 *
 * Everything here needs both a browser and scale. The four-task suite in
 * `dashboard.spec.ts` covers what the board says and how it behaves; this covers
 * what only breaks once a real pipeline is on it, which turned out to be a
 * short and specific list.
 *
 * The clipping regression is the reason the file exists. At four tasks the
 * graph fits its panel at any zoom and every framing assertion passes; at forty
 * the layout needs a zoom below React Flow's `fitView` floor, so `fitView`
 * clamped, centered what it could, and cut the top and bottom rows off with
 * nothing anywhere reporting a fault. Forty nodes were in the DOM, correct,
 * and a quarter of them were not on screen.
 *
 * Fixtures: `e2e/fixtures/scale.ts`, and read its header. They are recordings
 * of real snapshots rather than invented ones, which is a deliberate difference
 * from every other fixture in this suite.
 */

/** Every node's box, and the pane it has to stay inside. */
async function framing(page: Page) {
  return page.evaluate(() => {
    const pane = document.querySelector(".react-flow")?.getBoundingClientRect();
    if (pane === undefined) return null;
    const nodes = [...document.querySelectorAll(".react-flow__node")];
    const clipped = nodes.filter((node) => {
      const box = node.getBoundingClientRect();
      return (
        box.top < pane.top - 1 ||
        box.bottom > pane.bottom + 1 ||
        box.left < pane.left - 1 ||
        box.right > pane.right + 1
      );
    });
    return {
      total: nodes.length,
      clipped: clipped.map((node) => node.getAttribute("data-id") ?? "?"),
      zoom: Number(
        /matrix\(([^,]+)/.exec(
          getComputedStyle(document.querySelector(".react-flow__viewport")!).transform,
        )?.[1] ?? 1,
      ),
    };
  });
}

/** The trace panel under the graph, and the scroller inside it. */
async function stripHeights(page: Page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[aria-label="What obsel is doing"]');
    const list = panel?.querySelector("ol") ?? null;
    return {
      panel: Math.round(panel?.getBoundingClientRect().height ?? 0),
      list: Math.round(list?.getBoundingClientRect().height ?? 0),
    };
  });
}

/** Wait until React Flow has laid the graph out and framed it. */
async function graphReady(page: Page, nodes: number) {
  await page.waitForSelector(".react-flow__node", { state: "attached" });
  await expect
    .poll(() => page.evaluate(() => document.querySelectorAll(".react-flow__node").length))
    .toBe(nodes);
  // The fit runs on a measured pane, so it lands a frame or two after the nodes.
  await page.waitForTimeout(600);
}

test.describe("the graph at forty tasks", () => {
  for (const [name, board, nodes] of [
    ["settled", scaleSettled, 82],
    ["flagged", scaleFlagged, 82],
  ] as const) {
    test(`no node is cut off on the ${name} board`, async ({ page }) => {
      await openDashboard(page, board());
      await graphReady(page, nodes);

      const seen = await framing(page);
      expect(seen).not.toBeNull();
      expect(seen?.total).toBe(nodes);
      /*
       * The whole regression in one assertion. Before the fix this reported
       * about twenty clipped nodes at a zoom pinned to 0.50, which is
       * `fitView`'s own floor: it will not shrink past it, and it centers what
       * it cannot fit, so the rows at each end leave the pane silently.
       *
       * The fix grows the panel to the height the layout needs rather than
       * shrinking the boxes, which is the owner's call and the right one — the
       * labels are already small. The panel is allowed to exceed the viewport,
       * and the page scrolls, which is why this measures against the PANE and
       * not against the window. A node below the fold is reachable; a node
       * outside the pane is drawn nowhere.
       */
      expect(seen?.clipped, `clipped at zoom ${seen?.zoom}`).toEqual([]);
    });
  }

  test("eighty-two boxes and not one pair overlapping", async ({ page }) => {
    // The unit suite asserts this of dagre's own numbers at four tasks. This is
    // pixels, at forty, where the fan-out is wide enough that a packing mistake
    // has somewhere to hide.
    await openDashboard(page, scaleFlagged());
    await graphReady(page, 82);

    const overlaps = await page.evaluate(() => {
      const found: string[] = [];
      const nodes = [...document.querySelectorAll(".react-flow__node")].map((node) => ({
        id: node.getAttribute("data-id") ?? "?",
        box: node.getBoundingClientRect(),
      }));
      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const a = nodes[i].box;
          const b = nodes[j].box;
          const apart =
            a.right <= b.left + 0.5 ||
            b.right <= a.left + 0.5 ||
            a.bottom <= b.top + 0.5 ||
            b.bottom <= a.top + 0.5;
          if (!apart) found.push(`${nodes[i].id} overlaps ${nodes[j].id}`);
        }
      }
      return found;
    });

    expect(overlaps).toEqual([]);
  });

  test("the page still never scrolls sideways", async ({ page }) => {
    /*
     * The tall board is allowed to scroll down. Sideways is still a bug, and it
     * is the one the panel-grows fix could plausibly have introduced: the
     * layout is much wider than it is tall, so the zoom is decided by width,
     * and an off-by-one in the padding either clips the left column or pushes
     * the document wider than its viewport.
     */
    await openDashboard(page, scaleFlagged());
    await graphReady(page, 82);

    const box = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    }));
    expect(box.scrollW).toBeLessThanOrEqual(box.clientW + 1);
  });

  test("the panels under the graph get a real height, not their floor", async ({ page }) => {
    /*
     * The other half of growing the graph panel, and it was missed the first time.
     *
     * The strip under the graph is `flex: 1 1 0` with a 172px floor, which is
     * what hands it every pixel the graph does not use on a board that fits the
     * frame. A tall board has no spare pixels by definition, so the strip
     * resolved to its floor exactly: measured at 1920 x 990 before the fix, the
     * trace panel was 172px tall with a 105px scroller showing three of
     * eighty-six steps, and the details panel beside it the same. Both were
     * correct, both were unreadable, and no test could see it because nothing
     * was clipped and nothing overflowed.
     *
     * Asserted as a comparison against the demo board rather than as a pixel
     * count: what went wrong is that the strip got LESS room on the board with
     * more to say, and a constant here would just be the new number to drift
     * from. The four-task board is measured in the same session for the same
     * reason the word counts are.
     */
    await openDashboard(page, cascaded());
    await page.waitForSelector(".react-flow__node", { state: "attached" });
    await page.waitForTimeout(600);
    const demo = await stripHeights(page);

    await openDashboard(page, scaleFlagged());
    await graphReady(page, 82);
    const taxi = await stripHeights(page);

    const where = `demo ${JSON.stringify(demo)} | taxi ${JSON.stringify(taxi)}`;
    // The floor, which is what it used to land on to the pixel.
    expect(taxi.panel, where).toBeGreaterThan(172);
    // And no worse off than the board with a quarter of the tasks.
    expect(taxi.panel, where).toBeGreaterThanOrEqual(demo.panel);
    // Enough scroller for a real session rather than three rows of one.
    expect(taxi.list, where).toBeGreaterThanOrEqual(280);
  });

  test("the graph zooms to design-size labels, and the fit button always recovers", async ({
    page,
  }) => {
    /*
     * The hybrid answer to a measured problem: the forty-task board fits at
     * zoom 0.578, which renders a 13px label at 7.5px. The whole graph stays
     * the establishing shot, and the detail now exists on demand — drag pans,
     * pinch zooms, and React Flow's own buttons give the mouse the same moves,
     * with the fit button as the guaranteed way back. That last part is the
     * condition the old no-interaction lock existed to protect: a stranded
     * graph used to be unrecoverable, so nothing was allowed to move it.
     */
    await openDashboard(page, scaleFlagged());
    await graphReady(page, 82);

    const zoomOf = () =>
      page.evaluate(() =>
        Number(
          /matrix\(([^,]+)/.exec(
            getComputedStyle(document.querySelector(".react-flow__viewport")!).transform,
          )?.[1] ?? 0,
        ),
      );

    const fitted = await zoomOf();
    expect(fitted).toBeGreaterThan(0.2);
    expect(fitted, "forty tasks fit only below design size").toBeLessThan(1);

    // The three stock buttons, wearing obsel's tokens rather than the white
    // card they ship in. White here would be the one light patch on the board.
    const controls = page.locator(".react-flow__controls");
    await expect(controls).toBeVisible();
    await expect(controls.locator("button")).toHaveCount(3);
    const paint = await controls.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(paint).not.toBe("rgb(255, 255, 255)");

    /*
     * Zoom in until the labels reach the size they were designed at. The
     * instance range is what makes this possible: fitView options alone are
     * clamped by the viewport's own floor and ceiling.
     *
     * Clicked until it arrives rather than a fixed six times. The number of
     * clicks was never the property; being able to get there was. It is also no
     * longer a constant: the canvas is the frame minus the panel, so how far
     * below design size a board starts depends on how wide the reader has left
     * the panel, and six clicks reached 0.89 at 1280 with the panel at its default.
     * The bound is what keeps this a test rather than a loop.
     */
    const zoomIn = page.getByRole("button", { name: /zoom in/i });
    let close = await zoomOf();
    for (let i = 0; i < 12 && close <= 0.95; i += 1) {
      await zoomIn.click();
      close = await zoomOf();
    }
    expect(close, "the zoom button should reach design size").toBeGreaterThan(0.95);

    // Now strand the picture on purpose: pan hard while zoomed in.
    const pane = page.locator(".react-flow__pane");
    const box = await pane.boundingBox();
    if (box === null) throw new Error("no pane");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 600, box.y + box.height / 2 + 400, { steps: 5 });
    await page.mouse.up();

    // One click back to the whole graph, nothing clipped. This is the recovery
    // the lock used to be a substitute for.
    await page.getByRole("button", { name: /fit view/i }).click();
    await page.waitForTimeout(400);
    const seen = await framing(page);
    expect(seen?.clipped, "fit view must recover the whole graph").toEqual([]);
    expect(Math.abs((seen?.zoom ?? 0) - fitted), "back to the fitted frame").toBeLessThan(0.05);
  });

  test("the graph reframes rather than clipping when the window shrinks", async ({ page }) => {
    await openDashboard(page, scaleFlagged());
    await graphReady(page, 82);
    expect((await framing(page))?.clipped).toEqual([]);

    /*
     * Polled, not slept on. A resize triggers a reframe that takes CAMERA_MS to
     * travel (`motion-tokens.ts`), and a fixed wait long enough on an idle
     * machine is not long enough under a full parallel run: this asserted
     * mid-flight and reported nodes clipped that were still moving into frame.
     * The condition is the same one, waited for rather than timed.
     */
    const size = page.viewportSize();
    await page.setViewportSize({ width: 1100, height: 620 });
    await expect.poll(async () => (await framing(page))?.clipped, { timeout: 8_000 }).toEqual([]);

    await page.setViewportSize({ width: size?.width ?? 1280, height: size?.height ?? 800 });
    await expect.poll(async () => (await framing(page))?.clipped, { timeout: 8_000 }).toEqual([]);
  });
});

test.describe("precision, where it is finally visible", () => {
  test("exactly the recorded nine are amber, and nothing else is", async ({ page }) => {
    /*
     * The claim the scale board exists to make, checked in pixels against the
     * record it was drawn from. `nodeTone`'s amber-iff-stale rule is unit
     * tested; what this adds is that the rendered board agrees with the
     * captured snapshot, task for task, at a size where "some of them are
     * amber" would look convincing and be wrong.
     */
    await openDashboard(page, scaleFlagged());
    await graphReady(page, 82);

    const painted = await page.evaluate(() => {
      const name = (node: Element) =>
        (node.getAttribute("data-id") ?? "?").split(",").pop()?.replace(")", "") ?? "?";
      // The box React Flow wraps around each node carries `data-id`; the styled
      // element is the one inside it, which is where `nodeTone`'s fill lands.
      const boxes = [...document.querySelectorAll(".react-flow__node-task")].map((node) => {
        const painted = (node.querySelector("[style]") ?? node) as HTMLElement;
        return {
          name: name(node),
          // The token as authored, which is the invariant `tone.ts` states: the
          // fill is a custom property and never a literal color.
          token: painted.style.borderLeftColor,
          // And the same property resolved, so a token that stopped resolving
          // shows up as an unpainted board rather than as a passing test.
          resolved: getComputedStyle(painted).borderLeftColor,
        };
      });
      return boxes;
    });

    const amber = painted.filter((node) => node.token.includes("--obsel-stale"));
    expect(amber.map((node) => node.name).sort()).toEqual([...markedNames()].sort());
    expect(amber).toHaveLength(9);

    // Every other task is painted, and painted differently. Without this the
    // assertion above would pass on a board where the amber token silently
    // stopped resolving and all eighty-two boxes rendered identically.
    const colors = new Set(painted.map((node) => node.resolved));
    expect(colors.size, "stale and done must not resolve to the same color").toBeGreaterThan(1);
    expect(amber.every((node) => node.resolved.startsWith("rgb"))).toBe(true);
  });

  test("the board says how far the change reached, in words", async ({ page }) => {
    await openDashboard(page, scaleFlagged());
    await graphReady(page, 82);

    // Derived from the capture, not from any script: nine marked of forty
    // finished, and four of the nine never touched the table that moved.
    await expect(
      page.getByRole("heading", { name: "9 of 40 finished agents are out of date" }),
    ).toBeVisible();
    await expect(page.getByText(/daily trips lost the column riders/)).toBeVisible();
    await expect(page.getByText(/gained the column passenger_total/)).toBeVisible();
    await expect(page.getByText(/4 of the 9 never read that table/)).toBeVisible();
  });

  test("all three hop distances are on the board", async ({ page }) => {
    // One hop, two hops, three hops. The four-task demo reaches two and cannot
    // show that the walk keeps going, which is the part a lineage graph is for.
    await openDashboard(page, scaleFlagged());
    await graphReady(page, 82);

    const hops = await page.evaluate(() =>
      [...document.querySelectorAll(".react-flow__node-task")]
        .map((node) => /·\s*(\d+)\s*hops?/.exec(node.textContent ?? "")?.[1])
        .filter((hop): hop is string => hop !== undefined),
    );

    expect(hops).toHaveLength(9);
    expect([...new Set(hops)].sort()).toEqual(["1", "2", "3"]);
    expect(hops.filter((hop) => hop === "3")).toHaveLength(1);
  });

  test("a three-hop mark opens its reason in full", async ({ page }) => {
    await openDashboard(page, scaleFlagged());
    await graphReady(page, 82);

    // The task at the far end of the longest chain, found by its recorded hop
    // count rather than by a name, so this does not pin dagre's ordering.
    const deepest = page.locator(".react-flow__node-task").filter({ hasText: "3 hops" }).first();
    await deepest.scrollIntoViewIfNeeded();
    await deepest.click();
    await expect(page.getByText("mark · reason")).toBeVisible();

    const reason = await page.evaluate(() => {
      const label = [...document.querySelectorAll("dt")].find(
        (dt) => dt.textContent === "mark · reason",
      );
      const value = label?.nextElementSibling as HTMLElement | null;
      if (value === null || value === undefined) return null;
      return {
        text: value.textContent ?? "",
        clipped:
          value.scrollHeight > value.clientHeight + 1 || value.scrollWidth > value.clientWidth + 1,
      };
    });

    expect(reason).not.toBeNull();
    // Named in words, and naming the task in between rather than the origin —
    // which is the sentence `staleness.ts` builds for a mark past one hop.
    expect(reason?.text).toContain("built on work from");
    expect(reason?.text).toContain("daily trips");
    expect(reason?.text).not.toContain("daily_trips");
    expect(reason?.clipped, "a truncated reason is a mark with no traceable cause").toBe(false);
  });

  test("the changed table names the column that left and the one that arrived", async ({
    page,
  }) => {
    await openDashboard(page, scaleFlagged());
    await graphReady(page, 82);

    const origin = page.locator('.react-flow__node-data [data-origin="true"]');
    await expect(origin).toHaveCount(1);
    await expect(origin).toContainText("- riders");
    await expect(origin).toContainText("+ passenger_total");
  });
});

test.describe("the taxi board's own buttons", () => {
  test("settled offers the change, and the click launches the real step", async ({ page }) => {
    const { launches } = await openDashboard(page, scaleSettled());
    await graphReady(page, 82);

    await expect(
      page.getByRole("heading", { name: "all 40 finished, nothing out of date" }),
    ).toBeVisible();
    const button = page.getByRole("button", { name: /Change one requirement/ });
    await button.click();
    await expect.poll(() => launches).toEqual(["scale-change"]);
  });

  test("flagged leads with the parallel repair, and never offers another change", async ({
    page,
  }) => {
    const { launches } = await openDashboard(page, scaleFlagged());
    await graphReady(page, 82);

    const repair = page.getByRole("button", { name: /Redo the work obsel flagged, in parallel/ });
    await expect(repair).toBeVisible();
    // A second change on a flagged board would stack two cascades and make the
    // next answer unreadable, so the flagged stage does not offer one.
    await expect(page.getByRole("button", { name: /Change one requirement/ })).toHaveCount(0);

    await repair.click();
    await expect.poll(() => launches).toEqual(["scale-repair"]);
  });

  test("ten times the pipeline says no more to a reader", async ({ page }) => {
    /*
     * What the board-wide word ceiling was always trying to say, and could not.
     *
     * The board's density has to be a property of the board, not of the pipeline
     * somebody points it at. Ten times the tasks, ten times the tables, and the
     * amount of prose a reader is confronted with should be the same board: the
     * headline counts differ and nothing else does, because every sentence on it
     * is derived from the snapshot rather than written per pipeline.
     *
     * Both boards are measured in the same session, at the same viewport, with
     * the same activity and the same trace behind them, so the only variable is
     * the swarm. An absolute ceiling on the scale board would pass on a board
     * that had quietly grown as long as somebody raised the number; comparing
     * the two cannot be satisfied that way.
     */
    await openDashboard(page, cascaded(), finishedStep(), manyDecisions());
    await page.waitForSelector(".react-flow__node", { state: "attached" });
    await page.waitForTimeout(600);
    const four = await boardWords(page);

    await openDashboard(page, scaleFlagged(), finishedStep(), manyDecisions());
    await graphReady(page, 82);
    const forty = await boardWords(page);

    const where = `four: ${describeWords(four)} | forty: ${describeWords(forty)}`;

    /*
     * A comparison, and no absolute number any more.
     *
     * There was an `expect(forty.prose).toBeLessThan(160)` here, matching the
     * board-wide ceiling in `dashboard.spec.ts`. Both are gone, and the comment
     * where that one stood records why: a number on the total measured the one
     * property of prose that says nothing about whether the prose is any good,
     * and it moved every time it was in the way.
     *
     * This assertion never needed it. What it is actually about is that the
     * board's density is a property of the board rather than of the pipeline
     * somebody points it at: ten times the tasks, ten times the tables, and the
     * same amount to read, because every sentence is derived from the snapshot
     * instead of written per pipeline. A board that doubled its copy would fail
     * this whether or not anybody had agreed a ceiling first, because the two
     * boards are measured in the same session at the same viewport and only the
     * swarm differs.
     *
     * A band rather than an equality because a few words legitimately differ:
     * two-digit counts in the headline, and each stage's own button lines.
     */
    expect(Math.abs(forty.prose - four.prose), where).toBeLessThan(25);

    /*
     * The graph's own budget, per node rather than in total.
     *
     * A label is a task's registered title plus its status, or a table's name.
     * Scanned, not read. The longest costs 8: a two-word title, "out of date",
     * the separator, and "1 hop" — the middot counts as a token, which is what
     * splitting on whitespace does and is left alone rather than special-cased.
     * Nine allows a longer registered title without allowing a sentence.
     *
     * This is the assertion that replaced a total, and the replacement is the
     * point: a label growing into a sentence fails here, and a pipeline that
     * simply has more tasks in it does not. The old combined ceiling could not
     * tell those apart, so a forty-task board failed it without one word of the
     * board's own copy having changed.
     */
    expect(forty.graphNodes, where).toBe(82);
    expect(forty.graphWorst, where).toBeLessThanOrEqual(9);
    expect(forty.graph / forty.graphNodes, where).toBeLessThan(4);
  });

  test("no em dash, and no internal identifier, at forty either", async ({ page }) => {
    // The two copy guards from `dashboard.spec.ts`, over the states only this
    // pipeline produces. Node labels are the risk here: forty task titles and
    // forty-two table names all come from the recording rather than from
    // anything written for the board, so an identifier reaching the screen
    // would be a naming bug rather than a copy slip.
    const leaks: string[] = [];
    for (const [name, board] of [
      ["settled", scaleSettled],
      ["flagged", scaleFlagged],
    ] as const) {
      await openDashboard(page, board(), idle());
      await graphReady(page, 82);

      const found = await page.evaluate(() => {
        /*
         * The four exclusions `dashboard.spec.ts` documents, plus the header.
         *
         * The header names the DataFlow this board is reading, and that name is
         * the operator's own: it comes from `OBSEL_FLOW_ID`, so on this board it
         * reads `obsel_scale_v2 · prod`. It is a value the reader needs in order
         * to know which swarm is on screen, in the same category as the URN in
         * the details panel, and obsel cannot make somebody else's flow id
         * pretty without misnaming it.
         */
        const RAW =
          '[aria-label="What obsel is doing"], [aria-label="Details"], ' +
          '[aria-label="Bring your own agent"], header, pre, code';
        const main = document.querySelector("main");
        if (main === null) return ["there is no <main>"];
        const seen: string[] = [];
        const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          if (node.parentElement?.closest(RAW) != null) continue;
          const text = node.textContent ?? "";
          if (text.includes("—")) seen.push(`em dash in "${text.trim()}"`);
          // Underscored identifiers, which is what a table or task name looks
          // like before `naming.ts` humanises it. The two column names on the
          // changed table are exempt: a column is called what it is called, and
          // renaming it in prose would defeat the point of showing the diff.
          for (const word of (text.match(/[a-z]+_[a-z_]+/g) ?? []).filter(
            (w) => w !== "passenger_total" && w !== "riders",
          )) {
            seen.push(`"${word}" in "${text.trim()}"`);
          }
          if (text.includes("obsel_taxi")) seen.push(`namespace in "${text.trim()}"`);
        }
        return seen;
      });

      leaks.push(...found.map((leak) => `${name}: ${leak}`));
    }

    expect(leaks).toEqual([]);
  });
});
