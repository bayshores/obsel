import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  runnerSignedOut,
  noRunnerInstalled,
  finishedStep,
  idle,
  runningStep,
  walked,
} from "./fixtures/activity";
import { calm, cascaded, empty } from "./fixtures/swarm";
import { openDashboard } from "./fixtures/mount";

/**
 * The guide panel: which stage the page is in, and what it offers there.
 *
 * The other halves of this suite are `dashboard-layout.spec.ts` (pixels),
 * `dashboard-graph.spec.ts` (the graph and its details), `dashboard-honesty.spec.ts`
 * (what the page refuses to say) and `dashboard-joining.spec.ts` (boards that are
 * not the demo's own).
 */

test.describe("guide", () => {
  test("an empty swarm offers register, and the click launches the real step", async ({ page }) => {
    const { launches } = await openDashboard(page, empty());

    const button = page.getByRole("button", { name: /Set up the demo agents/ });
    await expect(button).toBeVisible();
    await button.click();

    await expect.poll(() => launches).toEqual(["register"]);
  });

  test("a settled swarm offers the two experiments", async ({ page }) => {
    await openDashboard(page, calm());

    await expect(page.getByRole("button", { name: /Run the orders cleaner again/ })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Change one agent's instructions/ }),
    ).toBeVisible();
  });

  test("a cascaded swarm explains the flags and offers the re-run and reset, never change", async ({
    page,
  }) => {
    await openDashboard(page, cascaded());

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
    await openDashboard(page, calm(), runnerSignedOut("codex"));

    await expect(page.getByRole("heading", { name: /thing.? to set up/ })).toBeVisible();
    await expect(page.getByText("codex login", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Run the orders cleaner again/ })).toHaveCount(0);
  });

  test("the same screen names Claude Code and its own command when that is the runner", async ({
    page,
  }) => {
    /*
     * The other half of the row above, and the reason the fixture takes a
     * runner. These two states go down one code path, so a fix string that was
     * still hardcoded to Codex would render `codex login` at somebody who has
     * never installed it and whose actual problem is one command away.
     */
    await openDashboard(page, calm(), runnerSignedOut("claude"));

    await expect(page.getByRole("heading", { name: /thing.? to set up/ })).toBeVisible();
    await expect(page.getByText("claude auth login", { exact: true })).toBeVisible();
    await expect(page.getByText("codex login", { exact: true })).toHaveCount(0);
  });

  test("with no agent CLI at all the row names both and offers no command", async ({ page }) => {
    /*
     * The state a stranger who has only just cloned obsel is in, and the one
     * with no fix: there is nothing to sign into until they have chosen a
     * product. Naming one would send them to install whichever obsel happens to
     * look for first.
     */
    await openDashboard(page, calm(), noRunnerInstalled());

    await expect(page.getByRole("heading", { name: /thing.? to set up/ })).toBeVisible();
    await expect(
      page.getByText(/Neither the Codex CLI nor Claude Code is installed/),
    ).toBeVisible();
    await expect(page.getByText("codex login", { exact: true })).toHaveCount(0);
    await expect(page.getByText("claude auth login", { exact: true })).toHaveCount(0);
  });

  test("while a step runs the buttons go away and its own output streams", async ({ page }) => {
    await openDashboard(page, calm(), runningStep("rerun-same"));

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
   * `tests/dashboard-guide.test.ts` decides which step a given board lands on,
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
  /**
   * Press next `times`, waiting for each step to actually arrive before the next
   * press.
   *
   * The wait is the point. A bare loop of clicks passes on an idle machine and
   * fails under a full parallel run: the second click lands before the window has
   * re-rendered, so it hits the step already leaving and the tour ends up one
   * short. That surfaced once as a failure on the last step's heading, which
   * reads as a wrong destination rather than as a swallowed press.
   */
  const advance = async (page: Page, times: number) => {
    for (let i = 0; i < times; i += 1) {
      const before = await win(page).getByRole("heading").first().textContent();
      await win(page).getByRole("button", { name: "next", exact: true }).click();
      await expect(win(page).getByRole("heading").first()).not.toHaveText(before ?? "");
    }
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
    await openDashboard(page, empty(), idle());

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
    await openDashboard(page, cascaded(), finishedStep());
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
   * them. The canvas-and-panel layout put every region flush inside a container
   * that clips its overflow, so all of it was cut away: measured on the rebuilt
   * board, four of the six highlights a reader passes rendered nothing at all,
   * and the tour spent four steps telling somebody to look at a region it was
   * not marking.
   *
   * What is asserted is the property rather than the pixels: nothing outside the
   * target's own box, because outside the box is where the clipping is.
   */
  test("it marks the region from inside, where nothing can clip it", async ({ page }) => {
    await openDashboard(page, cascaded(), finishedStep());
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
   * The window opens in the corner the panel is not using.
   *
   * It used to open bottom-right unconditionally, which was a free corner while
   * the board was a column and is a panel now: on the rebuilt board it landed on
   * top of the panel and covered the two measured numbers pinned at its foot,
   * which are the figures the demonstration exists to establish.
   */
  test("the window opens clear of the panel, on whichever side that is", async ({ page }) => {
    await openDashboard(page, cascaded(), finishedStep());
    await openTour(page);

    const overlap = async () =>
      page.evaluate(() => {
        const card = document.querySelectorAll('section[aria-label="guide"]');
        const window_ = card[card.length - 1]?.getBoundingClientRect();
        const panel = document.querySelector("[data-panel]")?.getBoundingClientRect();
        if (window_ === undefined || panel === undefined) return null;
        const wide = Math.min(window_.right, panel.right) - Math.max(window_.left, panel.left);
        const tall = Math.min(window_.bottom, panel.bottom) - Math.max(window_.top, panel.top);
        return {
          area: Math.max(0, wide) * Math.max(0, tall),
          side: document.querySelector("[data-panel]")?.getAttribute("data-panel"),
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
    const { serve } = await openDashboard(page, empty(), idle());
    await openTour(page);

    // Straight to the first action.
    await advance(page, 4);
    await expect(
      win(page).getByRole("heading", { name: "put the agents on the graph" }),
    ).toBeVisible();

    // It quotes the real control by the label the board is painting on it, and
    // there is no next.
    await expect(win(page).getByText("Set up the demo agents")).toBeVisible();
    await expect(win(page).getByText("press this, glowing on the page")).toBeVisible();
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
    await openDashboard(page, cascaded(), finishedStep());
    await openTour(page);
    await advance(page, 4);
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

    await openDashboard(page, calm(), walked());
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
    await openDashboard(page, calm(), idle());
    await openTour(page);
    expect(await toTheEnd()).toBe("now change something upstream");
  });

  test("the window can be picked up and put somewhere else", async ({ page }) => {
    await openDashboard(page, cascaded(), finishedStep());
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
     * opens on the side the panel is not using, so the room is on the other side
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
    await openDashboard(page, cascaded(), finishedStep());
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

    const { serve } = await openDashboard(page, calm(), finishedStep());

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
      await openDashboard(page, cascaded(), finishedStep());

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
      await openDashboard(page, cascaded(), finishedStep());
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
      // drag test: which way it has room depends on where the panel is.
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
