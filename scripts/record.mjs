/**
 * Record the board through a real `change` and a real `repair`, and say when the
 * moment happened so the GIF can be cut around it.
 *
 * The sibling of `scripts/capture.mjs`, for the two animated captures in `docs/images/`.
 * Nothing is staged: each step is launched through the same POST /api/demo/launch
 * the guide's buttons use, the video is whatever the live board did, and the
 * script fails rather than saving anything when the moment never arrives or the
 * step exits non-zero. The moment is decided from the swarm, not from pixels:
 * three marks standing with all three tags confirmed for the cascade, and zero
 * marks standing for the repair.
 *
 *     node scripts/record.mjs <output-dir>
 *
 * Writes one .webm per step plus a JSON beside it carrying the video path and
 * `momentMs`, milliseconds from recording start. Cut with ffmpeg around it, e.g.
 * six seconds before to eight after:
 *
 *     ffmpeg -ss <(momentMs/1000)-6> -t 14 -i <video> \
 *       -vf "fps=12,scale=1200:-1:flags=lanczos,palettegen" palette.png
 *     ffmpeg -ss <same> -t 14 -i <video> -i palette.png \
 *       -lavfi "fps=12,scale=1200:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4" out.gif
 *
 * Run it on a settled board (after `run`, with `rerun-same` done if the take
 * wants the fuller trace). It performs the change itself, so docs/images'
 * same-run rule holds by construction: both recordings are one sequence.
 */
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const BASE = "http://localhost:3000";
const OUT = process.argv[2];
if (!OUT) throw new Error("usage: node scripts/record.mjs <output-dir>");

async function swarm() {
  const res = await fetch(`${BASE}/api/swarm`);
  if (!res.ok) throw new Error(`swarm read failed: ${res.status}`);
  return res.json();
}

async function staleCounts() {
  const body = await swarm();
  const tasks = body.snapshot.tasks;
  return {
    stale: tasks.filter((t) => t.stale !== null).length,
    tagged: tasks.filter((t) => t.staleTagged === true).length,
  };
}

async function launch(step) {
  const res = await fetch(`${BASE}/api/demo/launch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ step }),
  });
  if (!res.ok) throw new Error(`launch ${step} refused: ${res.status} ${await res.text()}`);
}

async function stepDone() {
  const res = await fetch(`${BASE}/api/demo/activity`);
  const body = await res.json();
  return body.running === null ? body.lastResult : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function record(name, step, until) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    recordVideo: { dir: OUT, size: { width: 1600, height: 900 } },
  });
  const page = await context.newPage();
  const started = Date.now();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await sleep(2500); // first polls land, board settles on its real state

  await launch(step);
  console.log(`${name}: launched ${step} at +${Date.now() - started}ms`);

  let momentMs = null;
  for (let i = 0; i < 360; i += 1) {
    await sleep(1000);
    if (momentMs === null && (await until())) {
      momentMs = Date.now() - started;
      console.log(`${name}: moment at +${momentMs}ms`);
    }
    if (momentMs !== null && Date.now() - started > momentMs + 9000) break;
  }
  if (momentMs === null) throw new Error(`${name}: the moment never arrived`);

  // The step process may still be exiting; the video only needs the moment.
  const video = page.video();
  await context.close();
  const path = await video.path();
  await browser.close();
  writeFileSync(`${OUT}/${name}.json`, JSON.stringify({ path, momentMs }, null, 2));
  console.log(`${name}: saved ${path}`);

  // Wait the step out, so the next launch is not refused with a 409 — and so a
  // step that failed after its moment still fails this script.
  for (let i = 0; i < 360; i += 1) {
    const last = await stepDone();
    if (last !== null) {
      console.log(`${name}: step exited ${last.exitCode} in ${last.durationMs}ms`);
      if (last.exitCode !== 0) throw new Error(`${name}: ${step} exited ${last.exitCode}`);
      return;
    }
    await sleep(1000);
  }
  throw new Error(`${name}: ${step} never finished`);
}

// The cascade: three marks standing and all three tags confirmed on the ribbon.
await record("cascade", "change", async () => {
  const { stale, tagged } = await staleCounts();
  return stale === 3 && tagged === 3;
});

// The repair: the board earns its way back to zero flags.
await record("repair", "repair", async () => {
  const { stale } = await staleCounts();
  return stale === 0;
});

console.log("done");
