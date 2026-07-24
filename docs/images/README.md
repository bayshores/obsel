# Screenshots

What goes in this directory, and the rules that make the images worth including.

These are **not decoration**. A judge who will not start Docker currently sees the board only in
the video, and the hackathon asks for sample outputs in `examples/` specifically "so judges can
evaluate output quality without running the code". Two images close that gap. They are the same
category of artifact as the JSON already in `examples/`: captured from a real run, not drawn.

Capturing them is the owner's action, like recording the video. Nothing here is generated.

## The two images

| File          | Board state | What has to be legible in it                                                                                                                                                                            |
| ------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settled.png` | settled     | Four done boxes, the headline reading `all 4 finished, nothing out of date`, and the write-back cell reading `·· nothing to write yet`.                                                                 |
| `flagged.png` | flagged     | Three amber boxes, `- order_total` / `+ order_total_usd` on the changed table, the subline naming how many never read it, the measured detection time, and the write-back cell reading `3 of 3 tagged`. |

## Rules

1. **Viewport 1920 × 990 CSS px**, a full-screen browser on a 1080p display. That is the size the
   cockpit is laid out for and the size `pnpm e2e`'s `recording-1920x990` project asserts against.
   Do not zoom, and do not resize afterwards: the graph scales to its container, so a narrower
   capture shrinks the node labels below what the layout was designed for.
2. **Both from the same run.** The numbers have to agree with each other. A settled shot from one
   run beside a flagged shot from another is two different pipelines presented as one, which is the
   kind of quiet inconsistency obsel exists to catch.
3. **Nothing staged.** Capture whatever that run produced. If the detection time is 4102 ms, the
   image says 4102 ms.
4. **Nothing sensitive in frame.** No API key, no token, no email address, no other window, and no
   part of `.env.local`. Same rule as the video.
5. **Full frame, no crop.** The whole board including the header and the ribbon, so a reader can
   see that the numbers sit on the same screen as the graph.

## What is in here now

Both files exist, captured 2026-07-23 from commit `a485b95` against a live DataHub and a live Codex
CLI, and referenced from `README.md` and `examples/README.md`.

They came from one run, in this order: reset, then `run` (2 m 30 s, four Codex sessions) which produced
`settled.png`, then `change` (1 m 05 s) which marked three tasks in a measured 3636 ms and produced
`flagged.png`. Nothing between the two shots but the change itself.

`capture.mjs` at the repository root does it, and it refuses to mislabel a shot: it decides which board
it is looking at from the ribbon's write-back cell, which is derived from the marks, rather than from
the headline. The first version tested the headline for "out of date" and would have saved a settled
board as flagged, because the settled headline reads "all 4 finished, nothing out of date".

## Replacing them

Take the new pair with the same two commands, then update the date and commit in the caption in
`README.md` and in `examples/README.md`, so an image can always be tied back to a specific state of
the repository.

```bash
node capture.mjs settled   # after run, before change
```

```bash
node capture.mjs flagged   # after change
```
