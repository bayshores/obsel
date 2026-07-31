/**
 * Compose the README's hero: a wall of the app at work, tile by tile, which
 * blurs back to hold the lockup, and then empties so the loop is seamless.
 *
 *     node scripts/hero.mjs <cascade.webm> <repair.webm> <output-dir>
 *
 * The two takes are the ones `scripts/record.mjs` writes. The other three
 * tiles — the history tab, the erasure tab, the bring-your-own-data tab — are
 * filmed here, live, so obsel and its board must be up. Each tile is a
 * different region of the page in timelapse: two of the graph, two of the
 * panel, one of the feed, one of the erasure walk, so the wall reads as many
 * parts of one product rather than six copies of a screenshot.
 *
 * The blur is a per-pixel blend between the sharp wall and a blurred, dimmed,
 * scrimmed copy of the SAME wall, driven by time. A crossfade between two
 * files would restart the tiles' motion at the seam; a blend keeps every tile
 * playing continuously while the focus pulls back.
 *
 * The lockup's motion is not invented here. The geometry is parsed out of
 * `mark-geometry.ts`, and every value — the gathered/rest/open states, the
 * two easings, the stagger and the ghost — is transcribed from `mark.tsx` and
 * `brand.tsx`. The one liberty is the loop itself: the header never plays its
 * entrance (`brand.tsx` says why), and here it plays on every cycle.
 *
 * Frames are stepped, not recorded: the page's animations are paused and
 * seeked to each frame's time, then screenshotted with alpha. The wall starts
 * black and fades back to black, so the loop's last frame and first frame
 * agree by construction.
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

// ─── the lockup, from the repository's own geometry and motion ───────────

const geometry = readFileSync("src/features/dashboard/brand/mark-geometry.ts", "utf8");
const bowl = geometry.match(/MARK_BOWL =\n?\s*"([^"]+)"/)[1];
const viewBox = geometry.match(/MARK_VIEWBOX = "([^"]+)"/)[1];
const grains = [...geometry.matchAll(/^\s{2}"(M[^"]+)",$/gm)].map((m) => m[1]);
if (grains.length !== 41) throw new Error(`expected 41 grains, got ${grains.length}`);

const font = `${process.cwd()}/node_modules/geist/dist/fonts/geist-mono/GeistMono-Medium.woff2`;

const page = `<!doctype html><meta charset="utf-8">
<style>
@font-face { font-family: GM; src: url("file://${font}") format("woff2"); font-weight: 500; }
html,body { margin:0; background:transparent; }
.stage { width:1200px; height:630px; display:flex; align-items:center; justify-content:center; gap:64px; }
svg { overflow:visible; }
.grain,.bowl { transform-box:fill-box; transform-origin:center; }
/* mmux's Wordmark, at hero scale: mono, 500, 0.2em tracking, cream. */
.name { font-family:GM,monospace; font-weight:500; font-size:168px; line-height:1;
        letter-spacing:0.2em; color:#f5eef0; user-select:none; }
</style>
<div class="stage">
  <svg viewBox="${viewBox}" height="182" width="${(182 * 105.84) / 100.11}" fill="#f5eef0">
    <path class="bowl" d="${bowl}"/>
    ${grains.map((d, i) => `<path class="grain" data-i="${i}" d="${d}"/>`).join("\n    ")}
  </svg>
  <span class="name">obsel</span>
</div>
<script>
const T = ${T};
// mark.tsx's SETTLE and DISPERSE, verbatim.
const SETTLE = "cubic-bezier(0.22,0.61,0.36,1)";
const DISPERSE = "cubic-bezier(0.33,0.9,0.4,1)";
function grainFrames(i) {
  // gathered / rest / open, from mark.tsx's GRAIN variants.
  const g = { transform: \`translate(\${-4 - i * 0.42}px,0px) scale(0.3)\`, opacity: 0 };
  const r = { transform: "translate(0px,0px) scale(1)", opacity: 1 };
  const o = { transform: \`translate(\${3 + i * 0.5}px,\${Math.sin(i * 2.399) * 3.5}px) scale(0.78)\`, opacity: 0.5 };
  const t1 = 3380 + i * 12, t2 = t1 + 500;  // assemble, once the wall has blurred
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
const bowlFrames = [
  { ...bowlG, offset: 0 },
  { ...bowlG, offset: 3300 / T, easing: SETTLE },
  { ...bowlR, offset: 3800 / T },
  { ...bowlR, offset: 7700 / T, easing: SETTLE },
  { ...bowlG, offset: 8200 / T },
  { ...bowlG, offset: 1 },
];
// brand.tsx's NAME and GHOST: the word exists only while the mark is open.
const nameH = { opacity: 0, filter: "blur(4px)", transform: "translateX(-6px)" };
const nameV = { opacity: 1, filter: "blur(0px)", transform: "translateX(0px)" };
const nameFrames = [
  { ...nameH, offset: 0 },
  { ...nameH, offset: 4800 / T, easing: SETTLE },
  { ...nameV, offset: 5060 / T },
  { ...nameV, offset: 7100 / T, easing: SETTLE },
  { ...nameH, offset: 7360 / T },
  { ...nameH, offset: 1 },
];
const opts = { duration: T, fill: "both", iterations: 1 };
document.querySelector(".bowl").animate(bowlFrames, opts);
document.querySelectorAll(".grain").forEach((el) =>
  el.animate(grainFrames(Number(el.dataset.i)), opts));
document.querySelector(".name").animate(nameFrames, opts);
document.getAnimations().forEach((a) => a.pause());
window.seek = (t) => document.getAnimations().forEach((a) => { a.currentTime = t; });
</script>`;
writeFileSync(`${OUT}/hero.html`, page);

const browser = await chromium.launch();

const shooter = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await shooter.goto(`file://${OUT}/hero.html`);
await shooter.evaluate(() => document.fonts.ready);
for (let f = 0; f < FRAMES; f += 1) {
  await shooter.evaluate((t) => window.seek(t), (f * T) / FRAMES);
  await shooter.screenshot({
    path: `${OUT}/frames/f${String(f).padStart(3, "0")}.png`,
    omitBackground: true,
  });
}
await shooter.close();
console.log(`${FRAMES} lockup frames`);

// ─── the three tiles the takes do not hold, filmed live ──────────────────

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
await browser.close();
console.log("filmed the history, erasure and your-data clips");

// ─── the wall ────────────────────────────────────────────────────────────

const ff = (...args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);

/**
 * One tile: a window into a take, sped to fill the whole loop, cropped to one
 * region of the page so six tiles show six parts of the product.
 */
function tile(source, start, length, crop, out) {
  ff(
    "-ss",
    String(start),
    "-t",
    String(length),
    "-i",
    source,
    "-vf",
    `setpts=(PTS-STARTPTS)/(${length}/${T / 1000}),fps=${FPS},crop=${crop},` +
      "scale=398:313,pad=400:315:1:1:black",
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "18",
    out,
  );
}
// Region crops, all at the tile's own 400:315 aspect against a 1600x900 frame.
const GRAPH = "1000:787:60:60";
const GRAPH_RIGHT = "900:709:520:80";
const PANEL = "690:543:905:120";
const FEED = "690:543:905:280";
tile(CASCADE, 12, 24, GRAPH, `${OUT}/t0.mp4`); // the swarm working
tile(historyClip, 2, 12, PANEL, `${OUT}/t1.mp4`); // what obsel decided
tile(CASCADE, 60, 16, GRAPH_RIGHT, `${OUT}/t2.mp4`); // the cascade landing
tile(REPAIR, 22, 16, FEED, `${OUT}/t3.mp4`); // the flags coming off
tile(erasureClip, 2, 12, GRAPH, `${OUT}/t4.mp4`); // the erasure walk
tile(yourDataClip, 2, 12, PANEL, `${OUT}/t5.mp4`); // bring your own data

// Tiles land one per beat; the fade is alpha, over whatever is already there.
const APPEAR = [200, 550, 900, 1250, 1600, 1950].map((ms) => ms / 1000);
const POS = ["0:0", "400:0", "800:0", "0:315", "400:315", "800:315"];
const chain = [];
for (let i = 0; i < 6; i += 1) {
  chain.push(
    `[${i + 1}]format=rgba,fade=t=in:st=${APPEAR[i]}:d=0.32:alpha=1[f${i}];` +
      `[${i === 0 ? "base" : `w${i - 1}`}][f${i}]overlay=${POS[i]}:format=auto[w${i}]`,
  );
}
ff(
  "-f",
  "lavfi",
  "-i",
  `color=black:s=1200x630:d=${T / 1000}:r=${FPS}`,
  ...[0, 1, 2, 3, 4, 5].flatMap((i) => ["-i", `${OUT}/t${i}.mp4`]),
  "-filter_complex",
  `[0]null[base];${chain.join(";")}`,
  "-map",
  "[w5]",
  "-c:v",
  "libx264",
  "-preset",
  "fast",
  "-crf",
  "18",
  `${OUT}/wall.mp4`,
);

// A soft dark ellipse under the lockup, baked into the blurred copy only, so
// the sharp wall carries no shadow of a logo that is not there yet.
ff(
  "-f",
  "lavfi",
  "-i",
  "color=black@0.0:s=1200x630,format=rgba",
  "-vf",
  "geq=r=0:g=0:b=0:a='205*exp(-(pow(X-600,2)/pow(400,2)+pow(Y-315,2)/pow(165,2)))'",
  "-frames:v",
  "1",
  `${OUT}/scrim.png`,
);
// Sigma 3.5 with a slight gamma lift, measured against this footage: at 7 the
// board's sparse light averaged into the black and the wall vanished behind
// the lockup, which defeats a hero whose subject is the wall.
ff(
  "-i",
  `${OUT}/wall.mp4`,
  "-i",
  `${OUT}/scrim.png`,
  "-filter_complex",
  "[0]gblur=sigma=3.5,eq=gamma=1.15:saturation=0.9:brightness=-0.02[b];[b][1]overlay=format=auto",
  "-c:v",
  "libx264",
  "-preset",
  "fast",
  "-crf",
  "18",
  `${OUT}/wall-blur.mp4`,
);

// ─── the composite ───────────────────────────────────────────────────────

// The focus pull: per-pixel blend from the sharp wall to the blurred one over
// 2.7 s..3.5 s, both playing the same timeline, so no tile's motion jumps.
//
// Two passes, and the second is not cosmetic. With the blend, the fade and
// the palette in one filter graph, the closing fade stopped applying past
// ~9.0 s and the GIF's last frames held a half-faded wall — a visible pop at
// the loop seam, since frame one is black. Encoding the composite first and
// paletting it as its own pass keeps the tail black; measured both ways on
// the same inputs before this was split.
const MIX = "min(max((T-2.7)/0.8,0),1)";
ff(
  "-i",
  `${OUT}/wall.mp4`,
  "-i",
  `${OUT}/wall-blur.mp4`,
  "-framerate",
  String(FPS),
  "-i",
  `${OUT}/frames/f%03d.png`,
  "-filter_complex",
  `[0][1]blend=all_expr='A+(B-A)*${MIX}'[wall];` +
    // 15 fps out, from the 20 fps timeline: the tiles are timelapse and the
    // GIF is the README's first download, so the frames the eye cannot use are
    // the cheapest megabyte to give back.
    "[wall][2]overlay=format=auto,fade=t=out:st=8.6:d=0.75,fps=15",
  "-c:v",
  "libx264",
  "-preset",
  "fast",
  "-crf",
  "18",
  `${OUT}/comp.mp4`,
);
ff(
  "-i",
  `${OUT}/comp.mp4`,
  "-filter_complex",
  "split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5",
  "-loop",
  "0",
  `${OUT}/hero.gif`,
);

console.log(`wrote ${OUT}/hero.gif`);
