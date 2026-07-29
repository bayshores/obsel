/**
 * Record the demo's whole take through the real guide buttons, in one shot.
 *
 * The sibling of `scripts/record.mjs`, for the submission video instead of the GIFs.
 * Nothing is staged: the two steps are launched through the same
 * POST /api/demo/launch the guide's buttons use, by clicking the buttons, and
 * every beat is decided from the swarm and the activity feed rather than from
 * pixels. The script refuses to save anything when a step exits non-zero or a
 * beat never arrives, because a take missing its moment is not a take.
 *
 *     node scripts/video.mjs <output-dir> [base-url]
 *
 * Preconditions: the board is the TAXI swarm, all forty at registered (reset,
 * then scale-register, and wait for both). The take is `scale-run
 * --change-during` followed by `scale-repair`, which is the sequence
 * docs/demo-script.md films, and it takes five to seven minutes of real time.
 *
 * What it writes into <output-dir>:
 *   take.webm        the continuous recording, 1920 x 990
 *   timeline.json    millisecond offsets of every observed beat, the segment
 *                    plan for the picture lock, and the ffmpeg command that
 *                    assembles it
 *   flagged.png      the board mid-take, marks standing, tags confirmed
 *   settled.png      the board at the end, zero flags
 *
 * The cursor is drawn as a dot by an injected overlay, because a recording of
 * clicks nobody can see reads as a slideshow.
 */
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

/*
 * `node scripts/video.mjs --replan <dir>` recomputes the segment plan and the assemble
 * command from an existing take's timeline.json, without re-recording. The
 * plan is a function of the beats, so tuning the cut must not cost a seven
 * minute retake.
 */
if (process.argv[2] === "--replan") {
  const dir = process.argv[3];
  if (!dir) throw new Error("usage: node scripts/video.mjs --replan <output-dir>");
  const old = JSON.parse(readFileSync(`${dir}/timeline.json`, "utf8"));
  writePlan(dir, old.videoPath, old.beats);
  process.exit(0);
}

const OUT = process.argv[2];
const BASE = process.argv[3] ?? "http://localhost:3000";
if (!OUT) throw new Error("usage: node scripts/video.mjs <output-dir> [base-url]");
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function swarm() {
  const res = await fetch(`${BASE}/api/swarm`);
  if (!res.ok) throw new Error(`swarm read failed: ${res.status}`);
  return res.json();
}

async function counts() {
  const body = await swarm();
  const tasks = body.snapshot.tasks;
  return {
    total: tasks.length,
    registered: tasks.filter((t) => t.status === "registered").length,
    running: tasks.filter((t) => t.status === "running").length,
    complete: tasks.filter((t) => t.status === "complete").length,
    stale: tasks.filter((t) => t.stale !== null).length,
    tagged: tasks.filter((t) => t.staleTagged === true).length,
  };
}

async function lastResult() {
  const res = await fetch(`${BASE}/api/demo/activity`);
  const body = await res.json();
  return body.running === null ? body.lastResult : null;
}

/** Wait for a condition read off the live system, up to a ceiling. */
async function until(name, ceilingMs, probe) {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - started > ceilingMs) {
      throw new Error(`${name}: never arrived within ${ceilingMs}ms`);
    }
    await sleep(1000);
  }
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1920, height: 990 },
  deviceScaleFactor: 1,
  recordVideo: { dir: OUT, size: { width: 1920, height: 990 } },
});
const page = await context.newPage();

// The visible cursor: a dot that follows the real pointer. Injected before the
// page loads so it exists for every frame.
await page.addInitScript(() => {
  window.addEventListener("DOMContentLoaded", () => {
    const dot = document.createElement("div");
    dot.id = "__cursor";
    dot.style.cssText =
      "position:fixed;z-index:99999;width:14px;height:14px;border-radius:50%;" +
      "background:rgba(232,93,146,0.85);box-shadow:0 0 10px rgba(232,93,146,0.8);" +
      "pointer-events:none;left:-40px;top:-40px;transition:left 60ms linear,top 60ms linear";
    document.body.appendChild(dot);
    window.addEventListener(
      "mousemove",
      (event) => {
        dot.style.left = `${event.clientX - 7}px`;
        dot.style.top = `${event.clientY - 7}px`;
      },
      { passive: true },
    );
  });
});

/** Move in visible steps, then click. A teleporting cursor reads as an edit. */
async function visibleClick(locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("nothing to click");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 24 });
  await sleep(350);
  await locator.click();
}

const t0 = Date.now();
const at = () => Date.now() - t0;
const beats = {};

try {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await sleep(3000); // polls land, fonts settle, the registered board is up

  const opening = await counts();
  if (opening.total !== 40 || opening.registered !== 40) {
    throw new Error(
      `the take opens on a registered taxi board; found ${JSON.stringify(opening)}. ` +
        "Reset, scale-register, and wait, then run this again.",
    );
  }

  // ── Beat 1: the swarm, with the change landing partway ────────────────────
  // The opening shot: the untouched board holds while the scenario is spoken.
  await sleep(15_000);
  const start = page.getByRole("button", { name: /Start the taxi swarm/ });
  await visibleClick(start);
  beats.swarmLaunchMs = at();
  console.log(`launched the swarm at +${beats.swarmLaunchMs}ms`);

  beats.firstRunningMs = await until("first running row", 180_000, async () =>
    (await counts()).running > 0 ? at() : null,
  );

  beats.marksMs = await until("the cascade's marks", 600_000, async () =>
    (await counts()).stale > 0 ? at() : null,
  );
  console.log(`marks landed at +${beats.marksMs}ms`);

  beats.tagsMs = await until("every mark's tag", 240_000, async () => {
    const seen = await counts();
    return seen.stale > 0 && seen.tagged === seen.stale ? at() : null;
  });

  // The ribbon read: scroll to the measured number, hold, scroll back.
  await page.evaluate(() =>
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" }),
  );
  beats.ribbonMs = at();
  await sleep(3500);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await sleep(8000); // the cascade sits on screen while its lines are spoken

  const swarmDone = await until("the swarm step's exit", 600_000, lastResult);
  if (swarmDone.exitCode !== 0) {
    throw new Error(`the swarm step exited ${swarmDone.exitCode}; not a take`);
  }
  beats.swarmExitMs = at();
  console.log(`swarm step exit 0 at +${beats.swarmExitMs}ms`);

  await page.screenshot({ path: `${OUT}/flagged.png` });

  // ── Beat 2: the zoom, and the reason three hops out ───────────────────────
  const zoomIn = page.getByRole("button", { name: /zoom in/i });
  for (let i = 0; i < 4; i += 1) {
    await visibleClick(zoomIn);
    await sleep(350);
  }
  beats.zoomMs = at();
  const deep = page.locator(".react-flow__node-task").filter({ hasText: "3 hops" }).first();
  await deep.scrollIntoViewIfNeeded();
  await visibleClick(deep);
  beats.reasonMs = at();
  await sleep(3500); // the reason is on screen; the narration reads it
  await visibleClick(page.getByRole("button", { name: /^close$/i }));
  await visibleClick(page.getByRole("button", { name: /fit view/i }));
  await sleep(3000);

  // ── Beat 3: the shrinking repair ──────────────────────────────────────────
  const flaggedNow = (await counts()).stale;
  const repair = page.getByRole("button", { name: /Redo the work obsel flagged, in parallel/ });
  await visibleClick(repair);
  beats.repairLaunchMs = at();
  console.log(`launched the repair at +${beats.repairLaunchMs}ms`);

  beats.firstClearMs = await until("the first flag off", 600_000, async () =>
    (await counts()).stale < flaggedNow ? at() : null,
  );
  console.log(`first flag off at +${beats.firstClearMs}ms`);

  beats.settledMs = await until("the settled board", 600_000, async () => {
    const seen = await counts();
    return seen.stale === 0 && seen.complete === seen.total ? at() : null;
  });

  const repairDone = await until("the repair step's exit", 300_000, lastResult);
  if (repairDone.exitCode !== 0) {
    throw new Error(`the repair step exited ${repairDone.exitCode}; not a take`);
  }
  beats.repairExitMs = at();
  await sleep(12_000); // the closing words land over the settled board
  await page.screenshot({ path: `${OUT}/settled.png` });
  beats.endMs = at();
} catch (error) {
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
  throw error;
}

const video = page.video();
await context.close();
const videoPath = await video.path();
await browser.close();

writePlan(OUT, videoPath, beats);
console.log(`take saved: ${videoPath}`);
console.log(`beats: ${JSON.stringify(beats)}`);

/**
 * The segment plan: 1x through every moment that matters, the three waits sped
 * up and labeled. Spans come from the take's own beats; speeds are small whole
 * numbers so the on-screen label is sayable, chosen so the lock lands close to
 * the script's 2:52 rather than merely under the 3:00 cap. A lock much shorter
 * than the narration is as much a failure as one over the cap.
 *
 * The three sped spans are the genuinely dull waits: the swarm before the
 * change lands, the late finishers after the cascade (the change fires around
 * the middle of the run, so a third of the swarm finishes after the marks),
 * and the repair's redos before the first flag comes off. What stays 1x, in
 * one unbroken stretch each: the marks landing with the ribbon read, the zoom
 * to the reason and the repair click, and the shrink through the close.
 */
function writePlan(dir, takePath, b) {
  const speedFor = (spanMs, wantSeconds) =>
    Math.min(8, Math.max(2, Math.round(spanMs / 1000 / wantSeconds)));

  const cascadeHoldEnd = b.ribbonMs + 12_000; // the ribbon scroll and its holds
  const swarmSpan = b.marksMs - 3000 - (b.firstRunningMs + 6000);
  const lateSpan = b.swarmExitMs - 2000 - cascadeHoldEnd;
  const repairSpan = b.firstClearMs - 2000 - (b.repairLaunchMs + 5000);

  const segments = [
    { name: "open and launch", fromMs: 0, toMs: b.firstRunningMs + 6000, speed: 1 },
    {
      name: "the swarm, sped up",
      fromMs: b.firstRunningMs + 6000,
      toMs: b.marksMs - 3000,
      speed: speedFor(swarmSpan, 40),
    },
    {
      name: "the cascade and the ribbon, unbroken",
      fromMs: b.marksMs - 3000,
      toMs: cascadeHoldEnd,
      speed: 1,
    },
    {
      name: "the late finishers, sped up",
      fromMs: cascadeHoldEnd,
      toMs: b.swarmExitMs - 2000,
      speed: speedFor(lateSpan, 18),
    },
    {
      name: "the zoom, the reason, and the repair click, unbroken",
      fromMs: b.swarmExitMs - 2000,
      toMs: b.repairLaunchMs + 5000,
      speed: 1,
    },
    {
      name: "the repair, sped up",
      fromMs: b.repairLaunchMs + 5000,
      toMs: b.firstClearMs - 2000,
      speed: speedFor(repairSpan, 12),
    },
    {
      name: "the shrink and the close, unbroken",
      fromMs: b.firstClearMs - 2000,
      toMs: b.endMs,
      speed: 1,
    },
  ];
  for (const seg of segments) {
    if (seg.toMs <= seg.fromMs) throw new Error(`empty segment: ${seg.name}`);
    if (seg.speed > 1) seg.label = `sped up x${seg.speed}`;
  }

  const lockedSeconds = segments.reduce(
    (sum, seg) => sum + (seg.toMs - seg.fromMs) / 1000 / seg.speed,
    0,
  );

  /* One filter chain per segment: trim, retime, and label the sped-up spans. */
  const font = process.env.LOCK_FONT ?? "/System/Library/Fonts/Helvetica.ttc";
  const chains = segments
    .map((seg, i) => {
      const from = (seg.fromMs / 1000).toFixed(2);
      const to = (seg.toMs / 1000).toFixed(2);
      const label =
        seg.label === undefined
          ? ""
          : `,drawtext=fontfile=${font}:text='${seg.label}':x=w-tw-24:y=24:fontsize=28:fontcolor=white@0.85:box=1:boxcolor=black@0.35:boxborderw=10`;
      return `[0:v]trim=start=${from}:end=${to},setpts=(PTS-STARTPTS)/${seg.speed}${label}[v${i}]`;
    })
    .join(";");
  const concat =
    segments.map((_, i) => `[v${i}]`).join("") + `concat=n=${segments.length}:v=1[out]`;
  const assemble =
    `ffmpeg -y -i ${takePath} -filter_complex "${chains};${concat}" ` +
    `-map "[out]" -r 30 -c:v libx264 -crf 18 -pix_fmt yuv420p ${dir}/lock.mp4`;

  writeFileSync(
    `${dir}/timeline.json`,
    JSON.stringify(
      {
        videoPath: takePath,
        beats: b,
        segments,
        lockedSeconds: Number(lockedSeconds.toFixed(1)),
        assemble,
      },
      null,
      2,
    ),
  );
  console.log(`locked duration if assembled: ${lockedSeconds.toFixed(1)}s (cap 176)`);
  console.log(`assemble with: see ${dir}/timeline.json`);
}
