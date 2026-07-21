# obsel

When several AI agents work on the same data at once, each one builds on what the others produced.
If something upstream changes after a downstream agent already finished, that finished work is now
wrong — and nothing tells anyone. It sits there marked complete.

obsel gives every agent task a real node in DataHub, wired to the data it reads and the data it
writes. When an upstream output changes, obsel walks DataHub's lineage graph and marks every
already-finished downstream task stale, with the reason and the change that caused it — including
work that never touched the change directly, only something built on it.

Built for [Build with DataHub: The Agent Hackathon](https://datahub.devpost.com/), category *Agents
That Do Real Work*. Apache-2.0.

---

## Status

**Early. The core mechanism is proven; the product around it is not built.**

What works, verified against a live DataHub on 2026-07-21: an agent task can be registered into the
graph wired to the data it reads and writes, and a change to an upstream table returns every
transitively affected task — including tasks that never touched the change directly. Measured at
92 ms for the full walk. That code is [`agents/graph.py`](agents/graph.py).

Not built yet: fingerprinting outputs so an identical re-run marks nothing, writing the stale marks
back into DataHub, the demo agent workers, and the dashboard.

Read everything below the setup section as describing intent, not shipped behavior, until this
section says otherwise.

## Requirements

- Node 24.x and pnpm 11
- Docker, for the local DataHub stack
- Python with the `acryl-datahub` CLI, for registering tasks into the graph
- `uv`, for running the DataHub MCP server

## Setup

Start the local DataHub stack. First run pulls several images and takes a few minutes:

```bash
datahub docker quickstart
```

DataHub's UI is then at `http://localhost:9002`. Its API (GMS) is at `http://localhost:8080` —
these are different ports and are not interchangeable; point clients at 8080.

Copy the environment template and install dependencies:

```bash
cp .env.example .env.local && pnpm install
```

`.env.example` documents every variable, including two that are pinned deliberately. Read the
comments before changing them — one of them silently disables all writes if set to `@latest`.

## Verified environment notes

[`docs/environment-findings.md`](docs/environment-findings.md) records DataHub behavior measured
directly on a local instance, including several traps that contradict the documentation and would
produce wrong results silently. Worth reading before writing code that touches DataHub:

| Finding | Consequence |
| --- | --- |
| `GET /entities/<urn>` returns a valid-looking response for **invented** URNs | Existence checks must use `DataHubGraph.exists()` |
| `mcp-server-datahub@latest` resolves to a read-only 0.4.0 | The version is pinned everywhere; `@latest` is forbidden |
| Writes are asynchronous | Confirming a write needs bounded polling, not one read-back |
| New tags cannot be minted at runtime | Vocabulary must be registered during setup |
| The quickstart disables auth | No access token can be issued, and none is needed |

## Layout

```
app/                     routing and composition (Next.js)
src/features/            dashboard UI
src/server/coordinator/  staleness engine - fingerprints, traversal, cascade (no model calls)
src/server/domain/       deterministic logic (no model calls)
src/server/datahub/      DataHub client, URN helpers, event subscription
agents/                  demo agent workers and the task emitter
docs/                    concept, environment findings, upstream contributions
examples/                sample outputs for judges
tests/                   deterministic tests
```

## Commands

```bash
pnpm dev         # dashboard at http://localhost:3000
pnpm verify      # format, lint, typecheck, test, build
pnpm test        # deterministic tests only
```

## Documentation

- [`docs/concept.md`](docs/concept.md) — what obsel is, the evidence the problem is real, what
  already exists, and what remains unverified
- [`docs/environment-findings.md`](docs/environment-findings.md) — measured DataHub behavior
- [`docs/upstream-contributions.md`](docs/upstream-contributions.md) — an upstream DataHub CLI bug
  found during setup, root-caused, with a proposed fix
- [`hackathon.md`](hackathon.md) — submission requirements and judging criteria
- [`CLAUDE.md`](CLAUDE.md) — rules for working in this repository
