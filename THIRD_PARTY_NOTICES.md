# Third-party software and services

What obsel depends on that it did not write, and the license or terms each is used under.
The hackathon requires third-party SDKs, APIs, and tools to be used within their terms, so
the one judgement call is written out in full rather than summarized.

## Open-source dependencies

| Component                    | License           | Used for                                                      |
| ---------------------------- | ----------------- | ------------------------------------------------------------- |
| DataHub (`datahub-project`)  | Apache-2.0        | The metadata platform obsel is built on                       |
| `mcp-server-datahub` 0.6.0   | Apache-2.0        | The MCP Server, for writing the stale tag                     |
| `acryl-datahub` (Python SDK) | Apache-2.0        | Creating entities and the tag, which MCP cannot do            |
| `@modelcontextprotocol/sdk`  | MIT               | Speaking MCP from TypeScript                                  |
| Next.js, React               | MIT               | The page                                                      |
| `@xyflow/react` 12.11.2      | MIT               | The lineage graph on the page                                 |
| `@dagrejs/dagre` 3.0.0       | MIT               | Laying that graph out left to right                           |
| `motion` 12.42.2             | MIT               | The guide's entrance and its moving rail cursor               |
| `geist` (Vercel)             | SIL OFL-1.1 / MIT | Geist and Geist Mono, self-hosted                             |
| `@noble/ed25519` 3.1.0       | MIT               | Ed25519 in the hosted verifier, where `node:crypto` cannot go |
| `@noble/hashes` 2.3.0        | MIT               | SHA-256 and SHA-512 in that same page                         |
| `buffer` (feross) 6.0.3      | MIT               | The `Buffer` polyfill that page's bundle needs                |
| `esbuild` 0.28.2             | MIT               | Bundling that page                                            |
| Codex CLI (`openai/codex`)   | Apache-2.0        | Running each demo agent, see the note below                   |
| Claude Code (Anthropic)      | proprietary       | The same, as the alternative runner, see below                |
| Remotion 4.0.503             | source-available  | Assembling the demo video, see the note below                 |
| `@xterm/xterm` 6.0.0         | MIT               | Replaying the recorded terminal sessions on screen            |

The fonts are installed from npm and served by obsel itself, never fetched from
`fonts.googleapis.com`. That is not a preference: obsel's Content Security Policy sets
`font-src 'self' data:`, which blocks the request outright, and `next/font/google` resolves at
build time so a machine with no network would fail to build. The mmux design system's own token
sheet uses a Google Fonts `@import`; obsel's copy deliberately does not.

**There is no shader library.** The page's WebGL backdrop is about sixty lines of GLSL in
`src/features/dashboard/backdrop/backdrop-shader.ts`, written for this project. A commercial shader library
was evaluated and rejected: its license makes integration code derivative and still subject to that
license, which cannot be reconciled with obsel being Apache-2.0 in a public repository, and it
renders only under WebGPU, so it would have drawn nothing at all, silently, on a judge's machine
without it.

**The lineage graph is a library, and this line used to claim otherwise.** It said "there is no
shader or visualisation library", which was true when written and stopped being true on
2026-07-23. The graph was about 800 lines of hand-written SVG: bezier control points, a collision
test that searched for a clear lane when an edge would otherwise cross a box, two `<marker>`
definitions for the arrowheads, and per-character width reservation so labels could not overflow.
It worked, and it was a layered-graph renderer being reinvented. React Flow and dagre replaced it,
which deleted roughly 250 lines of geometry outright and gave the cascade an edge animation that
runs continuously rather than once.

React Flow's attribution badge is left visible in the bottom-right of the graph. The MIT license
does not compel that; removing it is what xyflow asks Pro subscribers to pay for, and leaving it is
the honest position for a public hackathon entry. It is toned down in
`src/features/dashboard/graph/lineage.module.css` so it does not compete with the data, and it is not
hidden.

**The animation library is one feature's worth, and it replaced hand-written keyframes.** The
guide's rail marks which act of the walk the page is at, and the mark travels from one act to the
next when it advances. Doing that by hand means measuring both ticks on every poll and driving the
distance between them; `motion` does it declaratively with `layoutId`, and the same import took over
the guide's entrance, which was three `@keyframes` blocks, a `calc()` stagger driven by an inline
custom property, an element whose only job was to mask the headline, and a `prefers-reduced-motion`
block restating every end state by hand. It is imported through `LazyMotion` with `strict`, so the
full component API throws and only the feature bundle this uses is shipped.

**The Model Context Protocol SDKs, both ends, MIT.** `@modelcontextprotocol/sdk` (TypeScript) is how
obsel talks to DataHub's MCP server to write the stale tag, and how the live suite drives obsel's own
server as a real client. `mcp` (Python, pinned `==1.28.1` in `agents/requirements.txt`) is what
`agents/mcp_server.py` serves obsel's ten tools over. Both are Anthropic's official SDKs for the
protocol, used through their documented interfaces.

Node and Python dependency licenses are recorded in `pnpm-lock.yaml` and
`agents/requirements.txt`.

## Sample data

`showcase-ecommerce`, DataHub's own sample datapack, is loaded on the development instance.
The four-agent demo's tables are generated locally by `agents/seed_data.py` from a fixed
seed and contain no real people, orders, or companies.

The scale swarm's seed tables in `agents/seeds/` are derived from the **NYC Taxi and
Limousine Commission trip record data** (yellow taxi, January 2026) and the TLC taxi zone
lookup, published by the City of New York at nyc.gov/tlc as open data. Trip records carry
no passenger identities; the extract keeps 2,100 rows of times, zones, distances and
fares. The full derivation, source URLs and hashes are in
[`agents/seeds/PROVENANCE.md`](agents/seeds/PROVENANCE.md), and the extract is committed so
nothing is fetched from the TLC at demo time.

## The demo video

The submission video is assembled by `video/` with **Remotion 4.0.503**, driven by
`scripts/trailer-assets.mjs`. Remotion is source-available rather than open source, and
its license is the one dependency here that is not permissive: individuals, non-profits,
and for-profit organizations up to three employees may use it for free, including
commercially, and larger organizations need a paid company license. obsel is one
individual's hackathon entry, which is the first of those categories. Anyone forking this
repository at a company of four or more needs their own license to run
`npx remotion render`; nothing else in the repository depends on it, and the app builds
and the full verification suite passes without it. Remotion's own agent skills are installed
with `npx skills add remotion-dev/skills`; `skills-lock.json` records the set and the copies
under `.agents/` are not committed.

**The music is used under a video-use grant, and is not in this repository.** The track is
the opening section of _PUNCH_ by the YouTube channel `lostmemory.mp3`, whose description
grants free use in videos and projects on condition the channel is credited. That licenses
the finished video, not redistribution of the audio, so the file is never committed: the
render reads it from a working directory outside the tree, passed on the command line. The
credit rides in the published video's description, which is the owner's decision about
where it goes.

The footage is all recordings of this project running on the owner's machine: the board
(`scripts/video.mjs`), DataHub's own interface (`scripts/datahub-broll.mjs`), and two real
terminal sessions captured with **asciinema** (GPL-3.0, run through `uvx` and not vendored)
and replayed through **@xterm/xterm** (MIT) by `scripts/term-render.mjs`. Nothing on screen
is stock footage or a mockup.

**Two images are not the owner's, and both are in the video only.** The opening shot puts
the terminal on a desktop, and the desktop is dressed with them. Neither is in the product,
neither is committed, and both are copied into the render's working directory by
`scripts/trailer-assets.mjs`.

| Asset                                                                                                                                      | What it is                                                                                                                                     | Where it appears                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `wallpaper.jpg`                                                                                                                            | A community 4K recreation of "Bliss", the Windows XP default wallpaper. The original is a photograph by Charles O'Rear, licensed to Microsoft. | The desktop, 0:00 to 0:08                               |
| `computer.png`, `projects.png`, `trash.png`, `dock-terminal.png`, `dock-finder.png`, `dock-safari.png`, `dock-notes.png`, `dock-music.png` | Apple macOS system and application icons, taken from `CoreTypes.bundle` and the applications' own bundles on the owner's machine               | Three desktop icons and the five in the dock, same shot |

Both were supplied by the owner, who made the call to use them. The scene they are in is
about eight seconds of a three-minute video and exists to say that the setup is two
commands typed on an ordinary desktop. Neither image is redistributed here: the repository
ignores `video/` entirely, so the files sit outside what a fork receives, and anyone
re-rendering supplies their own. An earlier cut drew the desktop from four CSS gradients
and three gray rectangles for exactly this reason; the owner replaced it and this entry is
the record of that.

## The demo agents run on a coding CLI, signed in with a consumer subscription

**The decision, and why it is written down.** Each of the four demo agents is a real session
of a coding CLI, working on the data files with its own tools: `codex exec` for Codex,
`claude -p` for Claude Code, chosen by `agents/runner_select.py`. On this machine both are
authenticated with a consumer subscription rather than an API key -- Codex with ChatGPT
(`auth_mode: chatgpt`), Claude Code with a Claude Max plan. That choice sits in a genuine
gray area, and pretending otherwise would be worse than naming it.

The Codex terms question below was researched first and in more depth, because Codex was the
only runner until 2026-07-28. The same shape of question applies to Claude Code under a
consumer plan, and it has not been researched to the same depth. What is stated about Codex
below should not be read as covering both.

**What is clearly permitted.** The Codex CLI itself is Apache-2.0. OpenAI's own
documentation explicitly endorses non-interactive use: it describes calling `codex exec`
"from repeatable workflows and pipelines" and lists "Compose with scripts and CI" as a
capability of the tool. Scripted invocation is a documented, first-class feature of the
product, not a workaround.

**What is not clearly settled.** OpenAI's Terms of Use prohibit using "any automated or
programmatic method to extract data or output from the Services, including scraping, web
harvesting, or web data extraction," _except as permitted through the API_. Scripted use
under subscription authentication sits inside that carve-out's shadow. A developer asked
OpenAI to reconcile the two in [openai/codex discussion #8338](https://github.com/openai/codex/discussions/8338),
noting that Codex CLI is inherently making programmatic requests. An OpenAI engineer
replied, linked the terms and the license, and said plainly: "I'm an engineer, not a
lawyer, so I'm not qualified to answer your questions in detail." Two further developers
have asked related questions in the same thread. As of 2026-07-21 there is no
authoritative answer.

**What obsel does and does not do.** It invokes the official CLI through its documented
non-interactive interface, on the account holder's own machine, under their own
subscription and their own rate limits. It does not fork or patch the client, use
undocumented or private endpoints, proxy multiple users through one account, resell or
share access, bypass rate limits, or bulk-extract anything. Four short agent runs per demo.

**How to remove the ambiguity.** Codex also authenticates with an API key, which lands
squarely inside the terms' explicit API carve-out. Anyone reproducing this who would rather
not rely on the reading above can log the Codex CLI in with an API key instead of a ChatGPT
account, changing nothing else in this repository.

obsel previously carried a runner that called the OpenAI API directly. It was removed on
2026-07-21 at the owner's instruction, along with the plan cache and the deterministic
plan-applier that existed only to serve it. Claude Code was added as a second CLI runner on
2026-07-28, for the opposite reason: it is another agent product invoked through its own
documented non-interactive interface, not an API-key path. `agents/` still contains no
API-key path at all, and obsel's own coordinator makes no model calls under either runner.

This is the account holder's decision, recorded here so it is visible rather than buried.
