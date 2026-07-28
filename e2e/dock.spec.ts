/**
 * The dock as a thing a reader arranges: which side it is on, how wide it is,
 * and whether it is in the way.
 *
 * These exist because the arrangement is a preference rather than a layout
 * constant, and a preference that is not remembered is a preference nobody uses
 * twice. The measurements below are all relative: what matters is that moving
 * the dock moves the graph's share of the frame and that nothing ends up clipped
 * or scrolling, not that any of it lands on a particular pixel.
 *
 * `page.mouse` rather than a synthetic drag event. The panel is dragged by
 * pointer capture through `motion`'s drag controls, and a dispatched event does
 * not exercise that path at all: it would prove the handler runs, which was
 * never in doubt.
 */

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { finishedStep } from "./fixtures/activity";
import { openCockpit } from "./fixtures/mount";
import { cascaded } from "./fixtures/swarm";

const dock = (page: Page) => page.locator('[data-dock="left"], [data-dock="right"]');

/** Where the dock is, how wide, and how much frame the canvas has left. */
async function geometry(page: Page) {
  return await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>("[data-dock]");
    const canvas = document.querySelector<HTMLElement>('[aria-label="How the work connects"]');
    const panelBox = panel?.getBoundingClientRect();
    const canvasBox = canvas?.getBoundingClientRect();
    return {
      side: panel?.getAttribute("data-dock") ?? null,
      width: Math.round(panelBox?.width ?? 0),
      dockLeft: Math.round(panelBox?.left ?? 0),
      canvasLeft: Math.round(canvasBox?.left ?? 0),
      canvasWidth: Math.round(canvasBox?.width ?? 0),
      viewport: window.innerWidth,
    };
  });
}

/** Nothing clipped, nothing scrolling. Asserted after every rearrangement. */
async function boardIsWhole(page: Page) {
  const page_ = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    scrollH: document.documentElement.scrollHeight,
    clientH: document.documentElement.clientHeight,
  }));
  expect(page_.scrollW, "the page never scrolls sideways").toBeLessThanOrEqual(page_.clientW + 1);
  expect(page_.scrollH, "the page never scrolls vertically").toBeLessThanOrEqual(page_.clientH + 1);

  // Every node inside the pane it is drawn in. A dock that took width without
  // the graph re-fitting would strand nodes outside the visible canvas.
  const clipped = await page.evaluate(() => {
    const pane = document.querySelector(".react-flow__pane")?.getBoundingClientRect();
    if (pane === undefined) return -1;
    return [...document.querySelectorAll(".react-flow__node")].filter((node) => {
      const box = node.getBoundingClientRect();
      return (
        box.left < pane.left - 1 ||
        box.right > pane.right + 1 ||
        box.top < pane.top - 1 ||
        box.bottom > pane.bottom + 1
      );
    }).length;
  });
  expect(clipped, "no node is cut off by the dock's position").toBe(0);
}

/** Carry the dock by its grip to an x position, and let go. */
async function carryTo(page: Page, x: number) {
  const grip = page.locator('[data-dock-grip="true"]');
  const box = await grip.boundingBox();
  if (box === null) throw new Error("no grip");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // Several steps: `motion` starts a drag on movement, and one jump from press
  // to release is indistinguishable from a click.
  await page.mouse.move(x, box.y + box.height / 2, { steps: 12 });
  return async () => {
    await page.mouse.up();
    await page.waitForTimeout(500);
  };
}

test.describe("the dock a reader arranges", () => {
  test("opens on the right, with the graph taking the rest of the frame", async ({ page }) => {
    await openCockpit(page, cascaded(), finishedStep());
    await page.waitForSelector(".react-flow__node", { state: "attached" });

    const at = await geometry(page);
    expect(at.side).toBe("right");
    // On the right means the canvas starts at the frame's left edge.
    expect(at.canvasLeft).toBeLessThanOrEqual(1);
    expect(at.dockLeft).toBeGreaterThan(at.canvasWidth / 2);
    // The graph is the subject of the board and keeps the larger share of it.
    expect(at.canvasWidth, "the graph keeps most of the frame").toBeGreaterThan(at.width);
    await boardIsWhole(page);
  });

  test("shows where it will land before the reader commits", async ({ page }) => {
    await openCockpit(page, cascaded(), finishedStep());
    await page.waitForSelector(".react-flow__node", { state: "attached" });

    const release = await carryTo(page, 120);

    // The outline, and the dock reporting that it is being carried. Both only
    // while the button is down: this is the whole point of a snap preview.
    await expect(dock(page)).toHaveAttribute("data-dock-carrying", "true");

    const ghostLeft = () =>
      page.evaluate(() => {
        const outline = [...document.querySelectorAll("div")].find((node) => {
          const style = getComputedStyle(node);
          return style.position === "fixed" && style.borderStyle === "dashed";
        });
        const box = outline?.getBoundingClientRect();
        return box === undefined ? null : Math.round(box.left);
      });

    /*
     * Polled rather than read once. Where the outline goes is React state set
     * from a pointer event, so the frame in which it catches up with the last
     * move is not something the test gets to know: read once, this passed on a
     * 1920 frame and failed on a 1280 one, purely because the shorter drag gave
     * the render less time.
     */
    await expect
      .poll(ghostLeft, { message: "the outline should be against the left edge" })
      .toBeLessThanOrEqual(1);

    await release();
    await expect(dock(page)).toHaveAttribute("data-dock-carrying", "false");
  });

  test("lands on the side it was carried to, and the graph takes the other", async ({ page }) => {
    await openCockpit(page, cascaded(), finishedStep());
    await page.waitForSelector(".react-flow__node", { state: "attached" });
    const before = await geometry(page);

    const release = await carryTo(page, 120);
    await release();

    const after = await geometry(page);
    expect(after.side).toBe("left");
    // The two swapped ends of the frame, and neither changed width.
    expect(after.dockLeft).toBeLessThanOrEqual(1);
    expect(after.canvasLeft).toBeGreaterThanOrEqual(after.width - 1);
    expect(after.width).toBe(before.width);
    await boardIsWhole(page);
  });

  test("is still on that side when the board is opened again", async ({ page }) => {
    await openCockpit(page, cascaded(), finishedStep());
    await page.waitForSelector(".react-flow__node", { state: "attached" });
    const release = await carryTo(page, 120);
    await release();
    expect((await geometry(page)).side).toBe("left");

    await page.reload();
    await page.waitForSelector(".react-flow__node", { state: "attached" });
    expect((await geometry(page)).side, "the side is remembered").toBe("left");
    await boardIsWhole(page);
  });

  test("a reader can drag its edge to give the graph more room", async ({ page }) => {
    await openCockpit(page, cascaded(), finishedStep());
    await page.waitForSelector(".react-flow__node", { state: "attached" });
    const before = await geometry(page);

    const edge = page.locator('[data-dock-resizer="true"]');
    const box = await edge.boundingBox();
    if (box === null) throw new Error("no resize edge");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // Rightwards, which narrows a dock anchored to the right edge.
    await page.mouse.move(box.x + 90, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(500);

    const after = await geometry(page);
    expect(after.width, "the dock narrowed").toBeLessThan(before.width);
    expect(after.canvasWidth, "the graph took the difference").toBeGreaterThan(before.canvasWidth);
    await boardIsWhole(page);

    await page.reload();
    await page.waitForSelector(".react-flow__node", { state: "attached" });
    const reopened = await geometry(page);
    expect(Math.abs(reopened.width - after.width), "the width is remembered").toBeLessThanOrEqual(
      2,
    );
  });

  test("collapses to a rail that still reports whether anything is out of date", async ({
    page,
  }) => {
    await openCockpit(page, cascaded(), finishedStep());
    await page.waitForSelector(".react-flow__node", { state: "attached" });
    const before = await geometry(page);

    await page.getByRole("button", { name: /hide the panel/i }).click();
    await page.waitForTimeout(500);

    const rail = page.locator('[data-dock="rail"]');
    await expect(rail).toBeVisible();
    // The one fact a reader must not lose by collapsing the panel.
    await expect(rail).toContainText("3 out of date");
    const collapsed = await geometry(page);
    expect(collapsed.canvasWidth, "the graph took the room").toBeGreaterThan(before.canvasWidth);
    await boardIsWhole(page);

    await page.getByRole("button", { name: /open the panel/i }).click();
    await page.waitForTimeout(500);
    await expect(dock(page)).toBeVisible();
    await boardIsWhole(page);
  });

  test("moves by keyboard, for a reader who is not dragging anything", async ({ page }) => {
    await openCockpit(page, cascaded(), finishedStep());
    await page.waitForSelector(".react-flow__node", { state: "attached" });

    await page.getByRole("button", { name: /move the panel to the left/i }).click();
    await page.waitForTimeout(400);
    expect((await geometry(page)).side).toBe("left");
    await boardIsWhole(page);

    await page.getByRole("button", { name: /move the panel to the right/i }).click();
    await page.waitForTimeout(400);
    expect((await geometry(page)).side).toBe("right");
    await boardIsWhole(page);
  });
});
