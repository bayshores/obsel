import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { codexSignedOut, idle, runningStep } from "./fixtures/activity";
import { calm, cascaded, empty } from "./fixtures/swarm";
import { openCockpit } from "./fixtures/mount";
import { cascadeSteps } from "./fixtures/trace";

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

/** The per-character advances graph/layout.ts reserves box widths from. */
const ADVANCE: Record<number, number> = { 10: 6.28, 11: 6.885, 13: 8.06 };

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

  test("the ADVANCE table is true of the face that actually rendered", async ({ page }) => {
    await openCockpit(page, cascaded());

    const samples = await page.evaluate(() => {
      const out: { text: string; size: number; perChar: number }[] = [];
      for (const node of document.querySelectorAll("main svg text")) {
        const text = node.textContent ?? "";
        // Skip anything non-ASCII: U+00B7 is narrower than a Geist Mono cell,
        // so length × advance over-reserves. That is the safe direction and the
        // check must not be bent to accommodate it.
        if (text.length === 0 || !/^[\x20-\x7e]+$/.test(text)) continue;
        const size = Math.round(Number.parseFloat(getComputedStyle(node).fontSize));
        out.push({ text, size, perChar: (node as SVGTextElement).getBBox().width / text.length });
      }
      return out;
    });

    expect(samples.length, "should have measured some text").toBeGreaterThan(3);
    for (const s of samples) {
      const expected = ADVANCE[s.size];
      expect(expected, `no ADVANCE entry for ${s.size}px ("${s.text}")`).toBeDefined();
      const drift = Math.abs(s.perChar - expected) / expected;
      expect(drift, `"${s.text}" at ${s.size}px measured ${s.perChar.toFixed(3)}`).toBeLessThan(
        0.01,
      );
    }

    // This is the only assertion in the project that can falsify the unit
    // suite: if the face changes, tests/cockpit-layout.test.ts keeps passing
    // against a table that no longer describes reality, and text clips on
    // camera.
  });

  test("no text escapes its box, in pixels", async ({ page }) => {
    await openCockpit(page, cascaded());

    const overflows = await page.evaluate(() => {
      const bad: string[] = [];
      for (const group of document.querySelectorAll("main svg g")) {
        const rect = group.querySelector("rect");
        if (rect === null) continue;
        const rx = Number(rect.getAttribute("x"));
        const rw = Number(rect.getAttribute("width"));
        for (const node of group.querySelectorAll("text")) {
          if (node.classList.length > 0 && node.textContent?.startsWith("changed")) continue;
          const box = (node as SVGTextElement).getBBox();
          if (box.x < rx - 0.5 || box.x + box.width > rx + rw + 0.5) {
            bad.push(`${node.textContent ?? ""} (${box.width.toFixed(1)} in ${rw})`);
          }
        }
      }
      return bad;
    });

    expect(overflows).toEqual([]);
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
      // The recording frame: everything, ledger and ribbon included, on screen.
      expect(
        box.scrollH,
        `vertical fit at ${viewport?.width}x${viewport?.height}`,
      ).toBeLessThanOrEqual(box.clientH + 1);
    } else {
      // A laptop may scroll, but what orients a newcomer — the guide and the
      // whole graph — must be above the fold, not something they discover.
      const tops = await page.evaluate(() => {
        const guide = document.querySelector("main > section");
        const graph = document.querySelector("main svg")?.closest("section");
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

  test("no reason sentence is clipped or ellipsised", async ({ page }) => {
    await openCockpit(page, cascaded());

    const clipped = await page.evaluate(() => {
      const bad: string[] = [];
      for (const p of document.querySelectorAll('[aria-label="Cascade ledger"] li p')) {
        const el = p as HTMLElement;
        if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) {
          bad.push(el.textContent ?? "");
        }
        if (getComputedStyle(el).textOverflow === "ellipsis")
          bad.push(`ellipsis: ${el.textContent}`);
      }
      return bad;
    });

    expect(clipped).toEqual([]);
  });

  test("opening the inspector moves nothing in the graph or the ledger", async ({ page }) => {
    await openCockpit(page, cascaded());

    const measure = () =>
      page.evaluate(() => {
        const svg = document.querySelector("main svg");
        // Scoped to the ledger. `main li` also matches the feed's rows and the
        // inspector's URN lists, which DO appear when the inspector opens —
        // that is the panel doing its job, not the ledger moving.
        const rows = [...document.querySelectorAll('[aria-label="Cascade ledger"] li')];
        return {
          graph: svg?.getBoundingClientRect().height ?? 0,
          rowTops: rows.map((r) => Math.round(r.getBoundingClientRect().top)),
          scrollH: document.documentElement.scrollHeight,
        };
      });

    const before = await measure();
    await page.getByRole("button", { name: "inspect" }).first().click();
    await expect(page.getByText("task urn")).toBeVisible();
    const after = await measure();

    expect(after.graph).toBe(before.graph);
    expect(after.rowTops).toEqual(before.rowTops);
    expect(after.scrollH).toBe(before.scrollH);
  });
});

test.describe("honesty", () => {
  test("a failed read withholds every measured number", async ({ page }) => {
    const { serve } = await openCockpit(page, cascaded());

    // Every stat cell value, read out of the ribbon.
    const readRibbon = () =>
      page.evaluate(() => {
        // Scoped to the ribbon. Unscoped, "out of date" matches the ledger
        // row's status word first and reads a value out of the wrong element.
        const ribbon = document.querySelector('[aria-label="Swarm totals"]');
        if (ribbon === null) return ["NO RIBBON"];
        const labels = ["tasks", "finished", "out of date", "deepest reach", "detection time"];
        return labels.map((label) => {
          const span = [...ribbon.querySelectorAll("span")].find((s) => s.textContent === label);
          const cell = span?.closest("div");
          const value = cell?.querySelectorAll("span")[1];
          return value?.textContent ?? "MISSING";
        });
      });

    await expect.poll(readRibbon).toEqual(["4", "4", "3", "2hops", "118ms"]);

    serve("fail");

    // Polled, not measured once: the cockpit only learns the read failed on its
    // next tick, up to POLL_MS later. Asserting immediately after `serve` is a
    // race that passes or fails on scheduling rather than on behaviour.
    // Not "most" of the numbers — all five.
    await expect.poll(readRibbon, { timeout: 8_000 }).toEqual(["—", "—", "—", "—", "—"]);
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
    await expect(page.getByText("nothing out of date")).toBeVisible();
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

  test("the cascade animation lands and holds its end state", async ({ page }) => {
    await openCockpit(page, cascaded());
    // longer than the 400ms draw plus the 400ms maximum stagger
    await page.waitForTimeout(1200);

    const edges = await page.evaluate(() =>
      [...document.querySelectorAll("main svg path")]
        .filter((p) => getComputedStyle(p).animationName.includes("draw-edge"))
        .map((p) => ({
          offset: getComputedStyle(p).strokeDashoffset,
          fill: getComputedStyle(p).animationFillMode,
        })),
    );

    expect(edges.length, "the cascade should light some edges").toBeGreaterThan(0);
    for (const edge of edges) {
      // Without fill-mode forwards the keyframe REVERTS and every lit edge
      // silently disappears when the run ends.
      expect(edge.fill).toBe("forwards");
      expect(Number.parseFloat(edge.offset)).toBeCloseTo(0, 2);
    }
  });

  test("reduced motion still leaves the cascade drawn", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openCockpit(page, cascaded());

    const state = await page.evaluate(() =>
      [...document.querySelectorAll("main svg path")]
        .filter((p) => [...p.classList].some((c) => c.includes("edgeCascade")))
        .map((p) => Number.parseFloat(getComputedStyle(p).strokeDashoffset)),
    );

    expect(state.length).toBeGreaterThan(0);
    // Cancelling the animation without declaring the end state would leave
    // every lit edge invisible — the exact bug the reduced-motion block exists
    // to prevent.
    for (const offset of state) expect(offset).toBeCloseTo(0, 2);
  });
});

test.describe("guide", () => {
  test("an empty swarm offers register, and the click launches the real step", async ({ page }) => {
    const { launches } = await openCockpit(page, empty());

    const button = page.getByRole("button", { name: /Set up the four agents/ });
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

    await expect(page.getByText("finished work just went out of date")).toBeVisible();
    await expect(page.getByText(/never read the changed table/)).toBeVisible();
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

    await expect(page.getByText("one-time preparation")).toBeVisible();
    await expect(page.getByText("codex login", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Run the orders cleaner again/ })).toHaveCount(0);
  });

  test("while a step runs the buttons go away and its own output streams", async ({ page }) => {
    await openCockpit(page, calm(), runningStep("rerun-same"));

    await expect(page.getByText("rerun-same is live")).toBeVisible();
    await expect(page.getByText("rerun-same: started")).toBeVisible();
    await expect(page.getByRole("button", { name: /Run the orders cleaner again/ })).toHaveCount(0);
  });
});

test.describe("what obsel is doing", () => {
  test("the coordinator's steps render in the order it performed them", async ({ page }) => {
    await openCockpit(page, cascaded(), idle(), cascadeSteps());

    // Every step, in a browser, from the same shape `/api/trace` serves.
    await expect(page.getByText("Read the swarm from DataHub.")).toBeVisible();
    await expect(page.getByText("its columns changed; the values did not")).toBeVisible();
    await expect(page.getByText(/Walked the lineage graph/)).toBeVisible();
    await expect(page.getByText(/Marked Daily revenue out of date/)).toBeVisible();

    /*
     * Oldest first. A cascade only makes sense read forwards — the comparison
     * that found the change, then the walk, then the marks it caused — so a
     * panel that put the newest on top would show every mark above its own
     * cause. Asserted on the rendered vertical positions rather than on the DOM
     * order, because a `column-reverse` would satisfy one and not the other.
     */
    const tops = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("main ol li")];
      return rows.map((r) => Math.round(r.getBoundingClientRect().top));
    });
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
          const list = document.querySelector("main ol");
          if (list === null) return null;
          return list.scrollHeight - list.scrollTop - list.clientHeight;
        }),
      )
      .toBeLessThanOrEqual(48);
  });

  test("a failed trace read empties the panel and leaves the board alone", async ({ page }) => {
    const { serveTrace } = await openCockpit(page, cascaded(), idle(), cascadeSteps());
    await expect(page.getByText("Read the swarm from DataHub.")).toBeVisible();

    serveTrace("fail");

    // The steps go, because a step list held over from a read that is no longer
    // working is a claim about what obsel is doing now that nobody can support.
    await expect(page.getByText("Read the swarm from DataHub.")).toHaveCount(0);
    await expect(page.getByText(/could not be read/)).toBeVisible();
    // The swarm read is a different endpoint and is still healthy, so every
    // measured number stays exactly where it was.
    await expect(page.getByText("connected")).toBeVisible();
    await expect(page.getByText(/never read the changed table/)).toBeVisible();
  });
});
