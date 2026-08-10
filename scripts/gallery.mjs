#!/usr/bin/env node
/**
 * Build the Devpost gallery cards.
 *
 *     node scripts/gallery.mjs shoot board-flagged     # capture one state
 *     node scripts/gallery.mjs card card2_flagged      # compose one card
 *     node scripts/gallery.mjs cards                   # every card whose shots are cached
 *
 * A card is a real screenshot with the part it is about singled out: a
 * magnified crop of that same screenshot, a caption at reading size, and
 * something joining the two. Nothing is redrawn. The magnified panel and the
 * region it points at are the same pixels at two scales, which is why a crop is
 * cut from the capture rather than from the finished card.
 *
 * Rectangles are measured, never placed by eye. Every anchor names a CSS
 * selector, the browser reports that element's box while the shot is being
 * taken, and the layout converts the box into card coordinates. An anchor whose
 * selector matches nothing stops the shot instead of pointing at empty space.
 *
 * The 2026-08-01 cards carried a headline, a dim sub-line and a whole
 * screenshot. At gallery size the sentence was the only legible thing on the
 * card, so a reader could not check the claim against the picture under it.
 *
 * ## Shots and cards are separate commands
 *
 * The six cards want the board in four different states, and a state costs a
 * real agent run to reach. So a shot is captured once into `.shots/` beside the
 * cards, and a card is composed from whatever is cached. A card naming a shot
 * that has never been taken says so and stops.
 *
 * ## Six cards, five layouts
 *
 * Layouts differ because the cards do. A card whose point is one number wants
 * that number large; a card whose point is a change between two states wants
 * both states beside each other; a card whose point is where something sits in
 * a big graph wants the graph and a list. Running one composition over all six
 * makes six cards that differ only in their words.
 */

import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CARD = { w: 1536, h: 1024 };
const APP = process.env.OBSEL_URL ?? "http://localhost:3000";
const DATAHUB = process.env.DATAHUB_URL ?? "http://localhost:9002";
const FLOW = `urn:li:dataFlow:(obsel,${process.env.OBSEL_FLOW_ID ?? "obsel_taxi_video"},prod)`;
const INK = "#0b0a0e";
const ROSE = "#f7a8c4";

/* --------------------------------------------------------------------- shots */

const BOARD = { width: 1920, height: 990 };

/**
 * Each shot is one page in one state, with the rectangles that state is about.
 *
 * `requires` is checked against `/api/swarm` before the browser opens, so a
 * board in the wrong state cannot be saved under a name that claims otherwise.
 * That is `scripts/capture.mjs`'s rule, and it is here for the reason recorded
 * there: every version that decided from the page's own words eventually saved
 * one state under the other's name after a copy edit.
 */
const SHOTS = {
  "board-settled": {
    source: "app",
    viewport: BOARD,
    requires: { marks: 0 },
    anchors: {
      task: { sel: ".react-flow__node", contains: "done" },
      headline: { sel: "h2", contains: "nothing out of date" },
    },
  },

  "board-flagged": {
    source: "app",
    viewport: BOARD,
    requires: { marksAtLeast: 1 },
    anchors: {
      changed: { sel: ".react-flow__node", contains: "daily trips" },
      flagged: { sel: ".react-flow__node", contains: "out of date · 3 hops" },
      headline: { sel: "h2", contains: "are out of date" },
      detection: { sel: "span", contains: "detection time", closest: "div" },
      written: { sel: "span", contains: "written into DataHub", closest: "div" },
    },
  },

  /*
   * The board after a repair, on the history tab.
   *
   * Not the activity feed: that is what obsel is doing now, and it holds this
   * session's steps rather than the record. The history is what obsel decided,
   * it survives a reload, and the line the card is about is in it.
   */
  "board-repaired": {
    source: "app",
    viewport: BOARD,
    requires: { marks: 0 },
    async ready(page) {
      await page.getByText("history", { exact: true }).first().click();
      await page.waitForFunction(() => document.body.innerText.includes("what obsel has decided"));
      await page.waitForTimeout(2500);
    },
    anchors: {
      cleared: { sel: "span", contains: "cleared:", closest: "li" },
      records: { sel: "ol", contains: "flag came off" },
      headline: { sel: "h2", contains: "nothing out of date" },
    },
  },

  "datahub-flow": {
    source: "datahub",
    viewport: BOARD,
    path: `/pipelines/${encodeURIComponent(FLOW)}/Tasks`,
    ready: "Contains 40 Tasks",
    anchors: {
      count: { sel: "div, span, p", contains: "Contains 40 Tasks" },
    },
  },

  "datahub-task": {
    source: "datahub",
    viewport: BOARD,
    path: `/tasks/${encodeURIComponent(`urn:li:dataJob:(${FLOW},report_riders)`)}/Documentation`,
    ready: "obsel-stale",
    anchors: {
      tag: { sel: "span, a", contains: "obsel-stale" },
    },
  },

  "site-refused": {
    source: "site",
    viewport: { width: 1280, height: 760 },
    async ready(page) {
      await page.waitForFunction(() => document.querySelector("#verdict")?.textContent?.length > 0);
      await page.click("#tampers button");
      await page.waitForFunction(() =>
        document.querySelector("#verdict")?.classList.contains("refused"),
      );
      await page.evaluate(() => document.querySelector("#run").scrollIntoView({ block: "start" }));
      await page.waitForTimeout(400);
    },
    anchors: {
      edit: { sel: "#change table" },
      verdict: { sel: "#verdict" },
      output: { sel: "#output" },
    },
  },

  /*
   * The erasure pair comes from `scripts/erasure-broll.mts`, which opens a real
   * request, posts two real Ed25519-signed attestations through the real
   * routes, photographs the report, rewrites the key registry to report both
   * signing keys compromised, and photographs it again. Running that here would
   * mean duplicating the signing, and the recorder already refuses a take whose
   * panel never showed a covered row or whose headline never went to nothing
   * covered.
   *
   * Point `OBSEL_ERASURE_DIR` at its output directory. The rectangle both cards
   * are cropped to is the one that recording measured off the live page, read
   * out of its `timeline.json`, so nothing here is cropped by eye either.
   */
  "erasure-covered": { source: "recorder", file: "report.png" },
  "erasure-compromised": { source: "recorder", file: "compromised.png" },
};

/* --------------------------------------------------------------------- cards */

const CARDS = {
  card1_hero: {
    layout: "spotlight",
    shot: "board-settled",
    headline: "Forty agent tasks, each one a DataJob in DataHub",
    sub: "registered as it starts, with edges to the tables it read and wrote",
    callouts: [
      {
        anchor: "task",
        bleed: 14,
        at: { x: 60, w: 620 },
        text: "one box is one agent task, registered as a DataJob before it starts work",
      },
      {
        anchor: "headline",
        bleed: 4,
        at: { x: 736, w: 740 },
        text: "obsel's answer for the whole board, held against the lineage DataHub recorded",
      },
    ],
  },

  card2_flagged: {
    layout: "legend",
    shot: "board-flagged",
    headline: "One column renamed. Every finished job downstream flagged.",
    sub: "walked from DataHub lineage, written back as tags",
    steps: [
      { anchor: "changed", text: "the table one agent rewrote, renaming a single column" },
      {
        anchor: "flagged",
        text: "a job three hops away that never read that table, flagged anyway",
      },
      { anchor: "detection", text: "the measured time from the change landing to the marks" },
      {
        anchor: "written",
        text: "the marks obsel wrote into DataHub, confirmed by reading them back",
      },
    ],
  },

  card3_datahub: {
    layout: "pair",
    shots: ["datahub-flow", "datahub-task"],
    headline: "The record is in DataHub, not on obsel's screen",
    sub: "DataHub's own interface, showing what obsel registered and what it marked",
    panels: [
      {
        label: "the flow",
        anchor: "count",
        bleed: 12,
        clipW: 190,
        text: "forty DataJobs, one per agent task, in the catalog that outlives the run",
      },
      {
        label: "one flagged task",
        anchor: "tag",
        bleed: 26,
        text: "the obsel-stale tag, applied through mcp-server-datahub and read back off the entity",
      },
    ],
  },

  card4_repair: {
    layout: "record",
    shot: "board-repaired",
    headline: "A flag comes off only through work that was actually redone",
    sub: "obsel's own decision record, kept beside the board",
    column: { anchor: "records", bleed: 6 },
    locator: { anchor: "cleared" },
    text: [
      "Every record names what changed, what went out of date and how far out, and how long the decision took.",
      "A flag can also come off without its own task re-running: a redo upstream came back identical, so what this was built on still stands. Nothing else clears one. There is no route and no tool for it, and a live test asserts that.",
    ],
  },

  card5_erasure: {
    layout: "diff",
    shots: ["erasure-covered", "erasure-compromised"],
    headline: "Nobody wrote anything, and coverage fell to nothing",
    sub: "one erasure request, before and after both signing keys were reported compromised",
    panels: [
      {
        label: "before",
        anchor: "panel",
        text: "2 of 18 assets covered, each by a signed attestation naming its attestor and the version it covers",
      },
      {
        label: "after",
        anchor: "panel",
        text: "0 of 18 covered. Coverage is derived on every read, so a compromise report alone drops both attestations",
      },
    ],
  },

  card6_verifier: {
    layout: "detail",
    shot: "site-refused",
    headline: "Check the evidence without installing obsel",
    sub: "the repository's own verifier, bundled for the browser, on GitHub Pages",
    hero: {
      anchor: "verdict",
      bleed: 14,
      text: "one character of one signature was changed, and the page refuses the record it belongs to",
    },
    locator: {
      anchor: "edit",
      text: "the edit is on screen as a field, a before and an after, so the refusal and the change name the same thing",
    },
  },
};

/* ------------------------------------------------------------------ capture */

/** Serve `site/dist/` for the length of one shot. */
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

/** How many marks obsel is holding, read from the API rather than from the page. */
async function marksOnBoard() {
  const res = await fetch(`${APP}/api/swarm`);
  if (!res.ok) throw new Error(`swarm read failed: ${res.status}`);
  const body = await res.json();
  return body.snapshot.tasks.filter((task) => task.stale !== null).length;
}

/** Measure one anchor in the page that is currently open. */
async function measure(page, name, anchor) {
  const box = await page.evaluate(({ sel, contains, closest }) => {
    // `contains` and `closest` exist because neither the board nor DataHub
    // carries test hooks: the ribbon's cells are unclassed divs found through
    // the label inside them, and several headings share one tag. The shortest
    // match wins, because a substring test also matches every ancestor.
    const found = [...document.querySelectorAll(sel)]
      .filter((node) => !contains || node.textContent?.includes(contains))
      .sort((a, b) => a.textContent.length - b.textContent.length)[0];
    const node = closest ? found?.closest(closest) : found;
    if (!node) return null;
    const { x, y, width, height } = node.getBoundingClientRect();
    return { x, y, width, height };
  }, anchor);
  if (!box || box.width < 1 || box.height < 1) {
    throw new Error(
      `anchor "${name}" matched nothing on screen: ${anchor.sel}` +
        (anchor.contains ? ` containing "${anchor.contains}"` : ""),
    );
  }
  return box;
}

/** A PNG's own size in CSS pixels, read by the browser that is already running. */
async function pngSize(browser, png) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(
      async (dataUrl) => {
        const image = new Image();
        image.src = dataUrl;
        await image.decode();
        // Every shot here is taken at deviceScaleFactor 2, and a file dropped in
        // from a 2x capture is the same, so its CSS size is half its pixels.
        return { width: image.naturalWidth / 2, height: image.naturalHeight / 2 };
      },
      `data:image/png;base64,${png.toString("base64")}`,
    );
  } finally {
    await page.close();
  }
}

/** Capture one shot and cache it beside the cards. */
async function shoot(browser, name, shotsDir) {
  const shot = SHOTS[name];
  if (!shot) throw new Error(`no such shot: ${name}`);

  if (shot.source === "recorder") {
    const dir = process.env.OBSEL_ERASURE_DIR;
    if (!dir) {
      throw new Error(
        "OBSEL_ERASURE_DIR is not set: run `npx tsx scripts/erasure-broll.mts <dir>` and point " +
          "it at that directory",
      );
    }
    const source = join(dir, shot.file);
    const timeline = join(dir, "timeline.json");
    if (!existsSync(source) || !existsSync(timeline)) {
      throw new Error(`${dir} does not hold ${shot.file} and timeline.json`);
    }
    const { boxes, request, summary } = JSON.parse(readFileSync(timeline, "utf8"));
    const box = boxes?.erasurePanel;
    if (!box) throw new Error(`${timeline} carries no measured erasure panel`);
    const png = readFileSync(source);
    writeFileSync(join(shotsDir, `${name}.png`), png);
    writeFileSync(
      join(shotsDir, `${name}.json`),
      JSON.stringify(
        {
          viewport: { width: 1920, height: 990 },
          anchors: { panel: { x: box.x, y: box.y, width: box.w, height: box.h } },
          from: source,
          request,
          summary,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (shot.source === "file") {
    const source = join(root, shot.file);
    if (!existsSync(source)) throw new Error(`${shot.file} is not in the tree`);
    const png = readFileSync(source);
    writeFileSync(join(shotsDir, `${name}.png`), png);
    writeFileSync(
      join(shotsDir, `${name}.json`),
      JSON.stringify(
        { viewport: await pngSize(browser, png), anchors: {}, from: shot.file },
        null,
        2,
      ),
    );
    return;
  }

  if (shot.requires) {
    const marks = await marksOnBoard();
    const wrong =
      (shot.requires.marks !== undefined && marks !== shot.requires.marks) ||
      (shot.requires.marksAtLeast !== undefined && marks < shot.requires.marksAtLeast);
    if (wrong) {
      throw new Error(`refusing to save ${name}: obsel holds ${marks} mark(s) on the board`);
    }
  }

  const served = shot.source === "site" ? await serveSite() : null;
  const context = await browser.newContext({ viewport: shot.viewport, deviceScaleFactor: 2 });
  try {
    if (shot.source === "app" && process.env.OBSEL_API_TOKEN) {
      // The board tells a browser with no token that every button would be
      // refused, and it is right to. A fresh Chromium is such a browser, so the
      // card would photograph a warning about the capture rather than the
      // board. The token is pasted in the way an operator pastes it.
      await context.addInitScript(
        (value) => window.localStorage.setItem("obsel.token.v1", value),
        process.env.OBSEL_API_TOKEN,
      );
    }
    if (shot.source === "datahub") {
      // The onboarding modal, suppressed the way a returning user's browser
      // does it, and the sign-in through the frontend's own endpoint rather
      // than through the form. Both as `scripts/datahub-broll.mjs` records.
      await context.addInitScript(() => window.localStorage.setItem("skipWelcomeModal", "true"));
      const signIn = await context.request.post(`${DATAHUB}/logIn`, {
        data: { username: "datahub", password: "datahub" },
      });
      if (!signIn.ok()) throw new Error(`DataHub sign-in answered ${signIn.status()}`);
    }

    const page = await context.newPage();
    const url =
      shot.source === "site" ? served.url : shot.source === "datahub" ? DATAHUB + shot.path : APP;
    await page.goto(url, { waitUntil: "domcontentloaded" });

    if (shot.source === "app") {
      await page.waitForSelector(".react-flow__edge", { state: "attached", timeout: 30000 });
      await page.waitForTimeout(4000);
    }
    if (shot.source === "datahub") {
      try {
        await page.waitForFunction((text) => document.body.innerText.includes(text), shot.ready, {
          timeout: 60000,
          polling: 500,
        });
      } catch {
        throw new Error(`refusing ${name}: the page never showed "${shot.ready}"`);
      }
      await page.waitForTimeout(3000);
      const text = await page.evaluate(() => document.body.innerText);
      if (text.includes("Welcome to DataHub")) {
        throw new Error(`refusing ${name}: the onboarding modal is up`);
      }
    }
    if (typeof shot.ready === "function") await shot.ready(page);

    const anchors = {};
    for (const [key, anchor] of Object.entries(shot.anchors)) {
      anchors[key] = await measure(page, key, anchor);
    }
    const png = await page.screenshot();
    writeFileSync(join(shotsDir, `${name}.png`), png);
    writeFileSync(
      join(shotsDir, `${name}.json`),
      JSON.stringify({ viewport: shot.viewport, anchors, at: new Date().toISOString() }, null, 2),
    );
  } finally {
    await context.close();
    served?.close();
  }
}

/* ------------------------------------------------------------------ drawing */

/** One cached shot, ready to place on a card. */
function loadShot(name, shotsDir) {
  const png = join(shotsDir, `${name}.png`);
  const meta = join(shotsDir, `${name}.json`);
  if (!existsSync(png) || !existsSync(meta)) {
    throw new Error(`shot "${name}" has not been taken: run \`gallery.mjs shoot ${name}\` first`);
  }
  const { viewport, anchors } = JSON.parse(readFileSync(meta, "utf8"));
  return {
    url: `data:image/png;base64,${readFileSync(png).toString("base64")}`,
    viewport,
    rect(key) {
      const box = anchors[key];
      if (!box) throw new Error(`shot "${name}" carries no anchor "${key}"`);
      return box;
    },
  };
}

/** A crop of a shot, magnified to fill a box as far as the pixels allow. */
function crop(shot, rect, { x, y, w, h, bleed = 10, className = "crop", maxZoom = 4, clipW }) {
  // `clipW` keeps the left part of a measured rectangle. A full-width row whose
  // words sit in its first inch magnifies to nothing if the whole row has to
  // fit, and cutting it here still cuts a measured box rather than a guess.
  if (clipW) rect = { ...rect, width: Math.min(rect.width, clipW) };
  const cropX = Math.max(0, rect.x - bleed);
  const cropY = Math.max(0, rect.y - bleed);
  const cropW = Math.min(shot.viewport.width - cropX, rect.width + bleed * 2);
  const cropH = Math.min(shot.viewport.height - cropY, rect.height + bleed * 2);
  const zoom = Math.min(w / cropW, h ? h / cropH : Infinity, maxZoom);
  const box = { x, y, w: Math.round(cropW * zoom), h: Math.round(cropH * zoom) };
  const html =
    `<div class="${className}" style="left:${box.x}px;top:${box.y}px;` +
    `width:${box.w}px;height:${box.h}px;background-image:url('${shot.url}');` +
    `background-size:${shot.viewport.width * zoom}px ${shot.viewport.height * zoom}px;` +
    `background-position:-${cropX * zoom}px -${cropY * zoom}px"></div>`;
  return { html, box };
}

/** A whole shot inside a box, fitted rather than stretched. */
function place(shot, { x, y, w, h, className = "window" }) {
  const scale = Math.min(w / shot.viewport.width, h / shot.viewport.height);
  const box = {
    w: Math.round(shot.viewport.width * scale),
    h: Math.round(shot.viewport.height * scale),
  };
  box.x = Math.round(x + (w - box.w) / 2);
  box.y = Math.round(y + (h - box.h) / 2);
  const html =
    `<div class="${className}" style="left:${box.x}px;top:${box.y}px;` +
    `width:${box.w}px;height:${box.h}px;background-image:url('${shot.url}');` +
    `background-size:${box.w}px ${box.h}px"></div>`;
  return {
    html,
    box,
    scale,
    onCard: (r) => ({
      x: box.x + r.x * scale,
      y: box.y + r.y * scale,
      w: r.width * scale,
      h: r.height * scale,
    }),
  };
}

/** The rectangle redrawn undimmed, so the named region is the lit part. */
function spot(shot, placed, rect) {
  const on = placed.onCard(rect);
  return (
    `<div class="spot" style="left:${on.x}px;top:${on.y}px;width:${on.w}px;height:${on.h}px;` +
    `background-image:url('${shot.url}');background-size:${placed.box.w}px ${placed.box.h}px;` +
    `background-position:-${on.x - placed.box.x}px -${on.y - placed.box.y}px"></div>` +
    `<div class="box" style="left:${on.x - 3}px;top:${on.y - 3}px;` +
    `width:${on.w + 6}px;height:${on.h + 6}px"></div>`
  );
}

/** A curve from a panel to a rectangle, meeting it on the side the panel is on. */
function leader(from, to) {
  const bend = Math.abs(from.y - to.y) * 0.45;
  const dir = from.y > to.y ? -1 : 1;
  return (
    `<path d="M ${from.x} ${from.y} C ${from.x} ${from.y + bend * dir}, ` +
    `${to.x} ${to.y - bend * dir}, ${to.x} ${to.y}" />` +
    `<circle cx="${to.x}" cy="${to.y}" r="5" class="dot" />`
  );
}

const esc = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/**
 * The headline and its sub-line, as one block.
 *
 * The two used to be placed independently, which put the sub-line through the
 * middle of any headline that wrapped to a second line.
 */
function head(card, top) {
  return `
    <div class="head" style="left:60px;top:${top}px;width:${CARD.w - 120}px">
      <h1>${esc(card.headline)}</h1>
      <p class="sub">${esc(card.sub)}</p>
    </div>`;
}

/* ----------------------------------------------------------------- layouts */

/**
 * A whole screenshot with two crops hanging under it on one baseline.
 *
 * For a card whose point is two small things on one screen: the crops carry the
 * words, the shot says where they were.
 */
function spotlight(card, shots) {
  const shot = shots[card.shot];
  const placed = place(shot, { x: 60, y: 172, w: CARD.w - 120, h: 536 });
  const bottom = 888;
  const parts = card.callouts.map((callout) => {
    const rect = shot.rect(callout.anchor);
    const sized = crop(shot, rect, {
      x: callout.at.x,
      y: 0,
      w: callout.at.w,
      h: 150,
      bleed: callout.bleed,
    });
    const top = bottom - sized.box.h;
    const on = placed.onCard(rect);
    const from = { x: callout.at.x + sized.box.w / 2, y: top };
    const onLeft = from.x < on.x + on.w / 2;
    return {
      html: sized.html.replace("top:0px", `top:${top}px`),
      line: leader(from, { x: onLeft ? on.x : on.x + on.w, y: on.y + on.h / 2 }),
      spot: spot(shot, placed, rect),
      caption:
        `<p class="caption" style="left:${callout.at.x}px;top:${bottom + 18}px;` +
        `width:${callout.at.w}px">${esc(callout.text)}</p>`,
    };
  });

  return `
    ${head(card, 64)}
    ${placed.html}
    <div class="veil" style="left:${placed.box.x}px;top:${placed.box.y}px;width:${placed.box.w}px;height:${placed.box.h}px"></div>
    ${parts.map((p) => p.spot).join("")}
    <svg>${parts.map((p) => p.line).join("")}</svg>
    ${parts.map((p) => p.html + p.caption).join("")}`;
}

/**
 * The whole screen with numbered markers on it, and the numbers explained in a
 * row underneath.
 *
 * For a card whose point is how far something reached. The picture has to stay
 * whole for the spread to be visible at all, so nothing is magnified here and
 * the words sit under it instead.
 */
function legend(card, shots) {
  const shot = shots[card.shot];
  const placed = place(shot, { x: 178, y: 176, w: 1180, h: 620 });
  const rects = card.steps.map((step) => placed.onCard(shot.rect(step.anchor)));

  /*
   * Where each marker goes, decided rather than fixed.
   *
   * A marker pinned to one corner of its own rectangle is fine until two
   * rectangles sit side by side, and then it lands on its neighbour's box, or
   * off the edge of the screenshot, and points at the wrong thing. So each one
   * tries the eight places around its rectangle and takes the first that stays
   * inside the shot, clear of every other named rectangle, and clear of the
   * markers already placed.
   */
  const R = 19;
  const GAP = 9;
  const hits = (a, b, pad = 4) =>
    a.x < b.x + b.w + pad &&
    a.x + a.w + pad > b.x &&
    a.y < b.y + b.h + pad &&
    a.y + a.h + pad > b.y;
  const inside = (a) =>
    a.x >= placed.box.x + 2 &&
    a.y >= placed.box.y + 2 &&
    a.x + a.w <= placed.box.x + placed.box.w - 2 &&
    a.y + a.h <= placed.box.y + placed.box.h - 2;

  const pins = [];
  rects.forEach((rect, i) => {
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    /*
     * Away from the nearest other rectangle, not from all of them averaged.
     * Averaging put the marker for the left of two adjacent cells on its right
     * side, because the mean of everything else sat far to the left across the
     * graph, and the pair then read swapped.
     */
    const near = rects
      .filter((_, j) => j !== i)
      .map((o) => ({ x: o.x + o.w / 2, y: o.y + o.h / 2 }))
      .sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy))[0] ?? {
      x: cx,
      y: cy,
    };
    const away = (at) => Math.hypot(at.x + R - near.x, at.y + R - near.y);
    const candidates = [
      { x: rect.x + rect.w + GAP, y: rect.y - R * 2 - GAP },
      { x: rect.x - R * 2 - GAP, y: rect.y - R * 2 - GAP },
      { x: rect.x + rect.w + GAP, y: rect.y + rect.h + GAP },
      { x: rect.x - R * 2 - GAP, y: rect.y + rect.h + GAP },
      { x: cx - R, y: rect.y - R * 2 - GAP },
      { x: cx - R, y: rect.y + rect.h + GAP },
      { x: rect.x + rect.w + GAP, y: cy - R },
      { x: rect.x - R * 2 - GAP, y: cy - R },
    ]
      .map((at) => ({ ...at, w: R * 2, h: R * 2 }))
      /*
       * Outward first. Two cells side by side both have a free corner facing
       * their neighbour, and taking it puts each marker nearer the other one's
       * box than its own, so the numbers read swapped.
       */
      .sort((a, b) => away(b) - away(a));
    const free = candidates.find(
      (at) =>
        inside(at) &&
        rects.every((other, j) => j === i || !hits(at, other)) &&
        pins.every((other) => !hits(at, other)),
    );
    pins.push(free ?? candidates[0]);
  });

  const lit = rects.map((rect, i) => spot(shot, placed, shot.rect(card.steps[i].anchor))).join("");
  const markers = pins
    .map((at, i) => `<div class="pin" style="left:${at.x}px;top:${at.y}px">${i + 1}</div>`)
    .join("");

  const gap = 24;
  const w = (CARD.w - 120 - gap * (card.steps.length - 1)) / card.steps.length;
  const items = card.steps
    .map(
      (step, i) => `
      <div class="item" style="left:${60 + i * (w + gap)}px;top:836px;width:${w}px">
        <span class="num">${i + 1}</span>
        <p>${esc(step.text)}</p>
      </div>`,
    )
    .join("");

  return `
    ${head(card, 56)}
    ${placed.html}
    <div class="veil" style="left:${placed.box.x}px;top:${placed.box.y}px;width:${placed.box.w}px;height:${placed.box.h}px"></div>
    ${lit}
    ${markers}
    ${items}`;
}

/**
 * Two whole screens side by side, each with one region lit and repeated as an
 * inset over its own panel.
 *
 * For a card whose point is that a record exists somewhere else. The page has
 * to be recognizably that other product, so it is shown whole; the inset is
 * there because the line that matters on it is four pixels tall at this size.
 */
function pair(card, shots) {
  const gap = 36;
  const w = (CARD.w - 120 - gap) / 2;
  const insetBottom = 872;
  const captionTop = 912;
  const panels = card.shots
    .map((name, i) => {
      const shot = shots[name];
      const x = 60 + i * (w + gap);
      const placed = place(shot, { x, y: 236, w, h: 452, className: "window plain" });
      const panel = card.panels[i];
      const rect = shot.rect(panel.anchor);
      const inset = crop(shot, rect, {
        x: placed.box.x + 18,
        y: 0,
        w: Math.min(430, placed.box.w - 36),
        h: 150,
        bleed: panel.bleed ?? 10,
        clipW: panel.clipW,
        className: "crop inset",
      });
      const insetTop = insetBottom - inset.box.h;
      const on = placed.onCard(rect);
      return `
        <p class="label" style="left:${x}px;top:200px;width:${w}px">${esc(panel.label)}</p>
        ${placed.html}
        <div class="veil" style="left:${placed.box.x}px;top:${placed.box.y}px;width:${placed.box.w}px;height:${placed.box.h}px"></div>
        ${spot(shot, placed, rect)}
        <svg>${leader(
          { x: inset.box.x + inset.box.w / 2, y: insetTop },
          { x: on.x + on.w / 2, y: on.y + on.h },
        )}</svg>
        ${inset.html.replace("top:0px", `top:${insetTop}px`)}
        <p class="caption" style="left:${x}px;top:${captionTop}px;width:${w}px">${esc(panel.text)}</p>`;
    })
    .join("");
  return `${head(card, 76)}${panels}`;
}

/**
 * Two pictures of one surface at two moments, side by side, and nothing else.
 *
 * For a card whose point is a difference. The panels are the whole card, so a
 * reader compares them rather than hunting for what moved.
 */
function diff(card, shots) {
  const gap = 44;
  const w = (CARD.w - 120 - gap) / 2;
  const views = card.shots.map((name, i) => {
    const shot = shots[name];
    const panel = card.panels[i];
    const x = 60 + i * (w + gap);
    const view = panel.anchor
      ? crop(shot, shot.rect(panel.anchor), {
          x,
          y: 250,
          w,
          h: 560,
          bleed: 0,
          className: "crop plain",
          maxZoom: 1.6,
        })
      : place(shot, { x, y: 250, w, h: 560, className: "window plain" });
    return { x, panel, view };
  });

  const panels = views
    .map(
      ({ x, panel, view }) => `
        <p class="label" style="left:${x}px;top:214px;width:${w}px">${esc(panel.label)}</p>
        ${view.html}
        <p class="caption" style="left:${x}px;top:846px;width:${w}px">${esc(panel.text)}</p>`,
    )
    .join("");

  /*
   * The arrow is placed from the two panels rather than from the card. The
   * panels are cropped to whatever rectangle each recording measured, so their
   * heights are not known until they are built, and an arrow at a fixed height
   * sat off-center against them.
   */
  const [left, right] = views.map(({ view }) => view.box);
  const cx = (left.x + left.w + right.x) / 2;
  const cy = (left.y + left.h / 2 + (right.y + right.h / 2)) / 2;
  return `
    ${head(card, 72)}
    ${panels}
    <svg>
      <path d="M ${cx - 17} ${cy} L ${cx + 17} ${cy}" />
      <path d="M ${cx + 6} ${cy - 9} L ${cx + 17} ${cy} L ${cx + 6} ${cy + 9}" />
    </svg>`;
}

/**
 * One crop as the picture, with the page it came from small beside it.
 *
 * For a card whose point is a single line of output. The line is the card, and
 * the whole page is there only to say where the line was.
 */
function detail(card, shots) {
  const shot = shots[card.shot];
  const hero = crop(shot, shot.rect(card.hero.anchor), {
    x: 60,
    y: 236,
    w: CARD.w - 120,
    h: 230,
    bleed: card.hero.bleed,
    className: "crop hero",
    maxZoom: 2.6,
  });
  const locator = place(shot, { x: 60, y: 552, w: 640, h: 400, className: "window plain" });
  const on = locator.onCard(shot.rect(card.locator.anchor));
  const textX = locator.box.x + locator.box.w + 56;
  return `
    ${head(card, 72)}
    ${hero.html}
    <p class="caption" style="left:60px;top:${236 + hero.box.h + 22}px;width:${CARD.w - 120}px">${esc(card.hero.text)}</p>
    ${locator.html}
    <div class="veil" style="left:${locator.box.x}px;top:${locator.box.y}px;width:${locator.box.w}px;height:${locator.box.h}px"></div>
    ${spot(shot, locator, shot.rect(card.locator.anchor))}
    <p class="caption" style="left:${textX}px;top:${locator.box.y + 40}px;width:${CARD.w - textX - 60}px">${esc(card.locator.text)}</p>
    <svg>${leader({ x: textX - 24, y: on.y + on.h / 2 }, { x: on.x + on.w, y: on.y + on.h / 2 })}</svg>`;
}

/**
 * The record itself, read as a column, with the screen it belongs to small
 * beside it.
 *
 * For a card whose point is a list rather than a line. A crop wide enough to
 * read several records is taller than it is wide, so it takes the left half of
 * the card and the prose goes to the right.
 */
function record(card, shots) {
  const shot = shots[card.shot];
  const column = crop(shot, shot.rect(card.column.anchor), {
    x: 60,
    y: 228,
    w: 620,
    h: 736,
    bleed: card.column.bleed,
    maxZoom: 2.2,
  });
  const locator = place(shot, { x: 740, y: 228, w: 736, h: 400, className: "window plain" });
  const rect = shot.rect(card.locator.anchor);
  const on = locator.onCard(rect);
  const paragraphs = card.text
    .map(
      (line, i) =>
        `<p class="caption" style="left:740px;top:${688 + i * 96}px;width:736px">${esc(line)}</p>`,
    )
    .join("");
  return `
    ${head(card, 64)}
    ${column.html}
    ${locator.html}
    <div class="veil" style="left:${locator.box.x}px;top:${locator.box.y}px;width:${locator.box.w}px;height:${locator.box.h}px"></div>
    ${spot(shot, locator, rect)}
    <svg>${leader({ x: column.box.x + column.box.w + 14, y: on.y + on.h / 2 }, { x: on.x, y: on.y + on.h / 2 })}</svg>
    ${paragraphs}`;
}

const LAYOUTS = { spotlight, legend, pair, diff, detail, record };

function page(body, fontDir) {
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
      ${INK};
    font-family:"Geist Mono", monospace; color:#f5eef0;
  }
  .head { position:absolute }
  h1 { font-size:40px; font-weight:500; letter-spacing:-0.01em; line-height:1.12 }
  p.sub { font-size:19px; font-weight:400; line-height:1.35; margin-top:14px;
          color:rgba(245,238,240,0.56) }
  .window { position:absolute; border:1px solid rgba(232,93,146,0.18); border-radius:2px;
            background-repeat:no-repeat }
  .window.plain { box-shadow:0 20px 46px rgba(0,0,0,0.55) }
  .veil { position:absolute; background:rgba(11,10,14,0.4) }
  .spot { position:absolute; background-repeat:no-repeat }
  .box { position:absolute; border:2px solid ${ROSE}; border-radius:2px;
         box-shadow:0 0 0 5px rgba(11,10,14,0.55), 0 0 22px 6px rgba(232,93,146,0.35) }
  svg { position:absolute; inset:0; width:${CARD.w}px; height:${CARD.h}px; overflow:visible }
  svg path { fill:none; stroke:${ROSE}; stroke-width:2.5 }
  svg .dot { fill:${ROSE}; stroke:none }
  .crop { position:absolute; border:2px solid ${ROSE}; border-radius:2px;
          background-repeat:no-repeat; background-color:${INK};
          box-shadow:0 20px 46px rgba(0,0,0,0.65) }
  .crop.hero { border-width:3px }
  .crop.inset { background-color:#ffffff }
  .crop.plain { box-shadow:0 20px 46px rgba(0,0,0,0.55) }
  .caption { position:absolute; font-size:20px; font-weight:500; line-height:1.35 }
  .label { position:absolute; font-size:17px; font-weight:400; letter-spacing:0.05em; color:${ROSE} }
  .pin { position:absolute; width:38px; height:38px; border-radius:19px; background:${ROSE};
         color:${INK}; font-size:21px; font-weight:500; line-height:38px; text-align:center;
         box-shadow:0 0 0 5px rgba(11,10,14,0.7) }
  .item { position:absolute }
  .item p { font-size:19px; line-height:1.35; margin-top:14px }
  .item .num { display:inline-block; width:34px; height:34px; border-radius:17px; background:${ROSE};
               color:${INK}; font-size:19px; font-weight:500; text-align:center; line-height:34px }
</style></head><body>${body}</body></html>`;
}

/* --------------------------------------------------------------------- main */

const [verb, name, outArg] = process.argv.slice(2);
if (!["shoot", "card", "cards"].includes(verb ?? "")) {
  throw new Error(
    `usage: node scripts/gallery.mjs shoot <${Object.keys(SHOTS).join("|")}>\n` +
      `       node scripts/gallery.mjs card <${Object.keys(CARDS).join("|")}>\n` +
      `       node scripts/gallery.mjs cards`,
  );
}
// Beside the 2026-08-01 set rather than over it: the older cards are what the
// Devpost page is showing until the owner swaps them.
const outDir =
  (verb === "cards" ? name : outArg) ?? join(homedir(), "Desktop", "devpost-gallery", "annotated");
const shotsDir = join(outDir, ".shots");
mkdirSync(shotsDir, { recursive: true });

const browser = await chromium.launch();
try {
  if (verb === "shoot") {
    await shoot(browser, name, shotsDir);
    console.log(`${name}: cached in ${shotsDir}`);
  } else {
    for (const cardName of verb === "cards" ? Object.keys(CARDS) : [name]) {
      const card = CARDS[cardName];
      if (!card) throw new Error(`no such card: ${cardName}`);
      const shots = {};
      try {
        for (const shotName of card.shots ?? [card.shot]) {
          shots[shotName] = loadShot(shotName, shotsDir);
        }
      } catch (error) {
        if (verb !== "cards") throw error;
        console.log(`${cardName}: skipped, ${error.message}`);
        continue;
      }
      const html = page(LAYOUTS[card.layout](card, shots), `file://${join(root, "site", "dist")}`);
      const tab = await browser.newPage({
        viewport: { width: CARD.w, height: CARD.h },
        deviceScaleFactor: 2,
      });
      await tab.setContent(html, { waitUntil: "networkidle" });
      await tab.evaluate(() => document.fonts.ready);
      const file = join(outDir, `${cardName}.png`);
      await tab.screenshot({ path: file });
      await tab.close();
      console.log(`${cardName}: ${file} (${card.layout})`);
    }
  }
} finally {
  await browser.close();
}
