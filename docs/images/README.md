# Screenshots and recordings

What goes in this directory, and the rules that make the images worth including.

These are **not decoration**. A judge who will not start Docker currently sees the page only in
the video, and the hackathon asks for sample outputs in `examples/` specifically "so judges can
evaluate output quality without running the code". The images close that gap. They are the same
category of artifact as the JSON already in `examples/`: captured from a real run, not drawn.

Capturing them is the owner's action, like recording the video. Nothing here is generated.

## The two images

| File          | Page state | What has to be legible in it                                                                                                                                                                                            |
| ------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settled.png` | settled    | Four done boxes, the headline reading `all 4 finished, nothing out of date`, and the write-back cell reading `·· nothing to write yet`.                                                                                 |
| `flagged.png` | flagged    | Three amber boxes, `- order_total` / `+ order_total_usd` on the changed table, the subline naming how many never read it, the measured detection time, and the write-back cell counting the marks written into DataHub. |
| `cascade.gif` | flagging   | The moment itself, animated: three boxes turning amber, the amber path moving outward from the changed table, and the ribbon's measured figures landing.                                                                |
| `repair.gif`  | repairing  | The way back: flags coming off as one redo lands, the strip's `cleared … without a re-run` lines with their reasons, and the headline returning to nothing out of date.                                                 |

The two GIFs exist because a still of a finished cascade shows nothing moving, which was the exact
reason the edges were animated in the first place. Fourteen seconds each, cut around the moment a
swarm read confirmed it: three marks standing with all three tags for the cascade, zero marks
standing for the repair. `scripts/record.mjs` takes them, the way `scripts/capture.mjs`
takes the stills: it launches the real step through the launch route, records the live page with
Playwright, refuses to save anything when the moment never arrives or the step exits non-zero, and
writes the cut point beside each video.

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

All four were retaken on 2026-07-30 from commit `8a09994`, against a live DataHub and a live Codex
CLI. The set they replaced showed the page before the 2026-07-28 rebuild, when it was a scrolling
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
