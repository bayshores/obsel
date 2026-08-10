#!/usr/bin/env node
/**
 * Build the Devpost gallery cards.
 *
 *     node scripts/gallery.mjs verifier
 *     node scripts/gallery.mjs settled
 *     node scripts/gallery.mjs flagged
 *     node scripts/gallery.mjs --all           # every card whose state is reachable now
 *
 * A card is one real screenshot on obsel's own backdrop, with two or three
 * callouts on it. Each callout is a crop of the screenshot itself, magnified,
 * with a line back to the rectangle it was cut from. Nothing is redrawn: the
 * magnified panel and the region it points at are the same pixels at two
 * scales, which is why the crop is taken from the capture rather than from the
 * finished card.
 *
 * The rectangles are measured, never placed by eye. Every callout names a CSS
 * selector, the browser reports that element's box while the shot is being
 * taken, and the card converts the box into card coordinates. A callout whose
 * selector matches nothing stops the card instead of pointing at empty space.
 *
 * The first set of cards, from 2026-08-01, carried a headline and a dim
 * sub-line and nothing else. At gallery size the sentence was legible and the
 * thing it described was four pixels tall, so the card asserted something the
 * reader could not check. That is what the callouts are for.
 *
 * `verifier` serves `site/dist/` from this process and needs nothing else.
 * The board cards need `pnpm dev` (or `pnpm start`) on :3000 against a live
 * DataHub, and each one refuses to save unless `/api/swarm` says the board is
 * in the state that card claims, the same rule `scripts/capture.mjs` follows.
 *
 * Cards land in `~/Desktop/devpost-gallery/annotated/`, or in the directory
 * given as the second argument. They are submission assets rather than
 * repository files, and they are written beside the 2026-08-01 set rather than
 * over it.
 */

import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CARD = { w: 1536, h: 1024 };
const APP = process.env.OBSEL_URL ?? "http://localhost:3000";

/**
 * The cards.
 *
 * `shot` is the viewport the screenshot is taken at. `callouts[].sel` is
 * measured in that viewport; `at` is where the magnified panel sits on the
 * finished card, in card pixels, and `w` is how wide that panel is. `zoom` is
 * left to the panel width and the crop's own size, so a caller cannot ask for
 * a magnification the pixels do not support.
 */
const CARDS = {
  verifier: {
    file: "card6_verifier.png",
    source: "site",
    shot: { width: 1280, height: 760 },
    headline: "Check the erasure evidence without installing obsel",
    sub: "the repository's own verifier, bundled for the browser, on GitHub Pages",
    /** Drive the page to the state the card is about. */
    async ready(page) {
      await page.waitForFunction(() => document.querySelector("#verdict")?.textContent?.length > 0);
      await page.click("#tampers button");
      await page.waitForFunction(() =>
        document.querySelector("#verdict")?.classList.contains("refused"),
      );
      await page.evaluate(() => document.querySelector("#run").scrollIntoView({ block: "start" }));
      await page.waitForTimeout(400);
    },
    callouts: [
      {
        sel: "#change table",
        at: { x: 60, w: 620 },
        text: "one character of one signature, before and after, so the refusal and the edit name the same field",
      },
      {
        sel: "#verdict",
        at: { x: 736, w: 740 },
        text: "the refusal is computed in the tab from the signed bytes, not read out of the bundle",
      },
    ],
  },

  settled: {
    file: "card1_hero.png",
    source: "app",
    shot: { width: 1920, height: 990 },
    headline: "Forty agent tasks, each one a DataJob in DataHub",
    sub: "registered as it starts, with edges to the tables it read and wrote",
    requires: { marks: 0 },
    callouts: [
      {
        sel: ".react-flow__node",
        contains: "done",
        bleed: 14,
        at: { x: 60, w: 620 },
        text: "one box is one agent task, registered as a DataJob before it starts work",
      },
      {
        sel: "h2",
        contains: "nothing out of date",
        bleed: 12,
        at: { x: 736, w: 740 },
        text: "obsel's answer for the whole board, held against the lineage DataHub recorded",
      },
    ],
  },

  flagged: {
    file: "card2_flagged.png",
    source: "app",
    shot: { width: 1920, height: 990 },
    headline: "One column renamed. Every finished job downstream flagged.",
    sub: "walked from DataHub lineage, written back as tags",
    requires: { marksAtLeast: 1 },
    callouts: [
      {
        sel: "main h2",
        at: { x: 60, y: 716, w: 640 },
        text: "how many finished tasks the change reached, and how far out",
      },
      {
        sel: "main .obsel-ribbon, main footer",
        at: { x: 756, y: 716, w: 720 },
        text: "the measured time from the change to the marks, and the marks written into DataHub",
      },
    ],
  },
};

/* ------------------------------------------------------------------ capture */

/** Serve `site/dist/` for the length of one card. */
async function serveSite() {
  const dist = join(root, "site", "dist");
  if (!existsSync(join(dist, "index.html"))) {
    throw new Error("site/dist is not built: run `pnpm site:build` first");
  }
  const types = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
  };
  const server = createServer((req, res) => {
    const name = req.url === "/" ? "/index.html" : req.url.split("?")[0];
    const file = join(dist, name);
    if (!file.startsWith(dist) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  return { url: `http://localhost:${server.address().port}/`, close: () => server.close() };
}

/**
 * How many marks obsel is holding, read from the API rather than the page.
 *
 * Same reason as `scripts/capture.mjs`: a mark is a field, and every earlier
 * version that read the board's own words eventually saved one state under the
 * other state's name when the copy was rewritten.
 */
async function marksOnBoard() {
  const res = await fetch(`${APP}/api/swarm`);
  if (!res.ok) throw new Error(`swarm read failed: ${res.status}`);
  const body = await res.json();
  return body.snapshot.tasks.filter((task) => task.stale !== null).length;
}

/** Screenshot the card's source and measure every callout's rectangle. */
async function capture(browser, card) {
  const served = card.source === "site" ? await serveSite() : null;
  const page = await browser.newPage({ viewport: card.shot, deviceScaleFactor: 2 });
  try {
    // The board tells a browser that has no token that every button would be
    // refused, and it is right to. A fresh Chromium is such a browser, so the
    // card would photograph a warning about the capture rather than the board.
    // The token is pasted in, the way an operator pastes it; nothing serves it.
    if (card.source === "app" && process.env.OBSEL_API_TOKEN) {
      await page.addInitScript(
        (value) => window.localStorage.setItem("obsel.token.v1", value),
        process.env.OBSEL_API_TOKEN,
      );
    }
    await page.goto(served ? served.url : APP, { waitUntil: "networkidle" });
    if (card.source === "app") {
      await page.waitForSelector(".react-flow__edge", { state: "attached", timeout: 20000 });
      await page.waitForTimeout(3000);
    }
    if (card.ready) await card.ready(page);

    const rects = [];
    for (const callout of card.callouts) {
      const box = await page.evaluate(({ sel, contains, closest }) => {
        // `contains` and `closest` are here because the board carries no test
        // hooks: the ribbon's cells are unclassed divs found through the label
        // inside them, and three headings share one tag.
        const found = [...document.querySelectorAll(sel)].find(
          (node) => !contains || node.textContent?.includes(contains),
        );
        const node = closest ? found?.closest(closest) : found;
        if (!node) return null;
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
      }, callout);
      if (!box || box.width < 1 || box.height < 1) {
        throw new Error(
          `callout matched nothing on screen: ${callout.sel}` +
            (callout.contains ? ` containing "${callout.contains}"` : ""),
        );
      }
      rects.push(box);
    }
    const png = await page.screenshot();
    return { png, rects };
  } finally {
    await page.close();
    served?.close();
  }
}

/* ------------------------------------------------------------------ compose */

/**
 * The card, as one HTML page.
 *
 * The screenshot is a background image on the window and again on every
 * callout panel, offset and scaled so the panel shows exactly the measured
 * rectangle. One image, two scales, no second render of anything.
 */
function cardHtml({ card, shotDataUrl, shot, rects, fontDir }) {
  const pad = 60;
  // The screenshot is fitted inside its band rather than stretched across the
  // card: the two sources have different shapes, and a card that upscales one
  // of them shows a soft screenshot beside crisp crops taken from the same
  // pixels, which reads as two different captures.
  const band = { y: 172, h: 536 };
  const scale = Math.min((CARD.w - pad * 2) / shot.width, band.h / shot.height);
  const shotW = Math.round(shot.width * scale);
  const shotH = Math.round(shot.height * scale);
  const shotLeft = Math.round((CARD.w - shotW) / 2);
  const shotTop = Math.round(band.y + (band.h - shotH) / 2);
  // Crops hang from one baseline whatever their shape, so the captions under
  // them line up and the leader lines all rise from the same height.
  const cropBottom = 888;
  const cropMaxH = 150;
  const captionTop = cropBottom + 18;

  const panels = card.callouts.map((callout, i) => {
    const rect = rects[i];
    // The panel shows the rectangle plus a little of what surrounds it, so a
    // reader can place the crop back on the screenshot without the line.
    const bleed = callout.bleed ?? 10;
    const cropX = Math.max(0, rect.x - bleed);
    const cropY = Math.max(0, rect.y - bleed);
    const cropW = Math.min(shot.width - cropX, rect.width + bleed * 2);
    const cropH = Math.min(shot.height - cropY, rect.height + bleed * 2);
    // Capped, because a two-line heading blown up to fill the panel reads as a
    // title rather than as a crop of the shot above it.
    const zoom = Math.min(callout.at.w / cropW, cropMaxH / cropH, 4);
    const panelW = Math.round(cropW * zoom);
    const panelH = Math.round(cropH * zoom);
    const panelTop = cropBottom - panelH;

    // Where the same rectangle sits on the card, and where the line meets it.
    const onCard = {
      x: shotLeft + rect.x * scale,
      y: shotTop + rect.y * scale,
      w: rect.width * scale,
      h: rect.height * scale,
    };
    // The line leaves the crop from the top and meets the rectangle on the
    // side the crop sits on, so two callouts pointing at boxes stacked one
    // above the other do not cross each other on the way up.
    const from = { x: callout.at.x + panelW / 2, y: panelTop };
    const onLeft = from.x < onCard.x + onCard.w / 2;
    const to = {
      x: onLeft ? onCard.x : onCard.x + onCard.w,
      y: onCard.y + onCard.h / 2,
    };

    return { callout, cropX, cropY, zoom, panelW, panelH, panelTop, onCard, from, to };
  });

  const lines = panels
    .map(
      ({ from, to }) =>
        `<path d="M ${from.x} ${from.y} C ${from.x} ${from.y - (from.y - to.y) * 0.45}, ` +
        `${to.x} ${to.y + (from.y - to.y) * 0.45}, ${to.x} ${to.y}" />` +
        `<circle cx="${to.x}" cy="${to.y}" r="5" class="dot" />`,
    )
    .join("");

  // The screenshot is dimmed as a whole and each named rectangle is redrawn
  // undimmed on top of the scrim, so the region a callout is about is the one
  // lit part of the shot. Same image, same scale, punched back through.
  const boxes = panels
    .map(
      ({ onCard }) =>
        `<div class="spot" style="left:${onCard.x}px;top:${onCard.y}px;` +
        `width:${onCard.w}px;height:${onCard.h}px;` +
        `background-image:url('${shotDataUrl}');background-size:${shotW}px ${shotH}px;` +
        `background-position:-${onCard.x - shotLeft}px -${onCard.y - shotTop}px"></div>` +
        `<div class="box" style="left:${onCard.x - 3}px;top:${onCard.y - 3}px;` +
        `width:${onCard.w + 6}px;height:${onCard.h + 6}px"></div>`,
    )
    .join("");

  const cards = panels
    .map(
      ({ callout, cropX, cropY, zoom, panelW, panelH, panelTop }) => `
      <div class="crop" style="left:${callout.at.x}px;top:${panelTop}px;
        width:${panelW}px;height:${panelH}px;
        background-image:url('${shotDataUrl}');
        background-size:${shot.width * zoom}px ${shot.height * zoom}px;
        background-position:-${cropX * zoom}px -${cropY * zoom}px"></div>
      <p class="caption" style="left:${callout.at.x}px;top:${captionTop}px;width:${callout.at.w}px">
        ${callout.text}</p>`,
    )
    .join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @font-face { font-family:"Geist Mono"; src:url("${fontDir}/GeistMono-Regular.woff2") format("woff2"); font-weight:400 }
  @font-face { font-family:"Geist Mono"; src:url("${fontDir}/GeistMono-Medium.woff2") format("woff2"); font-weight:500 }
  * { box-sizing:border-box; margin:0 }
  body {
    width:${CARD.w}px; height:${CARD.h}px; position:relative; overflow:hidden;
    background:
      radial-gradient(120% 90% at 12% -10%, rgba(232,93,146,0.22), transparent 60%),
      radial-gradient(90% 80% at 100% 100%, rgba(232,93,146,0.16), transparent 55%),
      #0b0a0e;
    font-family:"Geist Mono", monospace; color:#f5eef0;
  }
  h1 { position:absolute; left:${pad}px; top:64px; width:${CARD.w - pad * 2}px;
       font-size:40px; font-weight:500; letter-spacing:-0.01em; line-height:1.12 }
  p.sub { position:absolute; left:${pad}px; top:${64 + 52}px; font-size:19px; font-weight:400;
          color:rgba(245,238,240,0.56) }
  .window { position:absolute; left:${shotLeft}px; top:${shotTop}px; width:${shotW}px; height:${shotH}px;
            border:1px solid rgba(232,93,146,0.18); border-radius:2px; overflow:hidden;
            background-image:url('${shotDataUrl}'); background-size:${shotW}px ${shotH}px }
  .veil { position:absolute; left:${shotLeft}px; top:${shotTop}px; width:${shotW}px; height:${shotH}px;
          background:linear-gradient(180deg, rgba(11,10,14,0.35) 0%, rgba(11,10,14,0.35) 100%) }
  .spot { position:absolute; background-repeat:no-repeat }
  .box { position:absolute; border:2px solid #f7a8c4; border-radius:2px;
         box-shadow:0 0 0 5px rgba(11,10,14,0.55), 0 0 22px 6px rgba(232,93,146,0.35) }
  svg { position:absolute; inset:0; width:${CARD.w}px; height:${CARD.h}px; overflow:visible }
  svg path { fill:none; stroke:#f7a8c4; stroke-width:2.5 }
  svg .dot { fill:#f7a8c4; stroke:none }
  .crop { position:absolute; border:2px solid #f7a8c4; border-radius:2px;
          background-repeat:no-repeat; background-color:#0b0a0e;
          box-shadow:0 20px 46px rgba(0,0,0,0.65) }
  .caption { position:absolute; font-size:20px; font-weight:500; line-height:1.35; color:#f5eef0 }
</style></head>
<body>
  <h1>${card.headline}</h1>
  <p class="sub">${card.sub}</p>
  <div class="window"></div>
  <div class="veil"></div>
  ${boxes}
  <svg>${lines}</svg>
  ${cards}
</body></html>`;
}

/* --------------------------------------------------------------------- main */

const [which, outArg] = process.argv.slice(2);
const names = which === "--all" ? Object.keys(CARDS) : [which];
if (!which || names.some((name) => !CARDS[name])) {
  throw new Error(`usage: node scripts/gallery.mjs ${Object.keys(CARDS).join("|")}|--all [outDir]`);
}
// Beside the 2026-08-01 set rather than over it: the older cards are what the
// Devpost page is showing until the owner swaps them.
const outDir = outArg ?? join(homedir(), "Desktop", "devpost-gallery", "annotated");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
try {
  for (const name of names) {
    const card = CARDS[name];

    if (card.requires) {
      const marks = await marksOnBoard();
      const wrong =
        (card.requires.marks !== undefined && marks !== card.requires.marks) ||
        (card.requires.marksAtLeast !== undefined && marks < card.requires.marksAtLeast);
      if (wrong) {
        if (which === "--all") {
          console.log(`${name}: skipped, obsel holds ${marks} mark(s) on the board`);
          continue;
        }
        throw new Error(`refusing to build ${name}: obsel holds ${marks} mark(s) on the board`);
      }
    }

    const { png, rects } = await capture(browser, card);
    const html = cardHtml({
      card,
      shot: card.shot,
      rects,
      shotDataUrl: `data:image/png;base64,${png.toString("base64")}`,
      fontDir: `file://${join(root, "site", "dist")}`,
    });

    const page = await browser.newPage({
      viewport: { width: CARD.w, height: CARD.h },
      deviceScaleFactor: 2,
    });
    await page.setContent(html, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    const file = join(outDir, card.file);
    await page.screenshot({ path: file });
    await page.close();
    console.log(`${name}: ${file}`);
  }
} finally {
  await browser.close();
}
