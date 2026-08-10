/**
 * A high-quality replacement for Playwright's `recordVideo`, over the same
 * CDP screencast the built-in recorder uses.
 *
 * Why it exists: the built-in path compresses twice, and both stages are the
 * cheapest available. Chromium hands it JPEG frames at quality 90, and
 * playwright-core pipes them into VP8 at `-crf 8 -speed 8 -b:v 1M` on one
 * thread — a hard megabit for footage the film magnifies. The owner's report
 * on the v8/v9 cuts ("the footage of the app itself just looks poor, the
 * bitrate doesn't look high quality") is that megabit, twice-lossy, on
 * screen. This module asks Chromium for JPEG at quality 100, keeps every
 * frame as bytes with its own wall-clock timestamp, and assembles them into
 * H.264 at CRF 8 after the take — no realtime encoder in the loop at all.
 *
 * What it deliberately keeps from the built-in recorder: the screencast
 * source itself. Frames arrive when the compositor produces them and carry
 * `metadata.timestamp` (seconds since epoch), so assembly lays each frame
 * out at its true time and the result is constant-frame-rate 50 fps with
 * correct holds — the same temporal behavior the film's plans were measured
 * against, at a quality the encoder no longer destroys.
 *
 * Resolution is whatever Chromium serves for the context's viewport and
 * deviceScaleFactor; the probe in `--probe` mode reports it, because whether
 * screencast frames arrive at device pixels or CSS pixels is a Chromium
 * behavior to be measured, not assumed (scripts/video.mjs:93 records the
 * built-in recorder measuring CSS).
 *
 * Usage from a recording script:
 *
 *   const rec = await startHqRecording(page, { framesDir });
 *   ... drive the take; stamp beats with Date.now() ...
 *   const { firstFrameWallMs, frames } = await rec.stop();
 *   await assemble(framesDir, outMp4);           // CRF 8 H.264, CFR 50
 *   // beatMs relative to the video = wallMs - firstFrameWallMs
 *
 * The wall-clock mapping is the load-bearing part: `metadata.timestamp` is
 * CDP's TimeSinceEpoch, directly comparable to Date.now()/1000, so a script
 * that stamps beats with Date.now() converts them to video offsets by
 * subtracting `firstFrameWallMs`. No probing of the container afterward.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Start capturing. Returns a handle whose `stop()` resolves to the frame log. */
export async function startHqRecording(page, { framesDir, maxWidth = 3840, maxHeight = 2160 }) {
  mkdirSync(framesDir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  /** @type {{ file: string, wallMs: number }[]} */
  const frames = [];
  let counter = 0;
  let stopped = false;

  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    // Ack first: Chromium withholds the next frame until the last is acked,
    // and disk time inside the handler would throttle the capture itself.
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    if (stopped) return;
    const file = path.join(framesDir, `f${String(counter).padStart(6, "0")}.jpg`);
    counter += 1;
    writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, wallMs: metadata.timestamp * 1000 });
  });

  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 100,
    maxWidth,
    maxHeight,
    everyNthFrame: 1,
  });

  return {
    frames,
    async stop() {
      stopped = true;
      await cdp.send("Page.stopScreencast").catch(() => {});
      await cdp.detach().catch(() => {});
      if (frames.length === 0) throw new Error("the screencast produced no frames");
      return { firstFrameWallMs: frames[0].wallMs, frames };
    },
  };
}

/**
 * Assemble captured frames into CFR 50 fps H.264 at CRF 8.
 *
 * The concat demuxer lays each frame out for exactly the wall-clock gap to
 * its successor, and the `fps` filter then samples that timeline at 50 —
 * so a 3-second hold is 150 identical output frames, not a guess, and a
 * 30 fps burst is resampled without drift. CRF 8 at `veryfast` is well past
 * visually lossless for UI footage; the film's own render re-encodes this,
 * so the source's job is to not add noise of its own.
 */
export function assemble(frames, outPath, { fps = 50 } = {}) {
  const lines = [];
  for (let i = 0; i < frames.length; i += 1) {
    const next = frames[i + 1];
    const duration = next ? (next.wallMs - frames[i].wallMs) / 1000 : 1 / fps;
    lines.push(`file '${frames[i].file}'`);
    lines.push(`duration ${Math.max(duration, 0.001).toFixed(6)}`);
  }
  // The concat demuxer ignores the last entry's duration unless the file is
  // named again; naming it again gives the final frame a real dwell.
  lines.push(`file '${frames[frames.length - 1].file}'`);
  const listPath = `${outPath}.frames.txt`;
  writeFileSync(listPath, lines.join("\n"));
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-vf",
    `fps=${fps},format=yuv420p`,
    "-c:v",
    "libx264",
    "-crf",
    "8",
    "-preset",
    "veryfast",
    "-r",
    String(fps),
    outPath,
  ]);
}

/*
 * Probe mode: record a few seconds of a live page and report what Chromium
 * actually served — frame size, rate, and the assembled bitrate — so the
 * resolution question is answered by measurement before any take is retaken.
 *
 *   node scripts/hq-recorder.mjs --probe <url> <outDir> [deviceScaleFactor]
 */
if (process.argv[2] === "--probe") {
  const [, , , url, outDir, dsfArg] = process.argv;
  if (!url || !outDir) throw new Error("usage: --probe <url> <outDir> [dsf]");
  const dsf = Number(dsfArg ?? 2);
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1920, height: 990 },
    deviceScaleFactor: dsf,
  });
  await page.goto(url, { waitUntil: "networkidle" });
  const rec = await startHqRecording(page, { framesDir: `${outDir}/frames` });
  await new Promise((r) => setTimeout(r, 6000));
  const { frames } = await rec.stop();
  await browser.close();
  assemble(frames, `${outDir}/probe.mp4`);
  const spanS = (frames[frames.length - 1].wallMs - frames[0].wallMs) / 1000;
  const dims = execFileSync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,bit_rate",
    "-of",
    "csv=p=0",
    `${outDir}/probe.mp4`,
  ])
    .toString()
    .trim();
  console.log(
    `dsf ${dsf}: ${frames.length} frames over ${spanS.toFixed(1)}s ` +
      `(${(frames.length / spanS).toFixed(1)} fps captured), assembled ${dims}`,
  );
}
