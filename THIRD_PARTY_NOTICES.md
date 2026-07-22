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
| `geist` (Vercel)             | SIL OFL-1.1 / MIT | Geist and Geist Mono, self-hosted                  |
| Codex CLI (`openai/codex`)   | Apache-2.0        | Running each demo agent — see the note below       |

The fonts are installed from npm and served by obsel itself, never fetched from
`fonts.googleapis.com`. That is not a preference: obsel's Content Security Policy sets
`font-src 'self' data:`, which blocks the request outright, and `next/font/google` resolves at
build time so a machine with no network would fail to build. The mmux design system's own token
sheet uses a Google Fonts `@import`; obsel's copy deliberately does not.

**There is no shader or visualisation library.** The cockpit's WebGL backdrop is about sixty lines
of GLSL in `src/features/cockpit/backdrop-shader.ts`, written for this project. A commercial
shader library was evaluated and rejected — its licence makes integration code derivative and
still subject to that licence, which cannot be reconciled with obsel being Apache-2.0 in a public
repository, and it renders only under WebGPU, so it would have drawn nothing at all, silently, on
a judge's machine without it.

Node and Python dependency licences are recorded in `pnpm-lock.yaml` and
`agents/requirements.txt`.

## Sample data

`showcase-ecommerce`, DataHub's own sample datapack, is loaded on the development instance.
obsel's demo tables are generated locally by `agents/seed_data.py` from a fixed seed and
contain no real people, orders, or companies.

## The demo agents run on Codex, signed in with a ChatGPT subscription

**The decision, and why it is written down.** Each of the four demo agents is a real Codex
session invoked as `codex exec`, working on the data files with its own tools. On this
machine Codex is authenticated with a ChatGPT subscription (`auth_mode: chatgpt`), not an
API key. That choice sits in a genuine grey area, and pretending otherwise would be worse
than naming it.

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

obsel previously carried a second runner that called the OpenAI API directly. It was removed
on 2026-07-21 at the owner's instruction, along with the plan cache and the deterministic
plan-applier that existed only to serve it. Codex is the only runner, and `agents/` contains
no API-key path at all.

This is the account holder's decision, recorded here so it is visible rather than buried.
