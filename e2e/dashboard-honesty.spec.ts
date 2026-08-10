import { expect, test } from "@playwright/test";

import { idle } from "./fixtures/activity";
import { calm, cascaded, empty, repaired } from "./fixtures/swarm";
import { obselAlert, openDashboard } from "./fixtures/mount";
import { cascadeSteps, longRun, manyDecisions } from "./fixtures/trace";

/**
 * What the page refuses to say.
 *
 * A failed read withholds every number rather than showing an old one, and the
 * activity feed narrates only what the coordinator actually did.
 */

test.describe("honesty", () => {
  test("a failed read withholds every measured number", async ({ page }) => {
    const { serve } = await openDashboard(page, cascaded());

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

    // No "tagged" after the ratio: the cell's own label is "written into
    // DataHub", and the word restated it while pushing the value onto two lines.
    await expect.poll(readRibbon).toEqual(["118ms", "3 of 3"]);

    serve("fail");

    // Polled, not measured once: the dashboard only learns the read failed on its
    // next tick, up to POLL_MS later. Asserting immediately after `serve` is a
    // race that passes or fails on scheduling rather than on behavior.
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

    await openDashboard(page, cascaded());
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
    await openDashboard(page, cascaded());

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
    const { serve } = await openDashboard(page, cascaded());
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
    await openDashboard(page, repaired(), idle());
    await expect(page.getByRole("button", { name: "Reset and start over" })).toBeVisible();
  });

  test("a board that has only run is not offered the way back", async ({ page }) => {
    // The other half: the gate still exists, so a first-run board is not offered
    // a button that throws away the run it just waited for.
    await openDashboard(page, calm(), idle());
    await expect(page.getByRole("button", { name: "Reset and start over" })).toBeHidden();
  });

  test("one action carries the accent, and every action is the same size", async ({ page }) => {
    await openDashboard(page, cascaded(), idle());
    const seen = await page
      .locator("main button[data-tour-action] span:first-child")
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const style = getComputedStyle(node);
          return { color: style.color, size: style.fontSize };
        }),
      );

    expect(seen.length).toBeGreaterThan(1);
    // Hierarchy is spent on color, never on size: three guides failed by putting
    // what mattered at footnote size, and `docs/verification.md` measured it.
    expect(new Set(seen.map((entry) => entry.size)).size).toBe(1);
    // And exactly one color occurs once. Asserted as singular rather than as a
    // hex value, so retuning the palette does not fail this.
    const colors = seen.map((entry) => entry.color);
    const once = colors.filter((color) => colors.filter((other) => other === color).length === 1);
    expect(once).toHaveLength(1);
  });

  test("the board says which board it is, and how to open a different one", async ({ page }) => {
    await openDashboard(page, calm(), idle());
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
    const { serve, serveActivity } = await openDashboard(page, cascaded());
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
    await expect(page.getByText("This page lost its connection")).toBeVisible();
  });

  test("the demo read failing on its own still says the board is fine", async ({ page }) => {
    // The other half of the same condition, and the reason the sentence exists:
    // with the swarm read working, the graph below really is current.
    const { serveActivity } = await openDashboard(page, cascaded());
    serveActivity("fail");

    await expect(page.getByText("The board below is unaffected")).toBeVisible();
    await expect(obselAlert(page)).toBeHidden();
  });

  test("an empty swarm does not claim to be connected after a read fails", async ({ page }) => {
    const { serve } = await openDashboard(page, empty());
    await expect(page.getByText("obsel is connected")).toBeVisible();

    serve("fail");
    await expect(obselAlert(page)).toBeVisible();
    await expect(page.getByText("obsel is connected")).toBeHidden();
  });

  test("the calm state never renders the stale amber", async ({ page }) => {
    await openDashboard(page, calm());

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
     * And the board says so in words, not only in color. This used to look for
     * "nothing to explain", which was the empty state of the changes-between-
     * reads panel the live trace replaced; the calm statement now comes from the
     * guide's own headline, derived from the same snapshot.
     */
    await expect(page.getByRole("heading", { name: /nothing out of date/ })).toBeVisible();
  });
});

test.describe("what obsel is doing", () => {
  test("the coordinator's steps render in the order it performed them", async ({ page }) => {
    await openDashboard(page, cascaded(), idle(), cascadeSteps());

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
    await openDashboard(page, cascaded(), idle(), cascadeSteps());

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
    await openDashboard(page, cascaded(), idle(), manyDecisions());
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
    await openDashboard(page, cascaded(), idle(), longRun(10));
    await page.waitForSelector('[aria-label="What obsel is doing"] ol li', { state: "attached" });
    const full = await onScreen();

    await openDashboard(page, cascaded(), idle(), longRun(50));
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
    const { serveTrace } = await openDashboard(page, cascaded(), idle(), cascadeSteps());
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
