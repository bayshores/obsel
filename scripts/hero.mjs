/**
 * Compose the README's hero: app windows pile up into a montage, the pile
 * blurs back to hold the lockup, and everything fades out so the loop seams.
 *
 *     node scripts/hero.mjs <cascade.webm> <repair.webm> <output-dir>
 *
 * The two takes are the ones `scripts/record.mjs` writes. Three more clips —
 * the history tab, the erasure tab, the bring-your-own-data tab — are filmed
 * here, live, so obsel and its board must be up. Each card is a FULL window
 * of the page in timelapse, uncropped, overlapping the ones before it: a
 * pile of instances, not a grid of regions.
 *
 * The whole picture is composed in one browser page — the six clips as muted
 * `<video>` cards, the blur and the closing fade as animations on wrappers,
 * the lockup on top — and stepped: every animation is paused and seeked to
 * each frame's time, every video seeked to match, then the page is
 * screenshotted. One renderer means the card landings, the focus pull, the
 * lockup and the fade all share one clock, and frame N of a re-run is frame N.
 * The stage starts and ends black, so the loop's seam is invisible by
 * construction. ffmpeg's only job is the palette.
 *
 * The clips are re-encoded VP9 because the frames are shot in Playwright's
 * Chromium, which ships without the proprietary codecs; an H.264 card would
 * render as a black rectangle and say nothing about why.
 *
 * The lockup's motion is not invented here. The geometry is parsed out of
 * `mark-geometry.ts`, and every value — the gathered/rest/open states, the
 * two easings, the stagger and the ghost — is transcribed from `mark.tsx`
 * and `brand.tsx`. The one liberty is the loop itself: the header never
 * plays its entrance (`brand.tsx` says why), and here it plays every cycle.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { chromium } from "@playwright/test";

const [CASCADE, REPAIR, OUT] = process.argv.slice(2);
if (!CASCADE || !REPAIR || !OUT) {
  throw new Error("usage: node scripts/hero.mjs <cascade.webm> <repair.webm> <output-dir>");
}
mkdirSync(`${OUT}/frames`, { recursive: true });

const T = 9600;
const FPS = 20;
const FRAMES = (T / 1000) * FPS;

const ff = (...args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);

// ─── the three clips the takes do not hold, filmed live ──────────────────

const browser = await chromium.launch();

async function film(drive) {
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    recordVideo: { dir: OUT, size: { width: 1600, height: 900 } },
  });
  const tab = await ctx.newPage();
  await tab.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await tab.waitForTimeout(2500);
  await drive(tab);
  const video = tab.video();
  await ctx.close();
  return video.path();
}

const historyClip = await film(async (tab) => {
  await tab.getByRole("tab", { name: "history" }).click();
  await tab.waitForTimeout(4000);
  await tab.mouse.wheel(0, 300);
  await tab.waitForTimeout(3000);
  await tab.mouse.wheel(0, 400);
  await tab.waitForTimeout(4000);
});
const erasureClip = await film(async (tab) => {
  await tab.getByRole("tab", { name: "erasure" }).click();
  await tab.waitForTimeout(4000);
  await tab.locator(".react-flow__node").first().hover();
  await tab.waitForTimeout(3000);
  await tab.locator(".react-flow__node").nth(3).hover();
  await tab.waitForTimeout(4000);
});
const yourDataClip = await film(async (tab) => {
  await tab.getByRole("tab", { name: "your data" }).click();
  await tab.waitForTimeout(3000);
  await tab
    .getByText("add a task", { exact: true })
    .click()
    .catch(() => {});
  await tab.waitForTimeout(4000);
  await tab.mouse.wheel(0, 250);
  await tab.waitForTimeout(4000);
});
console.log("filmed the history, erasure and your-data clips");

// ─── the cards: whole windows, sped to fill the loop ─────────────────────

function card(source, start, length, out) {
  ff(
    "-ss",
    String(start),
    "-t",
    String(length),
    "-i",
    source,
    "-vf",
    `setpts=(PTS-STARTPTS)/(${length}/${T / 1000}),fps=${FPS},scale=680:382`,
    "-an",
    "-c:v",
    "libvpx-vp9",
    "-crf",
    "34",
    "-b:v",
    "0",
    `${out}`,
  );
}
card(CASCADE, 12, 24, `${OUT}/c0.webm`); // the swarm working
card(historyClip, 2, 12, `${OUT}/c1.webm`); // what obsel decided
card(CASCADE, 60, 16, `${OUT}/c2.webm`); // the cascade landing
card(REPAIR, 22, 16, `${OUT}/c3.webm`); // the flags coming off
card(erasureClip, 2, 12, `${OUT}/c4.webm`); // the erasure walk
card(yourDataClip, 2, 12, `${OUT}/c5.webm`); // bring your own data
console.log("encoded the six cards");

// ─── the stage ───────────────────────────────────────────────────────────

const geometry = readFileSync("src/features/dashboard/brand/mark-geometry.ts", "utf8");
const bowl = geometry.match(/MARK_BOWL =\n?\s*"([^"]+)"/)[1];
const viewBox = geometry.match(/MARK_VIEWBOX = "([^"]+)"/)[1];
const grains = [...geometry.matchAll(/^\s{2}"(M[^"]+)",$/gm)].map((m) => m[1]);
if (grains.length !== 41) throw new Error(`expected 41 grains, got ${grains.length}`);

const font = `${process.cwd()}/node_modules/geist/dist/fonts/geist-mono/GeistMono-Medium.woff2`;

/*
 * Where each card lands, in arrival order. Overlapping on purpose, edges
 * allowed off the stage, the later card always on top: a deck being dealt.
 * Axis-aligned and square-cornered, because the product is.
 */
const CARDS = [
  { x: 40, y: 70 },
  { x: 500, y: -30 },
  { x: -60, y: 330 },
  { x: 650, y: 290 },
  { x: 150, y: -70 },
  { x: 310, y: 160 },
];

const page = `<!doctype html><meta charset="utf-8">
<style>
@font-face { font-family: GM; src: url("file://${font}") format("woff2"); font-weight: 500; }
html,body { margin:0; }
.stage { position:relative; width:1200px; height:630px; background:#0b0a0e; overflow:hidden; }
/* The pile. Blur and dim animate on this wrapper, so every card keeps playing
   underneath the focus pull. */
.wall { position:absolute; inset:0; }
.card { position:absolute; width:680px; height:382px;
        border:1px solid rgba(245,238,240,0.16); background:#0b0a0e;
        box-shadow:0 18px 48px rgba(0,0,0,0.66); }
.card video { width:100%; height:100%; display:block; }
.scrim { position:absolute; inset:0;
         background:radial-gradient(closest-side at 50% 50%, rgba(5,4,7,0.82), rgba(5,4,7,0.35) 62%, transparent);
         opacity:0; }
.lockup { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; gap:64px; }
svg { overflow:visible; }
.grain,.bowl { transform-box:fill-box; transform-origin:center; }
/* mmux's Wordmark, at hero scale: mono, 500, 0.2em tracking, cream. */
.name { font-family:GM,monospace; font-weight:500; font-size:168px; line-height:1;
        letter-spacing:0.2em; color:#f5eef0; user-select:none; }
.curtain { position:absolute; inset:0; background:#000; opacity:1; }
</style>
<div class="stage">
  <div class="wall">
    ${CARDS.map(
      (c, i) =>
        `<div class="card" data-i="${i}" style="left:${c.x}px;top:${c.y}px">` +
        `<video muted preload="auto" src="file://${OUT}/c${i}.webm"></video></div>`,
    ).join("\n    ")}
  </div>
  <div class="scrim"></div>
  <div class="lockup">
    <svg viewBox="${viewBox}" height="182" width="${(182 * 105.84) / 100.11}" fill="#f5eef0">
      <path class="bowl" d="${bowl}"/>
      ${grains.map((d, i) => `<path class="grain" data-i="${i}" d="${d}"/>`).join("\n      ")}
    </svg>
    <span class="name">obsel</span>
  </div>
  <div class="curtain"></div>
</div>
<script>
const T = ${T};
// mark.tsx's SETTLE and DISPERSE, verbatim. SETTLE is also mmux's landing
// curve, so the cards borrow it.
const SETTLE = "cubic-bezier(0.22,0.61,0.36,1)";
const DISPERSE = "cubic-bezier(0.33,0.9,0.4,1)";
const opts = { duration: T, fill: "both", iterations: 1 };

// Each card lands on the pile: a fade with a small drop and settle.
document.querySelectorAll(".card").forEach((el) => {
  const i = Number(el.dataset.i);
  const t0 = 250 + i * 400, t1 = t0 + 420;
  const off = { opacity: 0, transform: "translateY(16px) scale(1.03)" };
  const on = { opacity: 1, transform: "translateY(0px) scale(1)" };
  el.animate([
    { ...off, offset: 0 },
    { ...off, offset: t0 / T, easing: SETTLE },
    { ...on, offset: t1 / T },
    { ...on, offset: 1 },
  ], opts);
});

// The focus pull: the whole pile softens while every card keeps playing.
const sharp = { filter: "blur(0px) brightness(1)" };
const soft = { filter: "blur(6px) brightness(0.72)" };
document.querySelector(".wall").animate([
  { ...sharp, offset: 0 },
  { ...sharp, offset: 2900 / T, easing: SETTLE },
  { ...soft, offset: 3600 / T },
  { ...soft, offset: 1 },
], opts);
document.querySelector(".scrim").animate([
  { opacity: 0, offset: 0 },
  { opacity: 0, offset: 2900 / T, easing: SETTLE },
  { opacity: 1, offset: 3600 / T },
  { opacity: 1, offset: 1 },
], opts);

function grainFrames(i) {
  // gathered / rest / open, from mark.tsx's GRAIN variants.
  const g = { transform: \`translate(\${-4 - i * 0.42}px,0px) scale(0.3)\`, opacity: 0 };
  const r = { transform: "translate(0px,0px) scale(1)", opacity: 1 };
  const o = { transform: \`translate(\${3 + i * 0.5}px,\${Math.sin(i * 2.399) * 3.5}px) scale(0.78)\`, opacity: 0.5 };
  const t1 = 3380 + i * 12, t2 = t1 + 500;  // assemble, once the pile has blurred
  const t3 = 4800 + i * 6, t4 = t3 + 340;   // open
  const t5 = 7100 + i * 6, t6 = t5 + 340;   // close
  const t7 = 7700 + i * 6, t8 = t7 + 340;   // dissolve, so the loop ends where it began
  return [
    { ...g, offset: 0 },
    { ...g, offset: t1 / T, easing: SETTLE },
    { ...r, offset: t2 / T },
    { ...r, offset: t3 / T, easing: DISPERSE },
    { ...o, offset: t4 / T },
    { ...o, offset: t5 / T, easing: DISPERSE },
    { ...r, offset: t6 / T },
    { ...r, offset: t7 / T, easing: DISPERSE },
    { ...g, offset: t8 / T },
    { ...g, offset: 1 },
  ];
}
const bowlG = { transform: "scale(0.88)", opacity: 0 };
const bowlR = { transform: "scale(1)", opacity: 1 };
document.querySelector(".bowl").animate([
  { ...bowlG, offset: 0 },
  { ...bowlG, offset: 3300 / T, easing: SETTLE },
  { ...bowlR, offset: 3800 / T },
  { ...bowlR, offset: 7700 / T, easing: SETTLE },
  { ...bowlG, offset: 8200 / T },
  { ...bowlG, offset: 1 },
], opts);
document.querySelectorAll(".grain").forEach((el) =>
  el.animate(grainFrames(Number(el.dataset.i)), opts));
// brand.tsx's NAME and GHOST: the word exists only while the mark is open.
const nameH = { opacity: 0, filter: "blur(4px)", transform: "translateX(-6px)" };
const nameV = { opacity: 1, filter: "blur(0px)", transform: "translateX(0px)" };
document.querySelector(".name").animate([
  { ...nameH, offset: 0 },
  { ...nameH, offset: 4800 / T, easing: SETTLE },
  { ...nameV, offset: 5060 / T },
  { ...nameV, offset: 7100 / T, easing: SETTLE },
  { ...nameH, offset: 7360 / T },
  { ...nameH, offset: 1 },
], opts);

// Black at both ends of the loop: a fast open, and the closing fade.
document.querySelector(".curtain").animate([
  { opacity: 1, offset: 0 },
  { opacity: 0, offset: 180 / T },
  { opacity: 0, offset: 8600 / T, easing: SETTLE },
  { opacity: 1, offset: 9350 / T },
  { opacity: 1, offset: 1 },
], opts);

document.getAnimations().forEach((a) => a.pause());
const videos = [...document.querySelectorAll("video")];
window.ready = Promise.all(
  videos.map((v) => new Promise((res) => v.addEventListener("canplaythrough", res, { once: true }))),
);
window.seek = async (t) => {
  document.getAnimations().forEach((a) => { a.currentTime = t; });
  await Promise.all(videos.map((v) => new Promise((res) => {
    v.addEventListener("seeked", res, { once: true });
    v.currentTime = t / 1000;
  })));
};
</script>`;
writeFileSync(`${OUT}/hero.html`, page);

const shooter = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await shooter.goto(`file://${OUT}/hero.html`);
await shooter.evaluate(() => document.fonts.ready);
await shooter.evaluate(() => window.ready);
for (let f = 0; f < FRAMES; f += 1) {
  await shooter.evaluate((t) => window.seek(t), (f * T) / FRAMES);
  await shooter.screenshot({ path: `${OUT}/frames/f${String(f).padStart(3, "0")}.png` });
}
await browser.close();
console.log(`${FRAMES} frames`);

// ─── the palette ─────────────────────────────────────────────────────────

ff(
  "-framerate",
  String(FPS),
  "-i",
  `${OUT}/frames/f%03d.png`,
  "-filter_complex",
  // No dither: the UI is flat fields of few colors, dithering them adds a
  // shimmer of per-frame noise that costs a megabyte and looks like grain.
  "split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=none",
  "-loop",
  "0",
  `${OUT}/hero.gif`,
);
console.log(`wrote ${OUT}/hero.gif`);
