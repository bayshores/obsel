# Third-party software and services

What obsel depends on that it did not write, and the licence or terms each is used under.
The hackathon requires third-party SDKs, APIs, and tools to be used within their terms, so
the one judgement call is written out in full rather than summarised.

## Open-source dependencies

| Component                    | Licence           | Used for                                           |
| ---------------------------- | ----------------- | -------------------------------------------------- |
| DataHub (`datahub-project`)  | Apache-2.0        | The metadata platform obsel is built on            |
| `mcp-server-datahub` 0.6.0   | Apache-2.0        | The MCP Server, for writing the stale tag          |
| `acryl-datahub` (Python SDK) | Apache-2.0        | Creating entities and the tag, which MCP cannot do |
| `@modelcontextprotocol/sdk`  | MIT               | Speaking MCP from TypeScript                       |
| Next.js, React               | MIT               | The cockpit                                        |
| `@xyflow/react` 12.11.2      | MIT               | The lineage graph on the board                     |
| `@dagrejs/dagre` 3.0.0       | MIT               | Laying that graph out left to right                |
| `motion` 12.42.2             | MIT               | The guide's entrance and its moving rail cursor    |
| `geist` (Vercel)             | SIL OFL-1.1 / MIT | Geist and Geist Mono, self-hosted                  |
| Codex CLI (`openai/codex`)   | Apache-2.0        | Running each demo agent, see the note below        |
| Claude Code (Anthropic)      | proprietary       | The same, as the alternative runner, see below     |

The fonts are installed from npm and served by obsel itself, never fetched from
`fonts.googleapis.com`. That is not a preference: obsel's Content Security Policy sets
`font-src 'self' data:`, which blocks the request outright, and `next/font/google` resolves at
build time so a machine with no network would fail to build. The mmux design system's own token
sheet uses a Google Fonts `@import`; obsel's copy deliberately does not.

**There is no shader library.** The cockpit's WebGL backdrop is about sixty lines of GLSL in
`src/features/cockpit/backdrop-shader.ts`, written for this project. A commercial shader library
was evaluated and rejected: its licence makes integration code derivative and still subject to that
licence, which cannot be reconciled with obsel being Apache-2.0 in a public repository, and it
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

React Flow's attribution badge is left visible in the bottom-right of the graph. The MIT licence
does not compel that; removing it is what xyflow asks Pro subscribers to pay for, and leaving it is
the honest position for a public hackathon entry. It is toned down in
`src/features/cockpit/lineage.module.css` so it does not compete with the data, and it is not
hidden.

**The animation library is one feature's worth, and it replaced hand-written keyframes.** The
guide's rail marks which act of the walk the board is at, and the mark travels from one act to the
next when it advances. Doing that by hand means measuring both ticks on every poll and driving the
distance between them; `motion` does it declaratively with `layoutId`, and the same import took over
the guide's entrance, which was three `@keyframes` blocks, a `calc()` stagger driven by an inline
custom property, an element whose only job was to mask the headline, and a `prefers-reduced-motion`
block restating every end state by hand. It is imported through `LazyMotion` with `strict`, so the
full component API throws and only the feature bundle this uses is shipped.

**The Model Context Protocol SDKs, both ends, MIT.** `@modelcontextprotocol/sdk` (TypeScript) is how
obsel talks to DataHub's MCP server to write the stale tag, and how the live suite drives obsel's own
server as a real client. `mcp` (Python, pinned `==1.28.1` in `agents/requirements.txt`) is what
`agents/mcp_server.py` serves obsel's six tools over. Both are Anthropic's official SDKs for the
protocol, used through their documented interfaces.

Node and Python dependency licences are recorded in `pnpm-lock.yaml` and
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

## The demo agents run on a coding CLI, signed in with a consumer subscription

**The decision, and why it is written down.** Each of the four demo agents is a real session
of a coding CLI, working on the data files with its own tools: `codex exec` for Codex,
`claude -p` for Claude Code, chosen by `agents/runner_select.py`. On this machine both are
authenticated with a consumer subscription rather than an API key -- Codex with ChatGPT
(`auth_mode: chatgpt`), Claude Code with a Claude Max plan. That choice sits in a genuine
grey area, and pretending otherwise would be worse than naming it.

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
replied, linked the terms and the licence, and said plainly: "I'm an engineer, not a
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
