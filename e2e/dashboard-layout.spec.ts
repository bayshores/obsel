import { expect, test } from "@playwright/test";

import {
  runnerSignedOut,
  noRunnerInstalled,
  finishedStep,
  idle,
  nothingInstalled,
  runningStep,
} from "./fixtures/activity";
import { calm, cascaded, empty } from "./fixtures/swarm";
import { openDashboard } from "./fixtures/mount";
import { cascadeSteps } from "./fixtures/trace";

/**
 * What the page looks like in pixels, which is the half only a real browser can settle.
 *
 * The font actually resolved, no text escapes its box, the WebGL backdrop really
 * painted, and the whole thing still fits. Deliberately excluded: anything
 * `tests/dashboard-*.test.ts` already proves without a browser — nodeTone's
 * amber-iff-stale invariant, geometry invariance across statuses, cascadeEdges
 * hop numbers and cycle termination, the totals arithmetic, the shader/token
 * equivalence.
 */

test.describe("typography", () => {
  test("the real faces resolved, not a fallback", async ({ page }) => {
    await openDashboard(page, cascaded());

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
    await openDashboard(page, cascaded());
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
    await openDashboard(page, cascaded());
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
    await openDashboard(page, cascaded());
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
    await openDashboard(page, cascaded());

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
    await openDashboard(page, cascaded());

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
    await openDashboard(page, cascaded());
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
    await openDashboard(page, cascaded());
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
    await openDashboard(page, cascaded());
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

test.describe("paint", () => {
  test("no console errors, no page errors, no failed subresources", async ({ page }) => {
    const { faults } = await openDashboard(page, cascaded());
    await page.waitForTimeout(1200); // let a couple of polls run

    expect(faults.pageErrors).toEqual([]);
    expect(faults.consoleErrors).toEqual([]);
    // A CSP-blocked font or script shows up here, which is the whole point:
    // app/layout.tsx and THIRD_PARTY_NOTICES.md both turn on obsel serving its
    // own fonts rather than fetching them.
    expect(faults.failedRequests).toEqual([]);
  });

  test("the WebGL backdrop actually painted, and left the centre clear", async ({ page }) => {
    await openDashboard(page, cascaded());

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
    // the dashboard is fully legible without a backdrop. Skip rather than fail.
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
    await openDashboard(page, cascaded());
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
    await openDashboard(page, cascaded());
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
    await openDashboard(page, cascaded());
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
    await openDashboard(page, cascaded());
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
    await openDashboard(page, cascaded());
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

/*
 * Two guards on how much the board says, and how it says it.
 *
 * These are here because ten rounds of hand-editing copy is what produced the
 * state they check against: 604 words and 111 lines of text on one screen, with
 * 10 em dashes among them. Both defects were introduced gradually, by edits that
 * each looked reasonable, and neither was visible to any test. A preference that
 * only lives in a review comment is a preference that comes back.
 *
 * `tests/dashboard-guide.test.ts` makes the em dash assertion against every stage
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
      ["a broken prerequisite", calm(), runnerSignedOut()],
      ["a step running", calm(), runningStep("rerun-same")],
    ] as const) {
      await openDashboard(page, swarm, activity, cascadeSteps());
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
      await openDashboard(page, swarm, idle(), cascadeSteps());
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

    /*
     * The last two states pin a node open, and that is the point of them.
     *
     * The `[aria-label="Details"]` exclusion above was written when the panel
     * rendered no such label, and no state in this loop opened the panel, so it
     * had never once been exercised: it excluded nothing from a sweep that never
     * reached it. The panel is built almost entirely from full URNs and bare
     * 64-hex hashes, so the exclusion has to be real before it can be relied on
     * — and a state that opens the panel is what proves it is.
     */
    for (const [name, swarm, activity, pin] of [
      ["a finished step", cascaded(), finishedStep(), null],
      ["a running step", calm(), runningStep("rerun-same"), null],
      ["an unprepared machine", calm(), nothingInstalled(), null],
      ["one broken prerequisite", calm(), runnerSignedOut(), null],
      // The runner row with no product to name, which is a state of its own: its
      // detail is the longest sentence the checklist ever renders and it offers
      // no command, so neither the copy nor the code-span rule is exercised by
      // the row above it.
      ["no agent CLI installed", calm(), noRunnerInstalled(), null],
      ["settled", calm(), finishedStep("run"), null],
      ["an agent's details open", cascaded(), finishedStep(), ".react-flow__node-task"],
      ["a table's details open", cascaded(), finishedStep(), ".react-flow__node-data"],
    ] as const) {
      await openDashboard(page, swarm, activity, cascadeSteps());

      if (pin !== null) {
        await page.waitForSelector(pin, { state: "attached" });
        await page.locator(pin).nth(1).click();
        await page.locator('[aria-label="Details"]').waitFor();
      }

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
   * The page's total word ceiling was removed on 2026-07-27, at the owner's
   * instruction; `docs/verification.md` records why. What guards the same thing
   * without a number to game is above and in `scale.spec.ts`: the log panel is
   * fixed height, the forty-task page must say the same amount as the four-task
   * one, and a box label may not grow into a sentence.
   */
});
