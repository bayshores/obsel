/**
 * Capture one of the two board screenshots in `docs/images/`.
 *
 *   node scripts/capture.mjs settled    # after `run`, before `change`
 *   node scripts/capture.mjs flagged    # after `change`
 *
 * Needs `pnpm dev` running against a live DataHub. It photographs whatever the board
 * actually shows, so the two shots have to be taken from **one run**, in that order,
 * with nothing between them but the change itself. Two shots from two runs would be
 * two different pipelines presented as one, which is the kind of quiet inconsistency
 * obsel exists to catch. `docs/images/README.md` holds the rest of the spec.
 *
 * 1920 x 990 is the recording viewport the page is laid out for and the size
 * `pnpm e2e`'s `recording-1920x990` project asserts against. `deviceScaleFactor: 2`
 * so the 13px labels survive being scaled down in a README.
 *
 * It refuses to save a mislabelled shot, which is the only real logic in here.
 */

import { chromium } from "@playwright/test";

const which = process.argv[2];
if (which !== "settled" && which !== "flagged") {
  throw new Error("usage: node scripts/capture.mjs settled|flagged");
}

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1920, height: 990 },
  deviceScaleFactor: 2,
});
await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.waitForSelector(".react-flow__edge", { state: "attached", timeout: 20000 });
// Let the poll settle and the fonts swap in, both of which change the layout.
await page.waitForTimeout(3000);

const state = await page.evaluate(() => ({
  headline: document.querySelector("h2")?.textContent ?? null,
  written:
    [...document.querySelectorAll("main span")]
      .find((s) => s.textContent === "written into DataHub")
      ?.closest("div")?.textContent ?? null,
  detection:
    [...document.querySelectorAll("main span")]
      .find((s) => s.textContent === "detection time")
      ?.closest("div")?.textContent ?? null,
  amber: document.querySelectorAll(".react-flow__edge.animated").length,
  docH: document.documentElement.scrollHeight,
  vh: window.innerHeight,
}));
console.log(which, JSON.stringify(state));

/*
 * Which board this is, decided by the marks obsel holds rather than by any words.
 *
 * Two earlier versions read the page. The first tested the headline for "out of
 * date", which matches BOTH states, since the settled headline is "all 4 finished,
 * nothing out of date". The second tested the ribbon's write-back cell for
 * "tagged", on the reasoning that a count is steadier than a sentence — and then
 * `stats.tsx` dropped the word, because "3 of 3 tagged" overflowed the column and
 * the label above it already says "written into DataHub".
 *
 * That second failure was the dangerous one. With nothing matching "tagged" any
 * more, a flagged board reads as calm, so `capture.mjs flagged` refuses to run and
 * `capture.mjs settled` saves a flagged board under the settled name — the exact
 * mislabelling this check exists to prevent, reintroduced by a copy edit that had
 * no reason to think about it.
 *
 * So it no longer reads the page. `/api/swarm` is what the page itself renders
 * from, and a mark is a field rather than a phrase; `scripts/record.mjs` decides
 * its moments from the same read. Copy can now be rewritten freely.
 */
const marks = await fetch("http://localhost:3000/api/swarm")
  .then((res) => {
    if (!res.ok) throw new Error(`swarm read failed: ${res.status}`);
    return res.json();
  })
  .then((body) => body.snapshot.tasks.filter((task) => task.stale !== null).length);

const flagged = marks > 0;
if ((which === "flagged") !== flagged) {
  throw new Error(
    `refusing to save the ${flagged ? "flagged" : "settled"} board as ${which}: ` +
      `obsel holds ${marks} mark(s), headline "${state.headline}", ribbon "${state.written}"`,
  );
}
console.log(`${which}: ${marks} mark(s) on the board`);

await page.screenshot({ path: `docs/images/${which}.png` });
await browser.close();
