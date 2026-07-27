import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  codexSignedOut,
  finishedStep,
  idle,
  nothingInstalled,
  runningStep,
} from "./fixtures/activity";
import {
  calm,
  cascaded,
  empty,
  leftOverTag,
  midWrite,
  visiting,
  withoutTagInfo,
} from "./fixtures/swarm";
import { openCockpit } from "./fixtures/mount";
import { cascadeSteps, manyDecisions } from "./fixtures/trace";
import { boardWords, describeWords } from "./fixtures/words";

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
        const guide = document.querySelector('[aria-label="What just happened"]');
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

  test("the alert takes its own row rather than covering the board", async ({ page }) => {
    const { serve } = await openCockpit(page, cascaded());
    serve("fail");
    await expect(obselAlert(page)).toBeVisible();

    // Polled for the same reason as above, and it asserts the relationship
    // rather than two absolute positions: the alert must END above where the
    // graph BEGINS. A banner covering the board it warns about is worse than
    // no banner.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const a = document.querySelector('main [role="alert"]')?.getBoundingClientRect();
            const svg = document.querySelector("main svg")?.getBoundingClientRect();
            if (a === undefined || svg === undefined) return "not both present";
            return a.bottom <= svg.top ? "clear" : "overlapping";
          }),
        { timeout: 8_000 },
      )
      .toBe("clear");
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
        const iterations = anims[0]?.effect?.getTiming().iterations;
        return {
          count: anims.length,
          // Resolved to a boolean in the page rather than shipped as a number.
          // An unbounded animation reports `Infinity`, which does not survive
          // JSON serialisation across the bridge intact.
          bounded: typeof iterations === "number" ? Number.isFinite(iterations) : true,
          playState: anims[0]?.playState ?? "none",
        };
      });
    });

    expect(state.length, "the cascade should light some edges").toBeGreaterThan(0);
    for (const edge of state) {
      expect(edge.count, "a lit edge must carry a running animation").toBeGreaterThan(0);
      // A bounded iteration count is the one-shot bug returning: it would play
      // through once and then hold still for the rest of the session.
      expect(edge.bounded, "the dash must repeat forever").toBe(false);
      expect(edge.playState).toBe("running");
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

  test("is a panel with a heading, not a line somebody has to notice", async ({ page }) => {
    await openCockpit(page, cascaded(), finishedStep());

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
    // The state the board is in on camera, and the state the word ceiling
    // measures. The heading is visible; the four steps are not painted.
    await openCockpit(page, cascaded(), finishedStep());

    await expect(panel(page).getByText("nobody has joined yet")).toBeVisible();
    await expect(panel(page).getByText("how an agent joins")).toBeVisible();
    // The step rows, which are the prose the fold exists to hold back. In the
    // DOM, painted by nobody.
    await expect(panel(page).locator("li[data-done]").first()).toBeHidden();
  });

  test("opens itself, and counts the steps, once somebody's agent is on the board", async ({
    page,
  }) => {
    await openCockpit(page, visiting(), finishedStep());

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
    await openCockpit(page, cascaded(), finishedStep());
    await expect(panel(page).getByText("nobody has joined yet")).toBeVisible();
    await expect(panel(page).getByText(/\d of 4/)).toBeHidden();
  });

  test("hands over this machine's real command, not a placeholder path", async ({ page }) => {
    await openCockpit(page, visiting(), finishedStep());

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
    const { serve } = await openCockpit(page, cascaded(), finishedStep());
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
    const { serve } = await openCockpit(page, visiting(), finishedStep());
    await expect(panel(page).getByText("3 of 4")).toBeVisible();

    serve("fail");
    await expect(obselAlert(page)).toBeVisible();
    await expect(panel(page).getByText("nobody has joined yet")).toBeVisible();
    await expect(panel(page).locator("li[data-done]").first()).toBeHidden();
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
     * board's word ceiling would measure how much obsel narrated rather than how
     * dense the board is, and the way to pass it would be to narrate less.
     */
    const onScreen = async () =>
      page.evaluate(() => {
        const list = document.querySelector('[aria-label="What obsel is doing"] ol');
        if (list === null) return 0;
        const box = list.getBoundingClientRect();
        return [...list.querySelectorAll("li")]
          .filter((li) => {
            const b = li.getBoundingClientRect();
            return b.bottom > box.top + 1 && b.top < box.bottom - 1;
          })
          .reduce(
            (n, li) => n + (li.textContent ?? "").trim().split(/\s+/).filter(Boolean).length,
            0,
          );
      });

    await openCockpit(page, cascaded(), idle(), cascadeSteps());
    await page.waitForSelector('[aria-label="What obsel is doing"] ol li', { state: "attached" });
    const short = await onScreen();

    await openCockpit(page, cascaded(), idle(), manyDecisions());
    await page.waitForSelector('[aria-label="What obsel is doing"] ol li', { state: "attached" });
    const long = await onScreen();

    // Three times the trace, and the visible text is bounded by the panel rather than
    // by the trace. Allow a modest band: which rows land inside the box depends on
    // where the boundaries fall, not on how many steps are held.
    expect(long).toBeGreaterThan(0);
    expect(long, `${short} visible on a short trace, ${long} on a long one`).toBeLessThan(
      short * 2,
    );
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
   * The word ceiling below cannot catch this and never could. `venv: the agents'
   * Python environment (agents/.venv) does not exist yet` is nine words and
   * completely opaque, so a board full of identifiers scores BETTER on a word
   * count than a longer one a stranger can actually read. Two rounds of
   * hand-edited plain-language passes came and went with only that ceiling behind
   * them, and the identifiers grew straight back.
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

  test("the flagged board stays under its word ceiling", async ({ page }) => {
    // The heaviest honest state, not the lightest: a finished step behind it and a
    // full session in the trace. Calibrating against `idle()` and a five-step trace
    // put the ceiling 18 words of prose below the live board, so it guarded a screen
    // nobody sees.
    await openCockpit(page, cascaded(), finishedStep(), manyDecisions());
    await page.waitForSelector(".react-flow__edge", { state: "attached" });

    // Measured by `e2e/fixtures/words.ts`, which explains the split and is shared
    // with the scale suite so the two boards are measured identically.
    const counts = await boardWords(page);

    /*
     * Measured on this commit at the recording viewport: 90 words of step log (182
     * held, so 92 are scrolled out), 43 of graph labels over nine boxes, 16 in the
     * live region, and **155 words of prose**. The laptop shows more words of log in
     * its shorter panel and the same 155 of prose, which is the point of splitting
     * the two: prose does not depend on panel height.
     *
     * **Was 147 on the commit before the joining panel, and 154 before that.** The
     * step from 154 to 147 was a measurement fix rather than a copy change: `prose`
     * is a subtraction, and the
     * graph was being counted with `textContent` while the body it was subtracted
     * from used `innerText`, so each node ran its title into its status word and gave
     * prose one word per node that was not prose. `e2e/fixtures/words.ts` explains
     * it. Nine nodes made it look like rounding; eighty-two made it a paragraph.
     *
     * **Prose is up from 126, and every word of the rise was bought deliberately.**
     * Two purchases, +36 between them, less the 7 the measurement fix above took
     * back off the total: 126 + 36 - 7 = 155.
     *
     * - **+24** the repair button, label and line. The flagged board asks a question —
     *   three agents are out of date, now what — and until this button the only
     *   answers on screen were re-running the cause and wiping the take. Its line
     *   carries the one rule that makes it different from a dismiss button: flags
     *   come off through redone work, and an identical redo is itself proof.
     * - **+12** the joining panel, which is 4 words of heading, 4 of state
     *   ("nobody has joined yet") and 4 inviting the click. It replaced a closed
     *   17px disclosure that cost 4, and the extra 8 are the entire fix: the
     *   owner of this repository, who wrote that disclosure's contents, did not
     *   know it was on the page. Everything behind the fold, the command and the
     *   four steps and the tool list, still costs nothing until opened, and
     *   `joining.ts` keeps it folded on exactly the board this test measures.
     *
     * The history of this ceiling, kept because it is the argument for having one: it
     * was introduced when the board was 604 words in two stacked panels of paragraphs,
     * and an earlier raise (104 → 126) paid for the graph heading, the button lines,
     * the subline and the key each being rewritten for a stranger — because a word
     * count scores `venv: the agents' Python environment does not exist yet` better
     * than a sentence that explains itself, and the owner's complaint was never that
     * the board said too much, but that what it said was written for somebody who
     * already knew.
     *
     * The ceiling stays six words above the measurement, exactly as before. What it
     * guards against is unchanged: two stacked panels of prose, which is what putting
     * the ledger back would cost (205 words on its own). What it is no longer allowed
     * to do is push the board back toward saying things in code. `no internal
     * identifier reaches the board` above is the guard for that half, and the two have
     * to be read together: one caps how much is said, the other requires it be
     * readable. A failure here is not proof of a bug, but it is always a decision
     * worth a second look.
     *
     * **The graph is no longer inside the total, and that is a correction rather
     * than a relaxation.** It was, at 36 words for four tasks and nine boxes. A
     * forty-task pipeline draws eighty-two boxes and about 230 words of label, so
     * the old combined ceiling failed on a board whose copy had not changed by one
     * word: it was measuring the size of the user's pipeline. Labels are scanned,
     * there is one per box, and the number of boxes is not obsel's to budget. What
     * is obsel's is how wordy each label is, which `scale.spec.ts` caps per node,
     * and how much prose is on the board, which is the number below and holds at
     * any size. That claim is asserted rather than assumed: the scale suite
     * measures the same figures on the forty-task board and requires the prose to
     * match this one.
     */
    const where = describeWords(counts);
    expect(counts.prose, where).toBeLessThan(160);
    expect(counts.prose + counts.log, where).toBeLessThan(263);
  });
});
