import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  codexSignedOut,
  finishedStep,
  idle,
  nothingInstalled,
  runningStep,
  walked,
} from "./fixtures/activity";
import {
  calm,
  cascaded,
  empty,
  justOne,
  leftOverTag,
  midWrite,
  repaired,
  visiting,
  withoutTagInfo,
} from "./fixtures/swarm";
import { openCockpit, openTab } from "./fixtures/mount";
import { cascadeSteps, longRun, manyDecisions } from "./fixtures/trace";

/**
 * Everything here needs a real browser.
 *
 * Deliberately excluded: anything `tests/cockpit-*.test.ts` already proves
 * without one — nodeTone's amber-iff-stale invariant, geometry invariance
 * across statuses, cascadeEdges hop numbers and cycle termination, the totals
 * arithmetic, the shader/token equivalence. Duplicating those here would only
 * make the suite slower and no more true.
 */

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
function obselAlert(page: Page) {
  return page.locator('main [role="alert"]');
}

test.describe("typography", () => {
  test("the real faces resolved, not a fallback", async ({ page }) => {
    await openCockpit(page, cascaded());

    const loaded = await page.evaluate(() =>
      [...document.fonts].map((f) => `${f.family}/${f.status}`),
    );
    expect(loaded, "GeistMono must actually load").toContain("GeistMono/loaded");
    expect(loaded, "GeistSans must actually load").toContain("GeistSans/loaded");

    const bodyFamily = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(bodyFamily.startsWith("GeistMono")).toBe(true);

    // app/layout.tsx notes this failure is silent — the page renders in Menlo
    // and merely looks slightly off. No unit test can see a resolved font.
  });

  /*
   * Two tests used to live here that measured `main svg text`: one checking a
   * table of per-character advances for Geist Mono, one checking that no text
   * escaped the rectangle it was centred in. Both existed because the graph was
   * hand-positioned SVG whose box widths were reserved by counting characters, so
   * a font substitution clipped labels on camera with nothing to catch it.
   *
   * The graph is React Flow now and its nodes are HTML, so the browser lays the
   * text out and CSS ellipsis handles anything too long. What replaced those
   * tests is the check below, which is the concern that survived the rewrite:
   * dagre reserves a footprint per node, and if the DOM renders a node LARGER
   * than that, dagre has packed boxes that overlap in reality while its own
   * numbers, and the unit tests over them, stay perfectly consistent.
   */
  test("no node renders larger than the footprint dagre reserved for it", async ({ page }) => {
    await openCockpit(page, cascaded());
    await page.waitForSelector(".react-flow__node", { state: "attached" });

    const bad = await page.evaluate(() => {
      const problems: string[] = [];
      const nodes = [...document.querySelectorAll<HTMLElement>(".react-flow__node")];
      // The CSS sizes, read back undoing React Flow's viewport zoom.
      const zoom = Number(
        /matrix\(([^,]+)/.exec(
          getComputedStyle(document.querySelector(".react-flow__viewport")!).transform,
        )?.[1] ?? 1,
      );
      for (const node of nodes) {
        const box = node.getBoundingClientRect();
        const id = node.getAttribute("data-id") ?? "?";
        const isTask = node.classList.contains("react-flow__node-task");
        const isOrigin = node.querySelector('[data-origin="true"]') !== null;
        const limit = isTask ? { w: 168, h: 56 } : isOrigin ? { w: 176, h: 84 } : { w: 152, h: 56 };
        const w = box.width / zoom;
        const h = box.height / zoom;
        // A pixel of slack for subpixel rounding at fractional zoom.
        if (w > limit.w + 1) problems.push(`${id} is ${w.toFixed(1)}px wide, reserved ${limit.w}`);
        if (h > limit.h + 1) problems.push(`${id} is ${h.toFixed(1)}px tall, reserved ${limit.h}`);
      }
      return problems;
    });

    expect(bad).toEqual([]);
  });

  test("no two nodes overlap once the browser has laid them out", async ({ page }) => {
    // The unit suite asserts this of dagre's numbers. This asserts it of pixels,
    // which is the thing a viewer actually sees.
    await openCockpit(page, cascaded());
    await page.waitForSelector(".react-flow__node", { state: "attached" });

    const overlaps = await page.evaluate(() => {
      const found: string[] = [];
      const nodes = [...document.querySelectorAll(".react-flow__node")].map((n) => ({
        id: n.getAttribute("data-id") ?? "?",
        r: n.getBoundingClientRect(),
      }));
      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const a = nodes[i].r;
          const b = nodes[j].r;
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

  test("the whole graph stays inside its panel after the panel resizes", async ({ page }) => {
    /*
     * The regression this exists for, which shipped twice.
     *
     * React Flow's `fitView` prop fires once, on mount. Every later change of
     * size leaves the transform where it was: the panel has a 220px floor and
     * shrinks on a short viewport, the guide panel above it changes height
     * between demo stages, and the changed table's node grows from 56px to 84px
     * when the column diff appears. Measured before the fix, the scale stayed
     * pinned at 1.14 through a 266px to 238px shrink, and after a hot reload the
     * graph sat 250px below a panel that clips its overflow.
     *
     * It fails silently and completely. Nine nodes and eight edges are present
     * and correct in the DOM, and none of them is on screen, with no warning
     * anywhere. Pan and zoom are off, so it cannot be dragged back either.
     */
    await openCockpit(page, cascaded());
    await page.waitForSelector(".react-flow__node", { state: "attached" });
    await page.waitForTimeout(400);

    const framing = async () =>
      page.evaluate(() => {
        const canvas = document.querySelector(".react-flow")?.getBoundingClientRect();
        if (canvas === undefined) return null;
        const nodes = [...document.querySelectorAll(".react-flow__node")];
        const outside = nodes.filter((node) => {
          const r = node.getBoundingClientRect();
          return r.top < canvas.top - 1 || r.bottom > canvas.bottom + 1;
        });
        return { total: nodes.length, outside: outside.length };
      });

    const before = await framing();
    expect(before).not.toBeNull();
    expect(before?.total).toBeGreaterThan(0);
    expect(before?.outside).toBe(0);

    // Shrink hard, which is what a short viewport and a tall guide panel each do.
    const size = page.viewportSize();
    await page.setViewportSize({ width: size?.width ?? 1280, height: 620 });
    await page.waitForTimeout(500);
    expect((await framing())?.outside).toBe(0);

    await page.setViewportSize({ width: size?.width ?? 1280, height: size?.height ?? 800 });
    await page.waitForTimeout(500);
    expect((await framing())?.outside).toBe(0);
  });
});

/**
 * The header lockup, which needs a real browser for a reason the other blocks
 * do not.
 *
 * `tests/cockpit-mark.test.ts` covers the mark's geometry without one, and
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
    await openCockpit(page, cascaded());

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
    await openCockpit(page, cascaded());

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
      await openCockpit(page, cascaded());

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

test.describe("fit", () => {
  test("never scrolls horizontally; vertical fit holds at the recording size", async ({
    page,
    viewport,
  }) => {
    await openCockpit(page, cascaded());

    const box = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      scrollH: document.documentElement.scrollHeight,
      clientW: document.documentElement.clientWidth,
      clientH: document.documentElement.clientHeight,
    }));

    expect(box.scrollW, "horizontal scroll is always a bug here").toBeLessThanOrEqual(
      box.clientW + 1,
    );

    if ((viewport?.height ?? 0) >= 990) {
      // The recording frame: the whole board, ribbon included, on screen.
      expect(
        box.scrollH,
        `vertical fit at ${viewport?.width}x${viewport?.height}`,
      ).toBeLessThanOrEqual(box.clientH + 1);
    } else {
      // A laptop may scroll, but what orients a newcomer, the headline and the
      // whole graph, must be above the fold rather than something they discover.
      const tops = await page.evaluate(() => {
        const guide = document.querySelector('[aria-label="guide"]');
        const graph = document.querySelector(".react-flow");
        return {
          guideBottom: guide?.getBoundingClientRect().bottom ?? Number.NaN,
          graphBottom: graph?.getBoundingClientRect().bottom ?? Number.NaN,
        };
      });
      expect(tops.guideBottom, "guide fully visible").toBeLessThanOrEqual(box.clientH + 1);
      expect(tops.graphBottom, "graph fully visible").toBeLessThanOrEqual(box.clientH + 1);
    }
  });

  test("the stat ribbon is above the fold at the recording size — it holds the measured number", async ({
    page,
    viewport,
  }) => {
    test.skip(
      (viewport?.height ?? 0) < 990,
      "on a laptop the ribbon may scroll into view; the recording frame is where the fold is binding",
    );
    await openCockpit(page, cascaded());

    const bottom = await page.evaluate(() => {
      const labels = [...document.querySelectorAll("main span")].filter(
        (s) => s.textContent === "detection time",
      );
      const cell = labels[0]?.closest("div");
      return cell === null || cell === undefined ? null : cell.getBoundingClientRect().bottom;
    });

    expect(bottom, "detection time cell should exist").not.toBeNull();
    expect(bottom as number).toBeLessThanOrEqual(
      (await page.evaluate(() => window.innerHeight)) + 1,
    );
  });

  /*
   * The reason sentence is no longer on the board, so it can no longer be clipped
   * there. It moved into the details panel, which opens on a click, and the rule
   * it was protecting still holds: the sentence is shown in full and verbatim,
   * never truncated. Asserted below, after opening a node.
   */
  test("a mark's recorded reason opens in full, never truncated", async ({ page }) => {
    await openCockpit(page, cascaded());
    await page.waitForSelector(".react-flow__node-task", { state: "attached" });

    // Clicking a box on the graph is now how a viewer asks "why this one?".
    await page.locator(".react-flow__node-task").nth(1).click();
    await expect(page.getByText("mark · reason")).toBeVisible();

    const reason = await page.evaluate(() => {
      const label = [...document.querySelectorAll("dt")].find(
        (d) => d.textContent === "mark · reason",
      );
      const value = label?.nextElementSibling as HTMLElement | null;
      if (value === null || value === undefined) return null;
      return {
        text: value.textContent ?? "",
        clipped:
          value.scrollHeight > value.clientHeight + 1 || value.scrollWidth > value.clientWidth + 1,
        ellipsis: getComputedStyle(value).textOverflow === "ellipsis",
      };
    });

    expect(reason).not.toBeNull();
    // The sentence the coordinator stored, in words rather than identifiers.
    expect(reason?.text).toContain("clean orders");
    expect(reason?.text).not.toContain("clean_orders");
    expect(reason?.clipped, "a truncated reason is a mark with no traceable cause").toBe(false);
    expect(reason?.ellipsis).toBe(false);
  });

  /*
   * The answer to "what tables?". A table box used to be inert, which left the
   * board's central noun as an abstraction a viewer had to take on faith. A
   * click now opens a derived view: who writes it, who reads it, and what the
   * writer's last completion said came out.
   */
  test("clicking a table opens its details: writer, readers, columns", async ({ page }) => {
    await openCockpit(page, cascaded());
    await page.waitForSelector(".react-flow__node-data", { state: "attached" });

    await page.locator(".react-flow__node-data").nth(1).click();
    await expect(page.getByText("table urn")).toBeVisible();
    await expect(page.getByText("written by")).toBeVisible();
    await expect(page.getByText("read by")).toBeVisible();
    // The panel says these are reported values, not a live read of the file.
    await expect(
      page.getByText("obsel stores nothing on the table itself", { exact: false }),
    ).toBeVisible();
  });

  test("opening the details panel moves nothing in the graph", async ({ page }) => {
    await openCockpit(page, cascaded());
    await page.waitForSelector(".react-flow__node", { state: "attached" });

    const measure = () =>
      page.evaluate(() => {
        const nodes = [...document.querySelectorAll(".react-flow__node")];
        return {
          graph: Math.round(
            document.querySelector(".react-flow")?.getBoundingClientRect().height ?? 0,
          ),
          nodeTops: nodes.map((n) => Math.round(n.getBoundingClientRect().top)),
          scrollH: document.documentElement.scrollHeight,
        };
      });

    const before = await measure();
    await page.locator(".react-flow__node-task").first().click();
    await expect(page.getByText("task urn")).toBeVisible();
    const after = await measure();

    // The details panel takes room from the log strip beside it, never from the
    // graph, so nothing a viewer is looking at jumps when it opens.
    expect(after.graph).toBe(before.graph);
    expect(after.nodeTops).toEqual(before.nodeTops);
    expect(after.scrollH).toBe(before.scrollH);
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
    await openCockpit(page, cascaded());
    await expect
      .poll(() => cell(page, "written into DataHub"))
      .toMatch(/written into DataHub3 of 3tagged/);
  });

  test("reads low while a write is in flight, without claiming a failure", async ({ page }) => {
    // obsel writes the mark before the tag and DataHub's writes are asynchronous, so
    // this is a state every real cascade passes through. It has to look like a count
    // moving, not like something broken.
    await openCockpit(page, midWrite());
    const text = await cell(page, "written into DataHub");
    expect(text).toMatch(/2 of 3/);
    expect(text?.toLowerCase()).not.toContain("fail");
    expect(text?.toLowerCase()).not.toContain("error");
  });

  test("names a tag left on work obsel considers clean", async ({ page }) => {
    // A reset done by hand clears the properties and leaves the tag. Unlike a write
    // in flight this never resolves itself, so it gets its own words.
    await openCockpit(page, leftOverTag());
    await expect
      .poll(() => cell(page, "written into DataHub"))
      .toMatch(/1tag left over from before/);
  });

  test("says nothing was marked rather than counting zero of zero", async ({ page }) => {
    await openCockpit(page, calm());
    const text = await cell(page, "written into DataHub");
    expect(text).toContain("nothing to write yet");
    expect(text).not.toContain("0 of 0");
  });

  test("admits it does not know on a snapshot with no tag information", async ({ page }) => {
    // The honesty case. `0 of 3` would claim DataHub is missing three tags obsel
    // never looked for, which understates obsel's own contribution and is still false.
    await openCockpit(page, withoutTagInfo());
    const text = await cell(page, "written into DataHub");
    expect(text).toContain("obsel did not check");
    expect(text).not.toContain("0 of 3");
  });

  test("the details panel shows the tag and links to the real entity", async ({ page }) => {
    await openCockpit(page, cascaded());
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

test.describe("honesty", () => {
  test("a failed read withholds every measured number", async ({ page }) => {
    const { serve } = await openCockpit(page, cascaded());

    // Every stat cell value, read out of the ribbon.
    const readRibbon = () =>
      page.evaluate(() => {
        // Scoped to the ribbon. Unscoped, "out of date" matches a graph node's
        // status word first and reads a value out of the wrong element.
        const ribbon = document.querySelector('[aria-label="Detection"]');
        if (ribbon === null) return ["NO RIBBON"];
        const labels = ["detection time", "written into DataHub"];
        return labels.map((label) => {
          const span = [...ribbon.querySelectorAll("span")].find((s) => s.textContent === label);
          const cell = span?.closest("div");
          const value = cell?.querySelectorAll("span")[1];
          return value?.textContent ?? "MISSING";
        });
      });

    await expect.poll(readRibbon).toEqual(["118ms", "3 of 3tagged"]);

    serve("fail");

    // Polled, not measured once: the cockpit only learns the read failed on its
    // next tick, up to POLL_MS later. Asserting immediately after `serve` is a
    // race that passes or fails on scheduling rather than on behaviour.
    // Not "most" of the numbers: both of them, and as the withheld placeholder
    // rather than as a stale last-known value.
    await expect.poll(readRibbon, { timeout: 8_000 }).toEqual(["··", "··"]);
    await expect(obselAlert(page)).toBeVisible();
  });

  /*
   * The detection figure runs up to itself, and stops there.
   *
   * The count exists because this number used to appear fully formed between two
   * polls, which is the same as not appearing at all to anybody who blinked. What
   * must not follow from that is the number moving when nothing has happened:
   * the board is re-read once a second and re-serves the same figure for as long
   * as the marks stand, so a counter keyed on the value rather than on the change
   * would run from zero every second, forever.
   *
   * The value itself is a measurement, so the last frame must be the measured
   * number exactly rather than a rounded approach to it.
   */
  test("the measured number arrives once, and then holds still", async ({ page }) => {
    const detection = () =>
      page.evaluate(() => {
        const ribbon = document.querySelector('[aria-label="Detection"]');
        const span = [...(ribbon?.querySelectorAll("span") ?? [])].find(
          (node) => node.textContent === "detection time",
        );
        return span?.closest("div")?.querySelectorAll("span")[1]?.textContent ?? "MISSING";
      });

    await openCockpit(page, cascaded());
    await expect.poll(detection).toBe("118ms");

    // Three seconds is three polls. A counter that restarts on a re-served
    // figure would be caught mid-run by at least one of these samples.
    const samples: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      samples.push(await detection());
      await page.waitForTimeout(250);
    }
    expect(new Set(samples), `the number moved after it arrived: ${samples.join(", ")}`).toEqual(
      new Set(["118ms"]),
    );
  });

  test("reduced motion shows the measured number without counting to it", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openCockpit(page, cascaded());

    // The finished picture on the first frame, which is this board's rule for
    // reduced motion everywhere: not a faster animation, no animation.
    const first = await page.evaluate(() => {
      const ribbon = document.querySelector('[aria-label="Detection"]');
      const span = [...(ribbon?.querySelectorAll("span") ?? [])].find(
        (node) => node.textContent === "detection time",
      );
      return span?.closest("div")?.querySelectorAll("span")[1]?.textContent ?? "MISSING";
    });
    expect(first).toBe("118ms");
  });

  test("the alert takes its own row rather than covering the board", async ({ page }) => {
    const { serve } = await openCockpit(page, cascaded());
    serve("fail");
    await expect(obselAlert(page)).toBeVisible();

    // Polled for the same reason as above, and it asserts the relationship
    // rather than two absolute positions: the alert must END above where the
    // graph BEGINS. A banner covering the board it warns about is worse than
    // no banner.
    //
    // `.react-flow` names the graph. This was `main svg`, meaning whichever
    // `<svg>` came first in the document, which was the graph only for as long
    // as the graph was the only drawing on the board. Putting a mark in the
    // header made that selector resolve to the logo, and the test then compared
    // the alert against something ABOVE it and reported the board covered. The
    // failure was in the selector, not the layout.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const a = document.querySelector('main [role="alert"]')?.getBoundingClientRect();
            const graph = document.querySelector(".react-flow")?.getBoundingClientRect();
            if (a === undefined || graph === undefined) return "not both present";
            return a.bottom <= graph.top ? "clear" : "overlapping";
          }),
        { timeout: 8_000 },
      )
      .toBe("clear");
  });

  test("a walked board offers the way back with no launcher history behind it", async ({
    page,
  }) => {
    /*
     * The restart case, in a browser. `idle()` reports an empty history, which is
     * exactly what a server that has just started reports, and the board is a
     * repaired one. Before this, restarting obsel took the reset button off a
     * board that had genuinely been all the way round.
     */
    await openCockpit(page, repaired(), idle());
    await expect(page.getByRole("button", { name: "Reset and start over" })).toBeVisible();
  });

  test("a board that has only run is not offered the way back", async ({ page }) => {
    // The other half: the gate still exists, so a first-run board is not offered
    // a button that throws away the run it just waited for.
    await openCockpit(page, calm(), idle());
    await expect(page.getByRole("button", { name: "Reset and start over" })).toBeHidden();
  });

  test("one action carries the accent, and every action is the same size", async ({ page }) => {
    await openCockpit(page, cascaded(), idle());
    const seen = await page
      .locator("main button[data-tour-action] span:first-child")
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const style = getComputedStyle(node);
          return { color: style.color, size: style.fontSize };
        }),
      );

    expect(seen.length).toBeGreaterThan(1);
    // Hierarchy is spent on colour, never on size: three guides failed by putting
    // what mattered at footnote size, and `docs/verification.md` measured it.
    expect(new Set(seen.map((entry) => entry.size)).size).toBe(1);
    // And exactly one colour occurs once. Asserted as singular rather than as a
    // hex value, so retuning the palette does not fail this.
    const colours = seen.map((entry) => entry.color);
    const once = colours.filter(
      (colour) => colours.filter((other) => other === colour).length === 1,
    );
    expect(once).toHaveLength(1);
  });

  test("the board says which board it is, and how to open a different one", async ({ page }) => {
    await openCockpit(page, calm(), idle());
    const name = page.locator("main header summary");
    await expect(name).toHaveText("orders_pipeline · prod");

    // Closed by default: the header is one line, and this is needed once.
    await expect(page.getByText("one DataFlow in DataHub", { exact: false })).toBeHidden();
    await name.click();
    await expect(page.getByText("one DataFlow in DataHub", { exact: false })).toBeVisible();
    // A command, not a bare variable name. The sweep below enforces the rule;
    // this pins that the reader is given the thing they have to run.
    await expect(page.getByText("OBSEL_FLOW_ID=my_board pnpm dev")).toBeVisible();
  });

  test("a stopped server is one fault, not two statements that disagree", async ({ page }) => {
    /*
     * Both of the board's reads fail together when the server stops, which is the
     * ordinary way a judge meets this screen. Each read had its own reporter and
     * neither knew about the other, so the board printed "The board below is
     * unaffected" from one and "Everything below is from the last read that
     * worked ... and may already be wrong" from the other, one paragraph apart.
     * Both cannot be true, and the first is the false one.
     *
     * Seen on a real stopped dev server on 2026-07-27, then pinned here.
     */
    const { serve, serveActivity } = await openCockpit(page, cascaded());
    serve("fail");
    serveActivity("fail");

    await expect(obselAlert(page)).toBeVisible();
    await expect(page.getByText("may already be wrong")).toBeVisible();
    await expect(page.getByText("The board below is unaffected")).toBeHidden();

    // The trace panel has its own copy of the same claim, and it was missed by the
    // first pass at this fix: the panel said "could not be read (...). The board is
    // unaffected." three panels below the alert saying the opposite.
    await expect(page.getByText("The board is unaffected")).toBeHidden();

    // And the guide still leads with a sentence. Asserted because nothing did:
    // reading this state back on a real stopped server, the guide block appeared
    // blank, and with no test on it there was no way to tell a real fault from an
    // artifact of how the screenshot was taken.
    await expect(page.getByText("The board lost its connection")).toBeVisible();
  });

  test("the demo read failing on its own still says the board is fine", async ({ page }) => {
    // The other half of the same condition, and the reason the sentence exists:
    // with the swarm read working, the graph below really is current.
    const { serveActivity } = await openCockpit(page, cascaded());
    serveActivity("fail");

    await expect(page.getByText("The board below is unaffected")).toBeVisible();
    await expect(obselAlert(page)).toBeHidden();
  });

  test("an empty swarm does not claim to be connected after a read fails", async ({ page }) => {
    const { serve } = await openCockpit(page, empty());
    await expect(page.getByText("obsel is connected")).toBeVisible();

    serve("fail");
    await expect(obselAlert(page)).toBeVisible();
    await expect(page.getByText("obsel is connected")).toBeHidden();
  });

  test("the calm state never renders the stale amber", async ({ page }) => {
    await openCockpit(page, calm());

    const amber = await page.evaluate(() => {
      const stale = getComputedStyle(document.documentElement)
        .getPropertyValue("--obsel-stale")
        .trim();
      const lit = document.querySelectorAll('main svg path[stroke*="obsel-stale"]');
      return { stale, litEdges: lit.length };
    });

    expect(amber.stale).toBe("#ffb020");
    expect(amber.litEdges, "nothing stale means no lit cascade edge").toBe(0);
    /*
     * And the board says so in words, not only in colour. This used to look for
     * "nothing to explain", which was the empty state of the changes-between-
     * reads panel the live trace replaced; the calm statement now comes from the
     * guide's own headline, derived from the same snapshot.
     */
    await expect(page.getByRole("heading", { name: /nothing out of date/ })).toBeVisible();
  });
});

test.describe("paint", () => {
  test("no console errors, no page errors, no failed subresources", async ({ page }) => {
    const { faults } = await openCockpit(page, cascaded());
    await page.waitForTimeout(1200); // let a couple of polls run

    expect(faults.pageErrors).toEqual([]);
    expect(faults.consoleErrors).toEqual([]);
    // A CSP-blocked font or script shows up here, which is the whole point:
    // app/layout.tsx and THIRD_PARTY_NOTICES.md both turn on obsel serving its
    // own fonts rather than fetching them.
    expect(faults.failedRequests).toEqual([]);
  });

  test("the WebGL backdrop actually painted, and left the centre clear", async ({ page }) => {
    await openCockpit(page, cascaded());

    const paint = await page.evaluate(() => {
      const canvas = document.querySelector("main canvas");
      if (canvas === null) return null;
      const c = canvas as HTMLCanvasElement;
      const gl = c.getContext("webgl");
      if (gl === null) return null;
      const buf = new Uint8Array(c.width * c.height * 4);
      gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const alphaAt = (x: number, y: number) => buf[(y * c.width + x) * 4 + 3];
      let max = 0;
      let centre = 0;
      let centreN = 0;
      for (let y = 0; y < c.height; y += 4) {
        for (let x = 0; x < c.width; x += 4) {
          const a = alphaAt(x, y);
          if (a > max) max = a;
          if (
            x > c.width * 0.3 &&
            x < c.width * 0.7 &&
            y > c.height * 0.35 &&
            y < c.height * 0.65
          ) {
            centre += a;
            centreN += 1;
          }
        }
      }
      return { max, centreMean: centre / Math.max(centreN, 1) };
    });

    // Null means no WebGL in this environment, which is a legitimate state —
    // the cockpit is fully legible without a backdrop. Skip rather than fail.
    test.skip(paint === null, "no WebGL context available here");
    expect(paint?.max ?? 0, "the shader drew something").toBeGreaterThan(4);
    expect(
      paint?.centreMean ?? 99,
      "it is a bezel, not a wash — the data sits in the centre",
    ).toBeLessThan(2);
  });

  /*
   * The cascade must keep moving, which is the whole reason the graph was rebuilt.
   *
   * The two tests these replaced asserted the opposite property: that a one-shot
   * `animation: … forwards` had reached its end state and held it. It had, and
   * that was the defect. The propagation played once over 400ms and then froze
   * for the rest of the session, so a screenshot and anyone who arrived a second
   * late saw a static picture with nothing to say a change had travelled.
   */
  test("the cascade keeps moving, rather than playing once and freezing", async ({ page }) => {
    await openCockpit(page, cascaded());
    await page.waitForSelector(".react-flow__edge.animated", { state: "attached" });
    // Well past any plausible one-shot duration.
    await page.waitForTimeout(1500);

    const state = await page.evaluate(() => {
      const paths = [
        ...document.querySelectorAll<SVGPathElement>(
          ".react-flow__edge.animated path.react-flow__edge-path",
        ),
      ];
      return paths.map((p) => {
        const anims = p.getAnimations();
        /*
         * Across ALL of a path's animations, not just the first.
         *
         * A lit edge carries two: `obsel-reach` draws the change arriving, once,
         * delayed by that edge's hop count, and `obsel-dash` marches for as long
         * as the mark stands. Reading `anims[0]` would read whichever the browser
         * happened to list first, and the one-shot is bounded by design.
         */
        const forever = anims.some((anim) => {
          const iterations = anim.effect?.getTiming().iterations;
          return typeof iterations === "number" ? !Number.isFinite(iterations) : false;
        });
        return {
          count: anims.length,
          forever,
          // Every animation on the path is either running or has finished its one
          // pass; none may be stuck waiting for something that will not happen.
          idle: anims.filter((anim) => anim.playState === "idle").length,
        };
      });
    });

    expect(state.length, "the cascade should light some edges").toBeGreaterThan(0);
    for (const edge of state) {
      expect(edge.count, "a lit edge must carry a running animation").toBeGreaterThan(0);
      // A cascade with no unbounded animation is the one-shot bug returning: it
      // would play through once and hold still for the rest of the session.
      expect(edge.forever, "the dash must repeat forever").toBe(true);
      expect(edge.idle).toBe(0);
    }
  });

  /*
   * The ripple, which is the moment the whole product is about.
   *
   * What is asserted is the ORDER, not the look: an edge two hops from the change
   * starts later than an edge one hop from it. The hop counts come off the marks
   * obsel wrote, so this is also a check that the picture is animating the walk
   * obsel actually performed rather than a path re-derived from the graph's shape.
   */
  test("the change spreads outward, one hop at a time", async ({ page }) => {
    await openCockpit(page, cascaded());
    await page.waitForSelector(".react-flow__edge.animated", { state: "attached" });

    const delays = await page.evaluate(() =>
      [
        ...document.querySelectorAll<SVGPathElement>(
          ".react-flow__edge.animated path.react-flow__edge-path",
        ),
      ].map((path) => {
        const style = getComputedStyle(path);
        return {
          hop: Number(style.getPropertyValue("--hop").trim()),
          // The first of the two delays is the one-shot's, which is the stagger.
          delay: Number.parseFloat(style.animationDelay.split(",")[0]),
        };
      }),
    );

    expect(delays.length).toBeGreaterThan(0);
    const byHop = new Map<number, number>();
    for (const edge of delays) {
      expect(edge.hop, "every lit edge carries the hop obsel recorded").toBeGreaterThan(0);
      byHop.set(edge.hop, edge.delay);
    }
    // The demo cascade reaches two hops, so there are two distances to compare.
    expect(byHop.size, "the demo board reaches more than one hop").toBeGreaterThan(1);
    const hops = [...byHop.keys()].sort((a, b) => a - b);
    for (let i = 1; i < hops.length; i += 1) {
      expect(
        byHop.get(hops[i])!,
        `hop ${hops[i]} must start after hop ${hops[i - 1]}`,
      ).toBeGreaterThan(byHop.get(hops[i - 1])!);
    }
  });

  /*
   * The board's colour is a claim, and the flare is not.
   *
   * `tone.ts` states the rule: amber fill if and only if a task is out of date,
   * decided by one function from the record and from nothing else. The ripple is
   * drawn by a separate element for that reason, so this asserts the separation
   * rather than the animation: remove every flare and the board still says
   * exactly the same thing.
   */
  test("the ripple is drawn over the marks, never instead of them", async ({ page }) => {
    await openCockpit(page, cascaded());
    await page.waitForSelector(".react-flow__node-task", { state: "attached" });

    const marked = await page.evaluate(() => {
      const amber = "rgb(255, 176, 32)";
      return [...document.querySelectorAll(".react-flow__node-task")].map((node) => {
        const box = node.firstElementChild as HTMLElement | null;
        const flare = node.querySelector<HTMLElement>("span[style*='--hop']");
        return {
          stale: (node.textContent ?? "").includes("out of date"),
          bar: box === null ? "" : getComputedStyle(box).borderLeftColor,
          hasFlare: flare !== null,
          amber,
        };
      });
    });

    const stale = marked.filter((node) => node.stale);
    expect(stale.length, "the demo cascade marks three tasks").toBe(3);
    for (const node of stale) {
      // The claim, painted by `nodeTone`, present whether or not anything ran.
      expect(node.bar, "an out-of-date task is amber on its own").toBe(node.amber);
      expect(node.hasFlare, "and carries a flare over it").toBe(true);
    }
    for (const node of marked.filter((entry) => !entry.stale)) {
      expect(node.hasFlare, "work that is not out of date never flares").toBe(false);
    }
  });

  test("the lit path advances between two samples, in pixels", async ({ page }) => {
    // Not just "an animation is attached": that it is actually progressing.
    await openCockpit(page, cascaded());
    await page.waitForSelector(".react-flow__edge.animated", { state: "attached" });

    const read = () =>
      page.evaluate(
        () =>
          getComputedStyle(
            document.querySelector(".react-flow__edge.animated path.react-flow__edge-path")!,
          ).strokeDashoffset,
      );

    const first = Number.parseFloat(await read());
    await page.waitForTimeout(320);
    const second = Number.parseFloat(await read());
    expect(second).not.toBeCloseTo(first, 2);
  });

  test("reduced motion stops the movement but keeps the path visible", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openCockpit(page, cascaded());
    await page.waitForSelector(".react-flow__edge.animated", { state: "attached" });

    const state = await page.evaluate(() => {
      const paths = [
        ...document.querySelectorAll<SVGPathElement>(
          ".react-flow__edge.animated path.react-flow__edge-path",
        ),
      ];
      return paths.map((p) => ({
        animations: p.getAnimations().length,
        stroke: getComputedStyle(p).stroke,
        width: getComputedStyle(p).strokeWidth,
      }));
    });

    expect(state.length).toBeGreaterThan(0);
    for (const edge of state) {
      expect(edge.animations, "no movement under reduced motion").toBe(0);
      // Which edges the change travelled along must still be legible. Cancelling
      // the animation without leaving the path drawn would hide the cascade
      // entirely, which is the failure the reduced-motion block exists to avoid.
      expect(edge.width).toBe("2px");
      expect(edge.stroke).not.toBe("none");
    }
  });
});

/**
 * The door an outside agent joins through.
 *
 * These exist because of a specific failure: the panel's contents were correct
 * and complete, and were rendered as a closed 17px line above the graph, and the
 * person who wrote them did not know they were on the page. Every test here is
 * about being findable, which is the property that was missing. `joining.ts`'s
 * own unit tests cover which steps tick; none of that is repeated here.
 */
test.describe("bring your own agent", () => {
  const panel = (page: Page) => page.locator('[aria-label="Bring your own agent"]');

  /**
   * Open the board and then this panel's tab, which is how a reader reaches it.
   *
   * The panel is one of the dock's three tabs now rather than a row under the
   * graph. That does not weaken what this file is about: every test below is
   * about the panel being findable rather than a 17px line nobody noticed, and a
   * permanently visible 13px tab label is the answer to that, where a collapsed
   * disclosure was not.
   */
  const arrive = async (
    page: Page,
    ...args: Parameters<typeof openCockpit> extends [Page, ...infer R] ? R : never
  ) => {
    const handle = await openCockpit(page, ...args);
    await openTab(page, "your agent");
    return handle;
  };

  test("is a panel with a heading, not a line somebody has to notice", async ({ page }) => {
    await arrive(page, cascaded(), finishedStep());

    const heading = panel(page).getByRole("heading", { name: "bring your own agent" });
    await expect(heading).toBeVisible();

    // The measurement that motivated the work, kept as the assertion. The old
    // disclosure was 12px type in a 17px row. A heading below either number is
    // this regression coming back.
    const size = await heading.evaluate((node) => ({
      font: Number.parseFloat(getComputedStyle(node).fontSize),
      height: Math.round(node.getBoundingClientRect().height),
    }));
    expect(size.font, "the heading is back to disclosure type").toBeGreaterThan(12);
    expect(size.height, "the heading is back to a single thin row").toBeGreaterThan(17);
  });

  test("says nobody has joined, and keeps the steps folded, on obsel's own board", async ({
    page,
  }) => {
    // The state the board is in on camera. The heading is visible; the four
    // steps are not painted.
    await arrive(page, cascaded(), finishedStep());

    await expect(panel(page).getByText("nobody has joined yet")).toBeVisible();
    await expect(panel(page).getByText("how an agent joins")).toBeVisible();
    // The step rows, which are the prose the fold exists to hold back. In the
    // DOM, painted by nobody.
    await expect(panel(page).locator("li[data-done]").first()).toBeHidden();
  });

  test("opens itself, and counts the steps, once somebody's agent is on the board", async ({
    page,
  }) => {
    await arrive(page, visiting(), finishedStep());

    // Three of four: registered, announced and reported have happened for the
    // visitor's own tasks, and no change has landed on their data yet.
    await expect(panel(page).getByText("3 of 4")).toBeVisible();
    await expect(panel(page).getByText("clean expenses", { exact: false }).first()).toBeVisible();

    const ticks = await panel(page).evaluate((node) =>
      [...node.querySelectorAll("li[data-done]")].map((li) => li.getAttribute("data-done")),
    );
    expect(ticks).toEqual(["true", "true", "true", "false"]);
  });

  test("does not count obsel's own demonstration as somebody having joined", async ({ page }) => {
    // The whole four-task demo, finished and flagged. None of it is the reader's
    // agent, so none of it is their progress, and a panel that ticked here would
    // be congratulating them on work they did not do.
    await arrive(page, cascaded(), finishedStep());
    await expect(panel(page).getByText("nobody has joined yet")).toBeVisible();
    await expect(panel(page).getByText(/\d of 4/)).toBeHidden();
  });

  test("hands over this machine's real command, not a placeholder path", async ({ page }) => {
    await arrive(page, visiting(), finishedStep());

    // `idle()` and friends carry the command the activity route builds from this
    // machine's own paths. A fixture path would be a command that fails.
    const command = panel(page).locator("code").first();
    await expect(command).toContainText("claude mcp add obsel");
    await expect(panel(page).getByRole("button", { name: "copy" })).toBeVisible();
  });

  test("a reader who opens it is not overruled by the next poll", async ({ page }) => {
    // The other half of the toggle fix. The board re-renders every second, and
    // the derivation says folded on this board, so a panel that took the derived
    // value back would shut under somebody a second after they opened it.
    const { serve } = await arrive(page, cascaded(), finishedStep());
    const steps = panel(page).locator("li[data-done]").first();
    await expect(steps).toBeHidden();

    await panel(page).getByText("how an agent joins").click();
    await expect(steps).toBeVisible();

    // Three polls' worth of fresh reads, all still saying folded.
    serve(calm());
    serve(cascaded());
    await page.waitForTimeout(2500);
    await expect(steps).toBeVisible();
  });

  test("stops counting a visitor's progress the moment the read fails", async ({ page }) => {
    /*
     * The same rule the ribbon follows: a number obsel cannot currently see is
     * withheld, never held at its last value. This panel is a claim about
     * somebody's agent, and "3 of 4" beside a broken connection is the same
     * false all-clear the rest of the board refuses to give.
     */
    const { serve } = await arrive(page, visiting(), finishedStep());
    await expect(panel(page).getByText("3 of 4")).toBeVisible();

    serve("fail");
    await expect(obselAlert(page)).toBeVisible();
    await expect(panel(page).getByText("nobody has joined yet")).toBeVisible();
    await expect(panel(page).locator("li[data-done]").first()).toBeHidden();
  });
});

/**
 * The panel that registers somebody's own tables, which is the one place on the
 * board that writes.
 *
 * What is checked here is the half `mine.ts`'s unit tests cannot see: that the
 * form is findable, that the body reaching `/api/tasks/register` is the one the
 * MCP door would have sent, and that a draft obsel would refuse never leaves the
 * browser. Which drafts are refused, and why, is covered in
 * `tests/cockpit-mine.test.ts` and is not repeated.
 *
 * `openCockpit` intercepts the register route; its header says what that costs.
 * No browser test here proves a registration reaches DataHub.
 */
test.describe("bring your own data", () => {
  const panel = (page: Page) => page.locator('[aria-label="Bring your own data"]');
  const open = (page: Page) => panel(page).getByText("add a task").click();

  /** Open the board and then this panel's tab. See the sibling describe above. */
  const arrive = async (
    page: Page,
    ...args: Parameters<typeof openCockpit> extends [Page, ...infer R] ? R : never
  ) => {
    const handle = await openCockpit(page, ...args);
    await openTab(page, "your data");
    return handle;
  };

  test("is a panel with a heading, beside the door for an agent", async ({ page }) => {
    await arrive(page, cascaded(), finishedStep());

    await expect(panel(page).getByRole("heading", { name: "bring your own data" })).toBeVisible();

    /*
     * Next to the door for an agent, which is the pair the README puts in this
     * order.
     *
     * This used to read the two panels' positions among the board's sections,
     * because they were consecutive rows under the graph. They are two tabs of
     * one dock now, so at most one of them is rendered at a time and an ordering
     * of sections cannot express the pairing. The tab strip is where the
     * adjacency lives, so that is what is asserted: same order, same claim, read
     * off the control that now carries it.
     */
    const tabs = await page.evaluate(() =>
      [...document.querySelectorAll('[role="tab"]')].map((node) => node.textContent?.trim() ?? ""),
    );
    const agent = tabs.indexOf("your agent");
    expect(agent).toBeGreaterThanOrEqual(0);
    expect(tabs.indexOf("your data")).toBe(agent + 1);
  });

  test("keeps the form folded, and counts nothing, on obsel's own board", async ({ page }) => {
    // The state the board is in on camera. The heading is painted; the four
    // fields are not, and there is no count, because a count of zero says
    // nothing the empty list does not.
    await arrive(page, cascaded(), finishedStep());

    await expect(panel(page).getByText("add a task")).toBeVisible();
    await expect(panel(page).locator("input").first()).toBeHidden();
    await expect(panel(page).getByText(/of yours/)).toBeHidden();
  });

  test("lists your own tasks with the identifiers your agent has to use", async ({ page }) => {
    await arrive(page, visiting(), finishedStep());
    await open(page);

    await expect(panel(page).getByText("2 of yours")).toBeVisible();

    /*
     * The identifiers, not the humanised names the rest of the board shows.
     * `clean_expenses` is what the reader typed and what their agent passes to
     * `report_complete`; a row reading "reads clean expenses" would be unusable
     * for the one thing this list is for.
     */
    const rows = await panel(page).evaluate((node) =>
      [...node.querySelectorAll("li[data-reported]")].map((li) => ({
        reported: li.getAttribute("data-reported"),
        text: (li as HTMLElement).innerText.replace(/\s+/g, " "),
      })),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].reported).toBe("true");
    expect(rows[0].text).toContain("reads expenses_csv, writes clean_expenses");
    // Registered and never reported. obsel has no fingerprint for it, so it has
    // nothing to compare against next time, and the row says so rather than
    // showing a tick that would mean obsel was watching it.
    expect(rows[1].reported).toBe("false");
    expect(rows[1].text).toContain("nothing reported yet");
  });

  test("sends obsel exactly the body the MCP door would have sent", async ({ page }) => {
    const { registrations } = await arrive(page, cascaded(), finishedStep());
    await open(page);

    await panel(page).locator("input").nth(0).fill("clean_expenses");
    await panel(page).locator("input").nth(1).fill("expenses_csv");
    await panel(page).locator("input").nth(2).fill("clean_expenses");
    await panel(page).locator("input").nth(3).fill("Expense cleaner");
    await panel(page).getByRole("button", { name: "register it" }).click();

    // Short names, not URNs. The route builds the URNs so the naming convention
    // lives in one place, and this board is not entitled to a second opinion.
    await expect
      .poll(() => registrations)
      .toEqual([
        {
          name: "clean_expenses",
          reads: ["expenses_csv"],
          writes: ["clean_expenses"],
          title: "Expense cleaner",
        },
      ]);

    // Cleared, and no row invented. The task appears when `/api/swarm` has it,
    // which this fixture's snapshot does not, so the list stays empty: an
    // optimistic row would be a claim obsel had not verified.
    await expect(panel(page).locator("input").nth(0)).toHaveValue("");
    await expect(panel(page).getByText(/of yours/)).toBeHidden();
  });

  test("splits a comma-separated list of tables into separate names", async ({ page }) => {
    const { registrations } = await arrive(page, cascaded(), finishedStep());
    await open(page);

    await panel(page).locator("input").nth(0).fill("joined_report");
    await panel(page).locator("input").nth(1).fill("clean_expenses, monthly_totals");
    await panel(page).locator("input").nth(2).fill("joined_report");
    await panel(page).getByRole("button", { name: "register it" }).click();

    await expect
      .poll(() => registrations.at(0)?.reads)
      .toEqual(["clean_expenses", "monthly_totals"]);
  });

  test("a draft obsel would refuse never leaves the browser", async ({ page }) => {
    const { registrations } = await arrive(page, cascaded(), finishedStep());
    await open(page);

    // A task that writes nothing. The HTTP route accepts this and then has
    // nothing to say about it forever, so the form is the only thing that says so.
    await panel(page).locator("input").nth(0).fill("watches_nothing");
    await expect(panel(page).getByText(/Name the table this task writes/)).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "register it" })).toBeDisabled();

    // A name that would build a URN nothing can parse back, for the same reason.
    await panel(page).locator("input").nth(2).fill("out");
    await panel(page).locator("input").nth(0).fill("clean,expenses");
    await expect(panel(page).getByRole("button", { name: "register it" })).toBeDisabled();

    await panel(page).locator("input").nth(0).fill("clean_expenses");
    await expect(panel(page).getByRole("button", { name: "register it" })).toBeEnabled();

    expect(registrations, "a refused draft was sent anyway").toEqual([]);
  });

  test("shows obsel's own refusal rather than claiming the task landed", async ({ page }) => {
    const { refuseRegistration } = await arrive(page, cascaded(), finishedStep());
    await open(page);

    refuseRegistration(500, "DataHub is not reachable");

    await panel(page).locator("input").nth(0).fill("clean_expenses");
    await panel(page).locator("input").nth(2).fill("clean_expenses");
    await panel(page).getByRole("button", { name: "register it" }).click();

    await expect(panel(page).getByText(/DataHub is not reachable/)).toBeVisible();
    // The draft survives a refusal. Clearing it would make the reader retype
    // four fields to retry something obsel might accept a second later.
    await expect(panel(page).locator("input").nth(0)).toHaveValue("clean_expenses");
  });

  test("stays open after a registration, rather than shutting on the reader", async ({ page }) => {
    /*
     * Found by registering a task in a real browser, not by reading the code.
     *
     * `mine.ts` paints the form only on an empty board, so the first successful
     * registration flips that derivation to folded, and `chosen ?? expanded`
     * does not save it: the reader's panel was already open when they found it,
     * so their choice matched the derivation and nothing was recorded. The next
     * poll then shut the panel, hiding the confirmation and the new row, under
     * somebody about to register the second half of their pipeline.
     */
    const { serve } = await arrive(page, empty(), finishedStep());
    const field = panel(page).locator("input").first();
    // Painted, because there is nothing on this board at all.
    await expect(field).toBeVisible();

    await panel(page).locator("input").nth(0).fill("clean_expenses");
    await panel(page).locator("input").nth(2).fill("clean_expenses");
    await panel(page).getByRole("button", { name: "register it" }).click();
    await expect(panel(page).getByText(/Registered\./)).toBeVisible();

    // The board is no longer empty, which is what used to close it.
    serve(visiting());
    await expect(panel(page).getByText("2 of yours")).toBeVisible();
    await expect(field, "the panel shut itself after a registration").toBeVisible();
    await expect(panel(page).getByText(/Registered\./)).toBeVisible();

    // Closing it by hand still hands control back to the derivation.
    await panel(page).getByText("hide this").click();
    await expect(field).toBeHidden();
  });

  test("a reader who opens it is not overruled by the next poll", async ({ page }) => {
    // The same toggle rule the joining panel keeps, and it has to be kept
    // separately: this panel holds a half-typed form, so a fold that took the
    // derived value back every second would discard what somebody was writing.
    const { serve } = await arrive(page, cascaded(), finishedStep());
    const field = panel(page).locator("input").first();
    await expect(field).toBeHidden();

    await open(page);
    await field.fill("half_typed");

    serve(calm());
    serve(cascaded());
    await page.waitForTimeout(2500);
    await expect(field).toBeVisible();
    await expect(field).toHaveValue("half_typed");
  });
});

/**
 * A board holding exactly one task, rendered.
 *
 * `tests/cockpit-guide.test.ts` and `tests/cockpit-timing.test.ts` decide the
 * wording at a count of one and are not repeated here. What only a browser shows
 * is the whole board agreeing with itself: the headline, the screen-reader live
 * region and the write-back cell are three separate derivations of one count, and
 * nothing but the page puts them together in front of a reader.
 *
 * The state was unreachable until the bring-your-own-data panel registered tasks
 * one at a time, and "1 agents ready to run" was on a real screen before it.
 */
test.describe("a swarm of one", () => {
  test("says one agent, in every sentence that counts it", async ({ page }) => {
    await openCockpit(page, justOne("waiting"), finishedStep());

    const board = page.locator("main");
    await expect(board.getByRole("heading", { name: "1 agent ready to run" })).toBeVisible();

    // Nothing anywhere may say "1 agents", in any of the three states, including
    // the live region a screen reader is the only thing that reads.
    for (const state of ["waiting", "finished", "flagged"] as const) {
      await openCockpit(page, justOne(state), finishedStep());
      const text = await board.evaluate((node) => {
        const main = node as HTMLElement;
        // innerText misses the visually-hidden live region, which is exactly the
        // sentence most likely to be left plural because nobody sees it.
        return `${main.innerText} ${main.querySelector('[aria-live="polite"]')?.textContent ?? ""}`;
      });
      expect(text, `"1 agents" on the ${state} board`).not.toMatch(/\b1 agents\b/);
      expect(text, `"all 1" on the ${state} board`).not.toMatch(/\ball 1\b/);
      // The other half of the rule: a singular noun must not be glued to a plural
      // ratio. "1 of 1 finished agent is" is right; "1 of 3 finished agent" is the
      // bug this guards.
      expect(text, `a singular noun after a plural ratio on ${state}`).not.toMatch(
        /\b1 of ([2-9]|\d\d+) finished agent\b(?!s)/,
      );
    }
  });

  test("the settled board words its whole-swarm claim rather than counting to one", async ({
    page,
  }) => {
    await openCockpit(page, justOne("finished"), finishedStep());
    await expect(
      page.locator("main").getByRole("heading", { name: /the one agent finished/ }),
    ).toBeVisible();
  });

  test("the flagged board agrees its noun with finished and its verb with marked", async ({
    page,
  }) => {
    await openCockpit(page, justOne("flagged"), finishedStep());
    await expect(
      page.locator("main").getByRole("heading", { name: "1 of 1 finished agent is out of date" }),
    ).toBeVisible();
  });
});

test.describe("guide", () => {
  test("an empty swarm offers register, and the click launches the real step", async ({ page }) => {
    const { launches } = await openCockpit(page, empty());

    const button = page.getByRole("button", { name: /Set up the demo agents/ });
    await expect(button).toBeVisible();
    await button.click();

    await expect.poll(() => launches).toEqual(["register"]);
  });

  test("a settled swarm offers the two experiments", async ({ page }) => {
    await openCockpit(page, calm());

    await expect(page.getByRole("button", { name: /Run the orders cleaner again/ })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Change one agent's instructions/ }),
    ).toBeVisible();
  });

  test("a cascaded swarm explains the flags and offers the re-run and reset, never change", async ({
    page,
  }) => {
    await openCockpit(page, cascaded());

    // The headline now leads the board, and the subline names what moved. The
    // sentence about the transitively reached tasks is gone: the graph draws that
    // reach as an amber path travelling outward, continuously.
    await expect(
      page.getByRole("heading", { name: "3 of 4 finished agents are out of date" }),
    ).toBeVisible();
    await expect(page.getByText(/clean orders lost the column order_total/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Run the orders cleaner again/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Reset and start over/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Change one agent's instructions/ })).toHaveCount(
      0,
    );
  });

  test("a broken prerequisite turns the guide into preparation with the exact fix", async ({
    page,
  }) => {
    await openCockpit(page, calm(), codexSignedOut());

    await expect(page.getByRole("heading", { name: /thing.? to set up/ })).toBeVisible();
    await expect(page.getByText("codex login", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Run the orders cleaner again/ })).toHaveCount(0);
  });

  test("while a step runs the buttons go away and its own output streams", async ({ page }) => {
    await openCockpit(page, calm(), runningStep("rerun-same"));

    // The subline names the step; the log block is labelled for what it is. Both
    // are asserted, because the previous version said the step name twice.
    await expect(page.getByText("The unchanged re-run is running now")).toBeVisible();
    await expect(page.getByText("live output")).toBeVisible();
    await expect(page.getByText("rerun-same: started")).toBeVisible();
    await expect(page.getByRole("button", { name: /Run the orders cleaner again/ })).toHaveCount(0);
  });

  /*
   * The tour: the window that replaced the rail, the sentence and the rings.
   *
   * `tests/cockpit-guide.test.ts` decides which step a given board lands on,
   * exhaustively. What only a browser shows is that the window is there, that
   * it points at the right region of the page, that it can be picked up and
   * moved, and above all that an action step **cannot be skipped**: there is no
   * control on it that advances past something the board has not done.
   */
  const win = (page: Page) => page.locator('section[aria-label="guide"]').last();
  const openTour = async (page: Page) => {
    await page.getByRole("button", { name: "start the guide" }).click();
    await expect(win(page).getByRole("heading")).toBeVisible();
  };
  /** Which region of the board is currently lit, by its own tour handle. */
  const lit = (page: Page) =>
    page.evaluate(() => {
      const node = document.querySelector('[class*="lit"]');
      if (node === null) return null;
      return node.getAttribute("data-tour") ?? node.getAttribute("data-tour-action") ?? "unknown";
    });

  test("the way in is obvious on a first visit and quiet afterwards", async ({ page }) => {
    // A guide nobody finds is how the three attempts before this one failed, so
    // the opener is lit and says what it is. It asks once: saying not now writes
    // the same record opening it does, and the emphasis never comes back.
    await openCockpit(page, empty(), idle());

    const opener = page.getByRole("button", { name: "start the guide" });
    await expect(opener).toBeVisible();
    await expect(opener).toHaveAttribute("data-fresh", "true");
    await expect(page.getByText("new here?")).toBeVisible();

    await page.getByRole("button", { name: "not now" }).click();
    await expect(opener).toHaveAttribute("data-fresh", "false");
    await expect(page.getByText("new here?")).toHaveCount(0);

    // And it survives a reload, because it is a fact about the person rather
    // than about the board.
    await page.reload();
    await expect(page.getByRole("button", { name: "start the guide" })).toHaveAttribute(
      "data-fresh",
      "false",
    );
  });

  test("it teaches the screen one region at a time, and lights each one", async ({ page }) => {
    await openCockpit(page, cascaded(), finishedStep());
    await openTour(page);

    // Chapter one, in order, with the glow following the explanation.
    for (const [heading, region] of [
      ["what this screen is", "guide"],
      ["the agents and their tables", "graph"],
      ["what obsel is doing", "trace"],
      ["the two measurements", "numbers"],
    ] as const) {
      await expect(win(page).getByRole("heading", { name: heading })).toBeVisible();
      expect(await lit(page), heading).toBe(region);
      await win(page).getByRole("button", { name: "next", exact: true }).click();
    }
  });

  /*
   * The highlight has to be drawn INSIDE the region it points at.
   *
   * This is a regression test for a bug that shipped. The glow was an `outline`
   * at a 4px offset with a shadow at `inset: -5px`, both drawn outside the box,
   * which was right while the board was a column of panels with gaps between
   * them. The canvas-and-dock layout put every region flush inside a container
   * that clips its overflow, so all of it was cut away: measured on the rebuilt
   * board, four of the six highlights a reader passes rendered nothing at all,
   * and the tour spent four steps telling somebody to look at a region it was
   * not marking.
   *
   * What is asserted is the property rather than the pixels: nothing outside the
   * target's own box, because outside the box is where the clipping is.
   */
  test("it marks the region from inside, where nothing can clip it", async ({ page }) => {
    await openCockpit(page, cascaded(), finishedStep());
    await openTour(page);

    for (const heading of [
      "what this screen is",
      "the agents and their tables",
      "what obsel is doing",
      "the two measurements",
    ] as const) {
      await expect(win(page).getByRole("heading", { name: heading })).toBeVisible();

      const ring = await page.evaluate(() => {
        const node = document.querySelector('[class*="lit"]');
        if (node === null) return null;
        const own = getComputedStyle(node);
        const after = getComputedStyle(node, "::after");
        const box = node.getBoundingClientRect();

        // The nearest ancestor that clips, and whether the target is inside it.
        let clip: DOMRect | null = null;
        let up = node.parentElement;
        while (up !== null && up !== document.documentElement) {
          const style = getComputedStyle(up);
          if (`${style.overflow}${style.overflowX}${style.overflowY}`.includes("hidden")) {
            clip = up.getBoundingClientRect();
            break;
          }
          up = up.parentElement;
        }

        return {
          /*
           * The style, not the width. A browser reports `outline-width` as its
           * own `medium` default (3px) even when nothing is painted, so the
           * width says nothing about whether a ring is being drawn outside the
           * box; the style is what decides that.
           */
          outline: own.outlineStyle,
          shadow: after.boxShadow,
          // The ring is at the target's own edges, so it is visible exactly when
          // the target is: no part of the box may fall outside what clips it.
          boxVisible:
            clip === null ||
            (box.left >= clip.left - 1 &&
              box.right <= clip.right + 1 &&
              box.top >= clip.top - 1 &&
              box.bottom <= clip.bottom + 1),
          onScreen: box.width > 0 && box.height > 0,
        };
      });

      expect(ring, heading).not.toBeNull();
      expect(ring!.onScreen, `${heading}: the lit region has a size`).toBe(true);
      // An outline is the treatment that broke. Anything painted there is that
      // bug on its way back.
      expect(ring!.outline, `${heading}: nothing is drawn outside the box`).toBe("none");
      expect(ring!.shadow, `${heading}: the ring is drawn inside the box`).toContain("inset");
      expect(ring!.boxVisible, `${heading}: the lit region is not clipped away`).toBe(true);

      await win(page).getByRole("button", { name: "next", exact: true }).click();
    }
  });

  /*
   * The window opens in the corner the dock is not using.
   *
   * It used to open bottom-right unconditionally, which was a free corner while
   * the board was a column and is a panel now: on the rebuilt board it landed on
   * top of the dock and covered the two measured numbers pinned at its foot,
   * which are the figures the demonstration exists to establish.
   */
  test("the window opens clear of the panel, on whichever side that is", async ({ page }) => {
    await openCockpit(page, cascaded(), finishedStep());
    await openTour(page);

    const overlap = async () =>
      page.evaluate(() => {
        const card = document.querySelectorAll('section[aria-label="guide"]');
        const window_ = card[card.length - 1]?.getBoundingClientRect();
        const dock = document.querySelector("[data-dock]")?.getBoundingClientRect();
        if (window_ === undefined || dock === undefined) return null;
        const wide = Math.min(window_.right, dock.right) - Math.max(window_.left, dock.left);
        const tall = Math.min(window_.bottom, dock.bottom) - Math.max(window_.top, dock.top);
        return {
          area: Math.max(0, wide) * Math.max(0, tall),
          side: document.querySelector("[data-dock]")?.getAttribute("data-dock"),
        };
      });

    const right = await overlap();
    expect(right?.side).toBe("right");
    expect(right?.area, "the window must not cover the panel").toBe(0);

    // And it follows the panel when a reader moves it to the other edge.
    await page.getByRole("button", { name: /move the panel to the left/i }).click();
    await page.waitForTimeout(500);
    const left = await overlap();
    expect(left?.side).toBe("left");
    expect(left?.area, "still clear once the panel has moved").toBe(0);
  });

  /*
   * The rule the whole tour rests on, and the only one worth a browser test on
   * its own: an action step has no way to be skipped. A tour that could be paged
   * past an action would sooner or later be describing a board that does not
   * exist, which is the one thing this repository refuses everywhere.
   */
  test("an action step offers no way past it until the board has done it", async ({ page }) => {
    const { serve } = await openCockpit(page, empty(), idle());
    await openTour(page);

    // Straight to the first action.
    for (let i = 0; i < 4; i += 1) {
      await win(page).getByRole("button", { name: "next", exact: true }).click();
    }
    await expect(
      win(page).getByRole("heading", { name: "put the agents on the board" }),
    ).toBeVisible();

    // It quotes the real control by the label the board is painting on it, and
    // there is no next.
    await expect(win(page).getByText("Set up the demo agents")).toBeVisible();
    await expect(win(page).getByText("press this, glowing on the board")).toBeVisible();
    await expect(win(page).getByText("waiting for you")).toBeVisible();
    await expect(win(page).getByRole("button", { name: "next", exact: true })).toHaveCount(0);

    // And the board doing the thing is what moves it on. Nobody presses anything
    // in the window: the next poll finds tasks registered and it advances itself.
    serve(calm());
    await expect(
      win(page).getByRole("heading", { name: /let them work|now change something/ }),
    ).toBeVisible({
      timeout: 8_000,
    });
  });

  test("a board already past a step opens the tour where the board actually is", async ({
    page,
  }) => {
    // Nothing about chapter two is stored, so somebody arriving at a flagged
    // board is put at the act that genuinely comes next rather than at step one
    // of the run.
    await openCockpit(page, cascaded(), finishedStep());
    await openTour(page);
    for (let i = 0; i < 4; i += 1) {
      await win(page).getByRole("button", { name: "next", exact: true }).click();
    }
    await expect(win(page).getByRole("heading", { name: "look at what it reached" })).toBeVisible();
  });

  /*
   * The case that would have ruined the demonstration on camera.
   *
   * A repaired board is clean and finished, which is exactly what a board that
   * only ever ran looks like, so "has anything been changed" reads false again
   * the moment the repair lands. Without the step record behind the repair act,
   * a judge who had just finished the whole walk would be dragged back to "now
   * change something upstream" on a board where they already had.
   */
  test("a finished walk stays finished rather than asking for the change again", async ({
    page,
  }) => {
    /*
     * Pressed until it stops offering a way forward, which is also the check
     * that the tour terminates rather than looping.
     *
     * The settle is not padding. Cards swap through `AnimatePresence` with
     * `mode="wait"`, so for about a sixth of a second between steps the outgoing
     * card has gone and the incoming one has not arrived: a bare count taken in
     * that window reads zero and this loop stops halfway, reporting whichever
     * step it happened to be on. The first version of this did exactly that, and
     * passed until it did not.
     */
    const toTheEnd = async (): Promise<string> => {
      const next = () => win(page).getByRole("button", { name: "next", exact: true });
      for (let i = 0; i < 15; i += 1) {
        await expect(win(page).getByRole("heading").first()).toBeVisible();
        if ((await next().count()) === 0) break;
        await next().click();
        await page.waitForTimeout(450);
      }
      return (await win(page).getByRole("heading").first().textContent()) ?? "";
    };

    await openCockpit(page, calm(), walked());
    await openTour(page);
    // The erasure tab, which is where the tour ends: the same graph, asked the
    // second question obsel answers with it.
    expect(await toTheEnd()).toBe("the same graph, asked a different question");

    /*
     * The same board with nothing behind it stops at the change, because on
     * that one the change genuinely has not happened. Stopping is the point: an
     * action step offers no way past itself, so this is where a reader waits
     * until they press the real button.
     */
    await openCockpit(page, calm(), idle());
    await openTour(page);
    expect(await toTheEnd()).toBe("now change something upstream");
  });

  test("the window can be picked up and put somewhere else", async ({ page }) => {
    await openCockpit(page, cascaded(), finishedStep());
    await openTour(page);

    const before = await win(page).boundingBox();
    const bar = win(page).locator("div").first();
    const grab = await bar.boundingBox();
    if (before === null || grab === null) throw new Error("the window did not render");

    /*
     * Carried towards the middle of the frame, whichever edge it started at.
     *
     * It used to be dragged left unconditionally, because it always opened in
     * the bottom-right corner and left was the only direction with room. It now
     * opens on the side the dock is not using, so the room is on the other side
     * and a fixed direction would be dragging it into a wall: the constraint
     * would hold it still and the test would read that as the drag being broken.
     */
    const inwards = before.x < page.viewportSize()!.width / 2 ? 120 : -120;
    await page.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2);
    await page.mouse.down();
    // In steps: motion begins a drag on movement, and one jump can be delivered
    // as a single event it treats as a click.
    await page.mouse.move(grab.x + grab.width / 2 + inwards, grab.y + grab.height / 2 - 200, {
      steps: 12,
    });
    await page.mouse.up();
    await page.waitForTimeout(300);

    const after = await win(page).boundingBox();
    if (after === null) throw new Error("the window vanished mid-drag");
    expect(Math.round(Math.abs(after.x - before.x)), "it moved sideways").toBeGreaterThan(80);
    expect(Math.round(before.y - after.y), "it moved up").toBeGreaterThan(150);
  });

  test("escape closes it, and the opener brings it back where it was left", async ({ page }) => {
    await openCockpit(page, cascaded(), finishedStep());
    await openTour(page);
    await win(page).getByRole("button", { name: "next", exact: true }).click();
    await expect(
      win(page).getByRole("heading", { name: "the agents and their tables" }),
    ).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator('section[aria-label="guide"]')).toHaveCount(1);
    // And nothing is left lit on the board behind it.
    expect(await lit(page)).toBeNull();

    await page.getByRole("button", { name: "start the guide" }).click();
    await expect(
      win(page).getByRole("heading", { name: "the agents and their tables" }),
    ).toBeVisible();
  });

  test("the reveal runs once on arrival, and not again on every poll", async ({ page }) => {
    /*
     * The board re-reads once a second and the guide is recomputed from each
     * snapshot, so an entrance driven by render would replay every second: a
     * flicker under the largest text on screen, forever. `guide-panel.tsx` keys
     * the block on the stage, which is what confines the entrance to a real
     * transition.
     *
     * **Sampled every frame, and it has to be.** Two earlier versions of this
     * test measured the wrong thing. `expect.poll` widened its interval and
     * missed a half-second entrance between two samples; then an
     * `animationstart` counter worked while the entrance was CSS keyframes and
     * would silently count zero now that `motion` drives it through the Web
     * Animations API instead. A `requestAnimationFrame` loop recording every
     * distinct animation object under the guide sees both kinds, and nothing
     * lasting more than a frame can hide from it.
     */
    await page.addInitScript(() => {
      const seen = new WeakSet<Animation>();
      const state = { count: 0 };
      (window as unknown as { obselReveals: { count: number } }).obselReveals = state;
      const tick = (): void => {
        const guide = document.querySelector('[aria-label="guide"]');
        if (guide !== null) {
          for (const animation of guide.getAnimations({ subtree: true })) {
            if (!seen.has(animation)) {
              seen.add(animation);
              state.count += 1;
            }
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const reveals = () =>
      page.evaluate(
        () => (window as unknown as { obselReveals: { count: number } }).obselReveals.count,
      );

    const { serve } = await openCockpit(page, calm(), finishedStep());

    // It runs on arrival. Without this the two assertions below would pass just
    // as well for a reveal that never runs at all.
    await expect.poll(reveals).toBeGreaterThan(0);

    /*
     * One entrance is several animations — the headline, the line under it, and
     * a button each — spread over about half a second by the stagger. Counting
     * before they have all begun compares the tail of this entrance against
     * itself, which is what an earlier version of this did.
     */
    await page.waitForTimeout(1_500);
    const onArrival = await reveals();

    // Three polls later, with the stage unchanged, it has not run again.
    await page.waitForTimeout(3_000);
    expect(await reveals()).toBe(onArrival);

    // And a genuine change of stage does start it again.
    serve(cascaded());
    await expect.poll(reveals, { timeout: 8_000 }).toBeGreaterThan(onArrival);
  });

  test.describe("with motion turned down", () => {
    // Through `contextOptions`, which is where this version's types put it.
    test.use({ contextOptions: { reducedMotion: "reduce" } });

    test("the guide is a finished picture rather than a hurried animation", async ({ page }) => {
      /*
       * Arriving finished is not the same as arriving quickly, and both the CSS
       * and the JavaScript halves have got this wrong at some point.
       * `globals.css` shortens every duration to 0.01ms, which still leaves an
       * element whose end state lives inside a keyframe having to run to reach
       * it; motion's own reduced-motion handling keeps opacity transitions,
       * which is still an entrance. `guide-panel.tsx` passes no animation props
       * at all under the preference, so the end state is the only state these
       * elements are ever given, and this checks that it did.
       */
      await openCockpit(page, cascaded(), finishedStep());

      const headline = page.getByRole("heading", {
        name: "3 of 4 finished agents are out of date",
      });
      await expect(headline).toBeVisible();
      const settled = await headline.evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          opacity: style.opacity,
          transform: style.transform,
          animation: style.animationName,
          // Nothing may be in flight, whichever engine would have driven it.
          animating: node.getAnimations().length,
        };
      });
      expect(settled).toEqual({
        opacity: "1",
        transform: "none",
        animation: "none",
        animating: 0,
      });
    });

    test("the tour window arrives finished, and can still be dragged", async ({ page }) => {
      /*
       * Two halves, and only one of them is decoration. The window's entrance,
       * its card transitions and the glow are animation and must be gone: the
       * end state has to be the only state they are ever given, because
       * `globals.css` cuts durations to 0.01 ms and a keyframe reached only by
       * running is not reached at all.
       *
       * Dragging is not decoration. It is how somebody moves a window off the
       * thing they are trying to read, and turning it off under this preference
       * would take away an ability rather than a flourish.
       */
      await openCockpit(page, cascaded(), finishedStep());
      await page.getByRole("button", { name: "start the guide" }).click();

      const frame = page.locator('section[aria-label="guide"]').last();
      await expect(frame.getByRole("heading")).toBeVisible();

      const state = await frame.evaluate((node) => ({
        opacity: getComputedStyle(node).opacity,
        transform: getComputedStyle(node).transform,
        animating: node.getAnimations({ subtree: true }).length,
        glowAnimating:
          document.querySelector('[class*="lit"]')?.getAnimations({ subtree: true }).length ?? -1,
      }));
      expect(state.opacity).toBe("1");
      expect(state.transform).toBe("none");
      expect(state.animating, "nothing in flight in the window").toBe(0);
      expect(state.glowAnimating, "the glow is lit, not breathing").toBe(0);

      const before = await frame.boundingBox();
      const bar = frame.locator("div").first();
      const grab = await bar.boundingBox();
      if (before === null || grab === null) throw new Error("the window did not render");
      // Towards the middle, whichever edge it opened against. See the sibling
      // drag test: which way it has room depends on where the dock is.
      const inwards = before.x < page.viewportSize()!.width / 2 ? 140 : -140;
      await page.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2);
      await page.mouse.down();
      await page.mouse.move(grab.x + grab.width / 2 + inwards, grab.y + grab.height / 2, {
        steps: 12,
      });
      await page.mouse.up();
      await page.waitForTimeout(200);

      const after = await frame.boundingBox();
      if (after === null) throw new Error("the window vanished mid-drag");
      expect(Math.round(Math.abs(after.x - before.x)), "still draggable").toBeGreaterThan(100);
    });
  });
});

test.describe("what obsel is doing", () => {
  test("the coordinator's steps render in the order it performed them", async ({ page }) => {
    await openCockpit(page, cascaded(), idle(), cascadeSteps());

    // Every step, in a browser, from the same shape `/api/trace` serves.
    await expect(page.getByText("Orders cleaner finished")).toBeVisible();
    await expect(page.getByText("columns changed, values did not")).toBeVisible();
    await expect(page.getByText("walked lineage from clean orders")).toBeVisible();
    await expect(page.getByText("marked Daily revenue out of date")).toBeVisible();

    /*
     * Scoped to the panel by its label, not `main ol li`.
     *
     * The broad selector meant "the trace panel's steps" only for as long as this
     * panel owned the one ordered list on the board. The joining panel added a
     * second, and four assertions here started counting its four steps as
     * coordinator steps — 21 where 17 were expected. They were never assertions
     * about the page's lists; they were always about this panel.
     *
     * Oldest first. A cascade only makes sense read forwards — the comparison that
     * found the change, then the walk, then the marks it caused — so a panel that put
     * the newest on top would show every mark above its own cause. Asserted on laid
     * out positions rather than on DOM order, because a `column-reverse` would satisfy
     * one and not the other.
     *
     * Pass headings are excluded, because a heading is not a step. Each one is
     * `sticky` so it stays visible while its group scrolls, which means its position
     * is deliberately detached from the list's flow: once its group has scrolled past,
     * it sits below rows that precede it. Measured on the laptop viewport, the
     * positions came out [554, 509, 555, …] for a list that was in perfect order, and
     * `offsetTop` reports the same displacement in Chromium rather than the layout
     * position. What must be ordered is the steps.
     */
    const tops = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[aria-label="What obsel is doing"] ol li')]
        .filter((li) => getComputedStyle(li).position !== "sticky")
        .map((li) => Math.round(li.getBoundingClientRect().top)),
    );
    expect(tops.length).toBeGreaterThan(1);
    expect([...tops].sort((a, b) => a - b)).toEqual(tops);
  });

  test("the newest step is the one on screen, not the oldest", async ({ page }) => {
    await openCockpit(page, cascaded(), idle(), cascadeSteps());

    // The panel is short and the steps overflow it, so this is only true if the
    // list is scrolled to its end. Unpinned it opens on step 1 and the step that
    // matters — the one obsel just took — is the one guaranteed to be hidden.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const list = document.querySelector('[aria-label="What obsel is doing"] ol');
          if (list === null) return null;
          return list.scrollHeight - list.scrollTop - list.clientHeight;
        }),
      )
      .toBeLessThanOrEqual(48);
  });

  test("separate judgements are shown as separate, each headed by what triggered it", async ({
    page,
  }) => {
    /*
     * A `run` followed by a `change` is five decisions, not one long stream, and four
     * of them found nothing to do. Those four quiet judgements are half of what makes
     * the fifth believable: anyone can flag whatever read a changed table, and a tool
     * that shouts after every write is worthless.
     *
     * The heading is the completion that triggered the pass, deliberately not its
     * conclusion. A heading carrying the conclusion would print "marked 3 out of date"
     * directly above the step that says exactly that.
     */
    await openCockpit(page, cascaded(), idle(), manyDecisions());
    await page.waitForSelector('[aria-label="What obsel is doing"] ol li', { state: "attached" });

    const headings = await page.evaluate(() =>
      [...document.querySelectorAll('[aria-label="What obsel is doing"] ol li')]
        .filter((li) => getComputedStyle(li).position === "sticky")
        .map((li) => li.textContent ?? ""),
    );

    // One per decision, and every one names its trigger.
    expect(headings).toHaveLength(5);
    expect(headings.filter((h) => h.includes("finished"))).toHaveLength(5);
    expect(headings.some((h) => h.includes("marked 3 out of date"))).toBe(false);

    // The header counts decisions, and every step it counts is in the DOM: the old
    // "last 8 of 25" named 17 steps scrolling could never reach.
    await expect(page.getByText("5 decisions, 17 steps")).toBeVisible();
    const steps = await page.evaluate(
      () => document.querySelectorAll('[aria-label="What obsel is doing"] ol li').length,
    );
    expect(steps).toBe(17);
  });

  test("more narration does not put more words on screen", async ({ page }) => {
    /*
     * The guard for dropping the eight-step cap.
     *
     * The panel renders the whole trace now, so the DOM grows with the length of a
     * run. What must not grow is what a viewer is confronted with: the scroller is a
     * fixed height and shows about a dozen steps whatever it holds. Without this, the
     * board would grow with how much obsel narrated rather than with how
     * dense the board is, and the way to pass it would be to narrate less.
     */
    const onScreen = async () =>
      page.evaluate(() => {
        const list = document.querySelector('[aria-label="What obsel is doing"] ol');
        if (list === null) return 0;
        const box = list.getBoundingClientRect();
        const visible = [...list.querySelectorAll("li")].filter((li) => {
          const b = li.getBoundingClientRect();
          return b.bottom > box.top + 1 && b.top < box.bottom - 1;
        });

        /*
         * One row per position, because the pass headings are `position: sticky`
         * siblings and every heading a reader has scrolled past parks at the same
         * top edge, painted over by the next one.
         *
         * Counting them all would count text nobody can read: fifty passes stack
         * fifty headings into one heading's worth of pixels, and the reader sees
         * the last one. Fifty is also what made this worth stating. The feed used
         * to be a 172px strip that could only ever hold a few passes, so the pile
         * was two or three elements deep and the arithmetic barely noticed; at the
         * height of the frame it is deep enough to treble the count on its own.
         */
        const byTop = new Map<number, string>();
        for (const li of visible) {
          byTop.set(Math.round(li.getBoundingClientRect().top), (li.textContent ?? "").trim());
        }
        return [...byTop.values()].reduce(
          (n, text) => n + text.split(/\s+/).filter(Boolean).length,
          0,
        );
      });

    /*
     * Both runs overflow the scroller, and that is the whole design of this
     * comparison.
     *
     * It used to be eight steps against twenty-four, which was a fair test while
     * the feed was a 172px strip: eight steps already filled it. The feed is the
     * height of the frame now, so eight steps do not fill it, and comparing
     * against them would measure how much empty panel there is rather than
     * whether the panel has a ceiling. Ten passes and fifty passes both overflow,
     * so any difference between them is the ceiling failing.
     */
    await openCockpit(page, cascaded(), idle(), longRun(10));
    await page.waitForSelector('[aria-label="What obsel is doing"] ol li', { state: "attached" });
    const full = await onScreen();

    await openCockpit(page, cascaded(), idle(), longRun(50));
    await page.waitForSelector('[aria-label="What obsel is doing"] ol li', { state: "attached" });
    const fuller = await onScreen();

    // Five times the trace, and the visible text is bounded by the panel rather
    // than by the trace. Allow a modest band: which rows land inside the box
    // depends on where the boundaries fall, not on how many steps are held.
    expect(full).toBeGreaterThan(0);
    expect(fuller).toBeGreaterThan(0);
    expect(fuller, `${full} visible at ten passes, ${fuller} at fifty`).toBeLessThan(full * 1.5);
  });

  test("a failed trace read empties the panel and leaves the board alone", async ({ page }) => {
    const { serveTrace } = await openCockpit(page, cascaded(), idle(), cascadeSteps());
    await expect(page.getByText("compared clean orders")).toBeVisible();

    serveTrace("fail");

    // The steps go, because a step list held over from a read that is no longer
    // working is a claim about what obsel is doing now that nobody can support.
    await expect(page.getByText("compared clean orders")).toHaveCount(0);
    await expect(page.getByText(/could not be read/)).toBeVisible();
    // The swarm read is a different endpoint and is still healthy, so the board
    // and every measured number stay exactly where they were.
    await expect(page.getByText("connected")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "3 of 4 finished agents are out of date" }),
    ).toBeVisible();
  });
});

/*
 * Two guards on how much the board says, and how it says it.
 *
 * These are here because ten rounds of hand-editing copy is what produced the
 * state they check against: 604 words and 111 lines of text on one screen, with
 * 10 em dashes among them. Both defects were introduced gradually, by edits that
 * each looked reasonable, and neither was visible to any test. A preference that
 * only lives in a review comment is a preference that comes back.
 *
 * `tests/cockpit-guide.test.ts` makes the em dash assertion against every stage
 * the guide can derive, including the setup and failure stages a browser test
 * would have to break the machine to reach. This pair asserts it of the fully
 * rendered page, which is the thing a reader actually looks at.
 */
test.describe("how much the board says", () => {
  test("no em dash reaches the rendered page, in any state", async ({ page }) => {
    for (const [name, swarm, activity] of [
      ["cascaded", cascaded(), idle()],
      ["settled", calm(), idle()],
      ["empty", empty(), idle()],
      ["a broken prerequisite", calm(), codexSignedOut()],
      ["a step running", calm(), runningStep("rerun-same")],
    ] as const) {
      await openCockpit(page, swarm, activity, cascadeSteps());
      const text = await page.evaluate(() => document.body.innerText);
      expect(text, `${name} put an em dash on screen`).not.toContain("—");
    }
  });

  test("the board states what obsel is for, in every state", async ({ page }) => {
    /*
     * The complaint behind ten rounds of feedback was that a stranger could not tell
     * what this board was, and the board genuinely never said. Previous attempts
     * answered it with a header tagline and then with paragraphs above the graph,
     * which is how the screen reached 604 words; both were removed and nothing
     * replaced them. `guide.ts` even kept a `WHAT_OBSEL_IS` constant that no code read.
     *
     * It is the graph's heading now, so it costs one already-spent slot and is present
     * whatever the swarm is doing. Asserted across every state, because a purpose that
     * only appears once something has gone wrong is not a statement of purpose.
     *
     * The third attempt was a question, "is this finished work still built on something
     * that is still true?", and it passed this test while failing the complaint. Nothing
     * a word count or a visibility check can see was wrong with it: it names nothing.
     * Not an agent, not a table, not a change. So the assertion is on the nouns now, not
     * on the sentence, because those are the part a stranger needs and the part a
     * rewrite is tempted to compress away.
     */
    for (const [name, swarm] of [
      ["flagged", cascaded()],
      ["settled", calm()],
      ["empty", empty()],
    ] as const) {
      await openCockpit(page, swarm, idle(), cascadeSteps());
      const heading = page.getByRole("heading", { name: /Each agent reads a table/ });
      await expect(heading, `${name} should still say what obsel is for`).toBeVisible();
      const said = (await heading.textContent()) ?? "";
      for (const noun of ["agent", "table", "change", "finished work"]) {
        expect(said, `${name} should name ${noun}`).toContain(noun);
      }
    }
  });

  /**
   * No internal name reaches the board.
   *
   * The word ceiling this board used to carry could not catch this and never
   * could, which is part of why it is gone. `venv: the agents' Python
   * environment (agents/.venv) does not exist yet` is nine words and completely
   * opaque, so a board full of identifiers scored BETTER on a word count than a
   * longer one a stranger can actually read. Two rounds of hand-edited
   * plain-language passes came and went with only that ceiling behind them, and
   * the identifiers grew straight back.
   *
   * This is the objective half of "written for someone who already knows": the
   * half a machine can check. Internal names are the ones the reader has no way to
   * look up — the `DemoStep` ids the launcher takes, the keys of the preflight
   * record, and process exit vocabulary.
   *
   * Four exclusions, all places a raw value BELONGS:
   *
   * - the details panel, which exists to show uncompressed values including the URN;
   * - the join panel, which is the tool list an outside agent calls by name plus
   *   the command that connects it — a name you must type cannot be said any
   *   other way, and the whole panel is a closed disclosure;
   * - `<pre>`, which is the launched command's own stdout, verbatim, and is
   *   evidence rather than copy;
   * - `<code>`, which carries the fix commands. Those are meant to be read as
   *   commands and copied, and `agents/.venv/bin/python` cannot be said any other
   *   way. They get the separate, stricter assertion below instead.
   */
  test("no internal identifier reaches the board, in any state", async ({ page }) => {
    // Every state is walked before anything is asserted. Failing on the first one
    // would report a single leak and hide the rest, and the fix for this is a copy
    // pass over the whole board: the useful failure is the full inventory.
    const leaks: string[] = [];
    const bareCode: string[] = [];

    for (const [name, swarm, activity] of [
      ["a finished step", cascaded(), finishedStep()],
      ["a running step", calm(), runningStep("rerun-same")],
      ["an unprepared machine", calm(), nothingInstalled()],
      ["one broken prerequisite", calm(), codexSignedOut()],
      ["settled", calm(), finishedStep("run")],
    ] as const) {
      await openCockpit(page, swarm, activity, cascadeSteps());

      const found = await page.evaluate(() => {
        const KEPT_OUT = ["venv", "vocabulary", "rerun-same", "exit 0", "exited", "urn:li:"];
        const RAW =
          '[aria-label="What obsel is doing"], [aria-label="Details"], ' +
          '[aria-label="Bring your own agent"], pre, code';
        const main = document.querySelector("main");
        if (main === null) return { seen: ["there is no <main>"], bare: [] as string[] };

        const seen: string[] = [];
        const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const parent = node.parentElement;
          if (parent === null || parent.closest(RAW) !== null) continue;
          const text = node.textContent ?? "";
          for (const word of KEPT_OUT) {
            if (text.toLowerCase().includes(word)) seen.push(`"${word}" in "${text.trim()}"`);
          }
        }

        // A fix command is a command: it has a verb and an argument. A lone
        // identifier in a code span is the launcher's internal name leaking into a
        // sentence, which is the exact shape of "`change` finished clean". The
        // join panel is excluded with the details panel: an MCP tool's name is a
        // single token by nature, and listing what a visiting agent may call is
        // that panel's entire job.
        const bare = [...main.querySelectorAll("code")]
          .filter(
            (el) =>
              el.closest('[aria-label="Details"], [aria-label="Bring your own agent"]') === null,
          )
          .map((el) => (el.textContent ?? "").trim())
          .filter((text) => !text.includes(" "));

        return { seen, bare };
      });

      leaks.push(...found.seen.map((leak) => `${name}: ${leak}`));
      bareCode.push(...found.bare.map((code) => `${name}: ${code}`));
    }

    expect(leaks, "an internal name reached the board").toEqual([]);
    expect(bareCode, "a bare identifier was rendered as code").toEqual([]);
  });

  /*
   * The board's total word ceiling was here, and it is gone deliberately.
   *
   * It asserted `prose < 176` and `prose + log < 269` on the flagged board, and
   * it did real work once: the screen it was written against was 604 words in
   * two stacked panels of paragraphs, and the number is what forced that down.
   *
   * What it became was a toll booth. Every genuine improvement to the copy
   * arrived as a failing build and a paragraph of argument written at the
   * assertion, and the ceiling moved anyway each time — 160, 168, 176 — so it
   * was never actually refusing anything. It measured the one property of prose
   * that has no relationship to whether prose is any good. The five-act rail was
   * nearly shipped as unlabelled ticks to stay under it, which produced a
   * position meter nobody could read; the labels went on and the number moved.
   *
   * The owner removed it: "i dont want word-salad in my UI, but i dont think
   * having a hard word-ceiling is helpful either."
   *
   * What is left in its place guards the same thing without a number to game:
   *
   * - **"more narration does not put more words on screen"** above — the log
   *   panel is fixed height, so a longer session cannot grow the board.
   * - **`scale.spec.ts`** — the forty-task board and the four-task board must
   *   say the same amount, so density stays a property of the board rather than
   *   of the pipeline somebody points it at.
   * - **The per-node label cap in `scale.spec.ts`** — a box label may not grow
   *   into a sentence. That is the actual word-salad failure, and it is a cap on
   *   one label rather than on the screen.
   * - **The em dash and internal-name guards** above, which are about how the
   *   board says things rather than how much.
   *
   * `e2e/fixtures/words.ts` stays: the scale comparison still measures with it.
   */
});
