# Screenshots and recordings

What goes in this directory, and the rules that make the images worth including.

These are **not decoration**, with one declared exception at the end of this page. A judge who
will not start Docker currently sees the page only in the video, and the hackathon asks for sample
outputs in `examples/` specifically "so judges can evaluate output quality without running the
code". The images close that gap. They are the same category of artifact as the JSON already in
`examples/`: captured from a real run, not drawn.

Capturing them is the owner's action, like recording the video. Nothing here is generated.

## The images

| File                      | Page state                | What has to be legible in it                                                                                                                                                                                            |
| ------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settled.png`             | settled                   | Four done boxes, the headline reading `all 4 finished, nothing out of date`, and the write-back cell reading `·· nothing to write yet`.                                                                                 |
| `flagged.png`             | flagged                   | Three amber boxes, `- order_total` / `+ order_total_usd` on the changed table, the subline naming how many never read it, the measured detection time, and the write-back cell counting the marks written into DataHub. |
| `cascade.gif`             | flagging                  | The moment itself, animated: three boxes turning amber, the amber path moving outward from the changed table, and the ribbon's measured figures landing.                                                                |
| `repair.gif`              | repairing                 | The way back: flags coming off as one redo lands, the strip's `cleared … without a re-run` lines with their reasons, and the headline returning to nothing out of date.                                                 |
| `erasure-covered.png`     | erasure, report read      | The headline `2 of 18 assets covered, 16 unattested`, the assurance line under it, and at least one row reading `attested absent · version <V>` with the attestor named in its sentence.                                |
| `erasure-compromised.png` | erasure, keys compromised | The headline `0 of 18 assets covered, 18 unattested`, the red callout naming how many attestations were dropped and why, and both dropped rows reading `<asset>: <attestor>, key compromised`.                          |

The two GIFs exist because a still of a finished cascade shows nothing moving, which was the exact
reason the edges were animated in the first place. Fourteen seconds each, cut around the moment a
swarm read confirmed it: three marks standing with all three tags for the cascade, zero marks
standing for the repair. `scripts/record.mjs` takes them, the way `scripts/capture.mjs`
takes the stills: it launches the real step through the launch route, records the live page with
Playwright, refuses to save anything when the moment never arrives or the step exits non-zero, and
writes the cut point beside each video.

## The erasure pair, and why it is the one crop here

The two erasure files are the only images on this page that are not the whole frame, and the only
ones `scripts/capture.mjs` did not take. Both are stated here rather than left to be noticed.

They come from `scripts/erasure-broll.mts`, the recorder that films the video's last act: it opens a
real erasure request against the `showcase-ecommerce` pack, posts two real Ed25519-signed
attestations through the real routes, photographs the report, rewrites the key registry to report
both signing keys compromised, waits for the panel's own next read to show the callout, and
photographs it again. The script refuses to save a take whose panel never showed a covered row,
whose headline did not go to nothing covered, or that used any word from the table at the top of
`README.md`. Both files are from one take on 2026-08-09, seconds apart, which is the same rule as
rule 2 below.

The crop is the rectangle that recording measured for itself off the live page, the same one the
film frames, and not a rectangle chosen by eye. Rule 5 asks for the whole frame so a reader can see
that the numbers sit on the same screen as the graph, and that reasoning is what argues against it
here: the board behind this panel is the video's own taxi flow, its ribbon carries that run's
detection time, and a still holding one run's staleness figures beside another run's coverage
figures is the inconsistency rule 2 exists to prevent.

## Rules

1. **Viewport 1920 × 990 CSS px**, a full-screen browser on a 1080p display. That is the size the
   page is laid out for and the size `pnpm e2e`'s `recording-1920x990` project asserts against.
   Do not zoom, and do not resize afterwards: the graph scales to its container, so a narrower
   capture shrinks the node labels below what the layout was designed for.
2. **Both from the same run.** The numbers have to agree with each other. A settled shot from one
   run beside a flagged shot from another is two different pipelines presented as one, which is the
   kind of quiet inconsistency obsel exists to catch.
3. **Nothing staged.** Capture whatever that run produced. If the detection time is 4102 ms, the
   image says 4102 ms.
4. **Nothing sensitive in frame.** No API key, no token, no email address, no other window, and no
   part of `.env.local`. Same rule as the video.
5. **Full frame, no crop.** The whole page including the header and the ribbon, so a reader can
   see that the numbers sit on the same screen as the graph.

## What is in here now

The four staleness files were retaken on 2026-07-30 from commit `8a09994`, against a live DataHub
and a live Codex CLI. The erasure pair is later and separate, and the section above it is its whole
account. The set they replaced showed the page before the 2026-07-28 rebuild, when it was a scrolling
column rather than a graph with a panel beside it, so every wide shot in it was of a layout that no
longer exists.

The stills came from one run, in this order: `run` (117.4 s, four Codex sessions) which produced
`settled.png`, then `change` which renamed a column and flagged three tasks in a measured 402 ms,
which produced `flagged.png`. Nothing between the two shots but the change itself. obsel called the
change `schema` rather than `both`, and the content hash `539b509722e8` was identical before and
after, which is the evidence that only the column name moved.

The GIFs are a second run, and have to be. `change` only ever renames toward `order_total_usd`, so
on a board that has already been changed the re-run is identical, obsel correctly marks nothing, and
the step fails its own assertion — which is what happened on the first attempt, and what
`record.mjs` refused to save a take of. A fresh `reset` and `run` (125.5 s) put the original column
back, and the recording performed its own `change` and `repair` as one sequence: the cascade landed
its three marks in a measured 397 ms with `3 of 3` on the ribbon, and the repair redid one task,
obsel clearing the other two in 233 ms because the redone table came out identical, both `cleared`
lines with their reasons visible in the strip. The two steps exited 0 in 61.0 s and 28.3 s.

`scripts/capture.mjs` refuses to mislabel a shot, and it now decides which page it is looking at
from `/api/swarm` rather than from anything on screen. Two earlier versions read the page and both
broke. The first tested the headline for "out of date", which matches BOTH states, since the settled
headline reads "all 4 finished, nothing out of date". The second tested the ribbon for "tagged", on
the reasoning that a count is steadier than a sentence — and then `stats.tsx` dropped the word,
because `3 of 3 tagged` overflowed the column and the label above it already says "written into
DataHub".

That second break is why it reads the API now. With nothing matching "tagged", a flagged board read
as calm: `capture.mjs flagged` refused to run, and `capture.mjs settled` would have saved a flagged
board under the settled name — the exact mislabelling the check exists to prevent, reintroduced by a
copy edit that had no reason to think about it. A mark is a field rather than a phrase, so copy can
now be rewritten freely.

## Replacing them

Take the new pair with the same two commands, both run from the repository root: the script writes
`docs/images/<name>.png` relative to the working directory. Then update the date and commit in the caption in
`README.md` and in `examples/README.md`, so an image can always be tied back to a specific state of
the repository.

```bash
node scripts/capture.mjs settled   # after run, before change
```

```bash
node scripts/capture.mjs flagged   # after change
```

The erasure pair comes from the video's own recorder rather than from `capture.mjs`, and it writes
into a working directory outside the tree, so replacing it is a run and two crops. `pnpm build`
first, and nothing may be answering on the port:

```bash
npx tsx scripts/erasure-broll.mts "$W/erasure"
```

That writes `report.png` and `compromised.png` as whole 1920 × 990 frames, alongside a
`timeline.json` carrying the panel rectangle it measured. Crop both to that rectangle, keeping them
identical so the pair can be read as one panel changing:

```bash
sips -c <h> <w> --cropOffset <y> <x> "$W/erasure/report.png"      --out docs/images/erasure-covered.png
sips -c <h> <w> --cropOffset <y> <x> "$W/erasure/compromised.png" --out docs/images/erasure-compromised.png
```

## The hero, which is the one decoration

`hero.gif` opens the README in place of a title. It is a brand animation, not evidence, and it is
the only file here that is composed rather than captured plain — so what went into it is listed the
same way the captures are.

It opens on a montage: six whole windows of the app at work land one per beat, uncropped and
overlapping like a dealt deck — the graph mid-swarm, the cascade landing, the feed clearing flags,
the history record, the erasure walk, the bring-your-own-data door — each in timelapse, the later
card on top. Once the pile is built it blurs back, the mark assembles over it, names itself while
open, comes apart again, and everything fades out — which is what makes the loop seamless, since
the first and last frames are both black.

The footage is the 2026-07-30 cascade and repair takes plus three tab clips filmed live against
the same board, and it is blurred and scrimmed behind the type on purpose: nothing in the wall is
offered as legible evidence, the captures above are for that. The lockup's animation is the mark's
own — geometry from `mark-geometry.ts`, every motion value transcribed from `mark.tsx` and
`brand.tsx`. The one liberty is the loop: the header never plays its entrance (`brand.tsx` records
why), and the hero plays it on every cycle.

`scripts/hero.mjs` remakes it from the two takes, and films the three tab clips itself, so it
needs obsel and its board up. The whole picture is composed and stepped in one browser page —
cards, focus pull, lockup and fade on one clock at 20 frames a second — and ffmpeg's only job is
the palette.
