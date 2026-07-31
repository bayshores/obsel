/**
 * Compose the README's hero: the mark assembling, naming itself and coming
 * apart, over a timelapse of the app actually working.
 *
 *     node scripts/hero.mjs <cascade.webm> <repair.webm> <output-dir>
 *
 * The two takes are the ones `scripts/record.mjs` writes. The other two
 * situations in the montage — the history tab, the erasure tab — are filmed
 * here, live, so obsel and its board must be up. The montage is five hard-cut
 * segments of 1.5 s; the loop seam is just another cut, which is what makes
 * the GIF loop cleanly without a crossfade.
 *
 * The lockup's motion is not invented here. The geometry is parsed out of
 * `mark-geometry.ts`, and every value — the gathered/rest/open states, the
 * two easings, the stagger and the ghost — is transcribed from `mark.tsx` and
 * `brand.tsx`. The one liberty is the loop itself: the header never plays its
 * entrance (`brand.tsx` says why), and here it plays on every cycle.
 *
 * Frames are stepped, not recorded: the page's animations are paused and
 * seeked to each frame's time, then screenshotted with alpha. A recording
 * would sample whatever the compositor managed; a stepped frame is exact, and
 * the 150th lands back on the 1st by construction.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { chromium } from "@playwright/test";

const [CASCADE, REPAIR, OUT] = process.argv.slice(2);
if (!CASCADE || !REPAIR || !OUT) {
  throw new Error("usage: node scripts/hero.mjs <cascade.webm> <repair.webm> <output-dir>");
}
mkdirSync(`${OUT}/frames`, { recursive: true });

const T = 7500;
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
  const t1 = 380 + i * 12, t2 = t1 + 500;   // assemble: delayChildren .08, stagger .012
  const t3 = 2800 + i * 6, t4 = t3 + 340;   // open: stagger .006
  const t5 = 4900 + i * 6, t6 = t5 + 340;   // close
  const t7 = 6400 + i * 6, t8 = t7 + 340;   // dissolve, so the loop ends where it began
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
  { ...bowlG, offset: 300 / T, easing: SETTLE },
  { ...bowlR, offset: 800 / T },
  { ...bowlR, offset: 6400 / T, easing: SETTLE },
  { ...bowlG, offset: 6900 / T },
  { ...bowlG, offset: 1 },
];
// brand.tsx's NAME and GHOST: the word exists only while the mark is open.
const nameH = { opacity: 0, filter: "blur(4px)", transform: "translateX(-6px)" };
const nameV = { opacity: 1, filter: "blur(0px)", transform: "translateX(0px)" };
const nameFrames = [
  { ...nameH, offset: 0 },
  { ...nameH, offset: 2800 / T, easing: SETTLE },
  { ...nameV, offset: 3060 / T },
  { ...nameV, offset: 4900 / T, easing: SETTLE },
  { ...nameH, offset: 5160 / T },
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

// ─── the two situations the takes do not hold, filmed live ───────────────

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
  await tab.getByRole("tab", { name: "your agent" }).click();
  await tab.waitForTimeout(4000);
});
await browser.close();
console.log("filmed the history and erasure clips");

// ─── the montage, and the composite ──────────────────────────────────────

const ff = (...args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);

function segment(source, start, length, out) {
  ff(
    "-ss",
    String(start),
    "-t",
    String(length),
    "-i",
    source,
    "-vf",
    `setpts=(PTS-STARTPTS)/(${length}/1.5),fps=${FPS},scale=1200:675,crop=1200:630:0:22,` +
      "eq=brightness=-0.16:saturation=0.6,gblur=sigma=1.4",
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
// Five situations, 1.5 s each: the swarm working, the cascade landing, the
// repair clearing, the history record, the erasure walk. The windows into the
// two takes are by offset, so a retake with different timing needs new ones.
segment(CASCADE, 12, 24, `${OUT}/seg1.mp4`);
segment(CASCADE, 63, 10, `${OUT}/seg2.mp4`);
segment(REPAIR, 24, 12, `${OUT}/seg3.mp4`);
segment(historyClip, 2, 12, `${OUT}/seg4.mp4`);
segment(erasureClip, 2, 12, `${OUT}/seg5.mp4`);

writeFileSync(
  `${OUT}/concat.txt`,
  [1, 2, 3, 4, 5].map((n) => `file 'seg${n}.mp4'`).join("\n") + "\n",
);
ff(
  "-f",
  "concat",
  "-safe",
  "0",
  "-i",
  `${OUT}/concat.txt`,
  "-c:v",
  "libx264",
  "-preset",
  "fast",
  "-crf",
  "18",
  `${OUT}/bg.mp4`,
);

// A soft dark ellipse under the lockup, so the footage stays visible at the
// edges and the type stays readable in the middle.
ff(
  "-f",
  "lavfi",
  "-i",
  "color=black@0.0:s=1200x630,format=rgba",
  "-vf",
  "geq=r=0:g=0:b=0:a='230*exp(-(pow(X-600,2)/pow(430,2)+pow(Y-315,2)/pow(190,2)))'",
  "-frames:v",
  "1",
  `${OUT}/scrim.png`,
);

ff(
  "-i",
  `${OUT}/bg.mp4`,
  "-i",
  `${OUT}/scrim.png`,
  "-framerate",
  String(FPS),
  "-i",
  `${OUT}/frames/f%03d.png`,
  "-filter_complex",
  `[0][1]overlay=format=auto[s];[s][2]overlay=format=auto,fps=${FPS},split[a][b];` +
    "[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4",
  "-loop",
  "0",
  `${OUT}/hero.gif`,
);

console.log(`wrote ${OUT}/hero.gif`);
