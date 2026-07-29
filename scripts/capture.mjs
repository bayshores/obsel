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
 * Which board this is, decided by the ribbon rather than by the headline.
 *
 * A first version tested the headline for "out of date", which matches BOTH states:
 * the settled headline is "all 4 finished, nothing out of date". The write-back cell
 * is derived from the marks instead of written as copy, so it cannot be ambiguous:
 * a calm board has nothing to write, and a flagged one reports "N of M tagged".
 *
 * The test is on "tagged" and not on the calm wording, which is what keeps this
 * working across a copy change. The calm cell has been reworded twice since this
 * was written; both times the flagged cell still counted tags, because that half is
 * a count rather than a sentence. Matching the calm string instead would have made
 * every rewrite of it silently save a settled board as flagged.
 *
 * Watch the one collision this has: the leftover-tag wording is "N tags left over
 * from before", which must NOT match, and does not, because it says "tags" and this
 * asks for "tagged".
 */
const flagged = /tagged/.test(state.written ?? "");
if ((which === "flagged") !== flagged) {
  throw new Error(
    `refusing to save the ${flagged ? "flagged" : "settled"} board as ${which}: ` +
      `headline "${state.headline}", ribbon "${state.written}"`,
  );
}

await page.screenshot({ path: `docs/images/${which}.png` });
await browser.close();
