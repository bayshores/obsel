# obsel

When several AI agents work on the same data at once, each one builds on what the others produced.
If something upstream changes after a downstream agent already finished, that finished work is now
wrong — and nothing tells anyone. It sits there marked complete.

obsel gives every agent task a real node in DataHub, wired to the data it reads and the data it
writes. When an upstream output changes, obsel walks DataHub's lineage graph and marks every
already-finished downstream task stale, with the reason and the change that caused it — including
work that never touched the change directly, only something built on it.

Built for [Build with DataHub: The Agent Hackathon](https://datahub.devpost.com/), category _Agents
That Do Real Work_. Apache-2.0.

---

## Status

**The whole loop is built. It has not yet been run end to end with a real model call.**

Updated 2026-07-21. Everything described below this section is code that exists in this repository
and type-checks, not a plan.

### Built

| Piece                                                | Where                                                                      |
| ---------------------------------------------------- | -------------------------------------------------------------------------- |
| A task is a `DataJob` with real lineage edges        | `agents/graph.py`, `src/server/datahub/urns.ts`                            |
| Output fingerprinting, schema and content separately | `agents/fingerprint.py`                                                    |
| The staleness rules, pure and testable               | `src/server/coordinator/staleness.ts`                                      |
| Marks written back into DataHub                      | `src/server/coordinator/engine.ts`, `src/server/datahub/mcp.ts`            |
| Four demo agent workers, each calling a real model   | `agents/worker.py`, `agents/run.py`                                        |
| The cockpit — graph, ledger, stats, feed, inspector  | `app/page.tsx`, `src/features/cockpit/`                                    |
| HTTP API, five routes including a demo reset         | `app/api/` — see [`docs/architecture.md`](docs/architecture.md) section 11 |

### Verified directly

- **The staleness rules**, by 24 deterministic tests in `tests/staleness.test.ts`. About half assert
  that nothing happens, which is deliberate — the failure that kills this kind of tool is a false
  alarm, not a miss. An identical re-run marks nothing, an unrelated branch is untouched, a running
  task is neither marked nor walked through, a cycle terminates.
- **The cockpit's own logic**, by 90 further tests across `tests/cockpit-*.test.ts`. The load-bearing
  ones: graph geometry is byte-identical across every task status, so nothing moves on the frame
  three tasks flip amber; no label can overflow its box, checked against measured per-character
  advances; a six-task pipeline the layout has never seen draws correctly; amber fills a node if and
  only if its status is `stale`; and no measurement is ever displayed that the coordinator did not
  record. The geometry assertions were confirmed to fail by reintroducing the status-dependent
  sizing they exist to forbid.
- **The cascade, end to end against a live DataHub** on 2026-07-21. A schema-only change posted to
  `POST /api/tasks/complete` — content byte-identical, schema moved — marked exactly
  `build_revenue` (1 hop), `write_report` and `write_docs` (2 hops), each with its reason, in a
  measured **6867 ms** including the bounded-poll confirmation of every DataHub write. Re-posting
  the identical fingerprint returned `changedOutputs: []`, marked nothing new, and left all three
  existing marks untouched.
- **The lineage assumption**, against a live DataHub (GMS `v1.5.0.6`, quickstart) on 2026-07-21. A
  `DataJob` registered with `Consumes`/`Produces` edges is returned when walking downstream from a
  dataset it reads, and the cascade is transitive. The full walk was measured at 92 ms. That
  measurement is of [`agents/graph.py`](agents/graph.py), the Python traversal, not the end-to-end
  path.
- **The MCP write path**, by round trip: apply the tag, confirm it through GraphQL, remove it,
  confirm removal.
- **The existence predicate and swarm enumeration**, by curl against the live instance —
  see [`docs/environment-findings.md`](docs/environment-findings.md) sections 1 and 9.

### Not done

- **The demo has never been run end to end with a real model call.** The coordination path has now
  been driven against a live DataHub — see the cascade measurement above — but by posting a
  completion report directly to the API, not by an agent that called a model to do actual work.
  Nobody has executed `setup` through `change` and watched the whole thing. That is the largest
  remaining gap and nothing here should be read as if it had happened.
- **There is no _automated_ test of the TypeScript path against a live DataHub.** `engine.ts`,
  `client.ts`, and `mcp.ts` have been exercised by hand against a running instance, but nothing in
  `pnpm test` stands DataHub up — those 114 tests cover pure decision logic only, by design, so
  that `pnpm verify` needs no Docker. `pnpm e2e` runs a real browser but stubs the endpoint, so it
  does not close this gap either.
- **The end-to-end latency number is a single observation, not a benchmark.** 6867 ms was measured
  once, on one machine, on 2026-07-21, against the quickstart stack. It is dominated by the bounded
  polling that confirms each DataHub write actually landed. The separate 92 ms figure is the Python
  traversal alone. `elapsedMs` in [`examples/`](examples/) is still a stand-in and its README says so.
- The `examples/` artifacts are illustrative rather than captured from a real run.
- The demo video is not recorded.

## Requirements

- Node 24.x and pnpm 11
- Docker, for the local DataHub stack
- Python 3, for the demo agents. They get their own virtual environment in step 4 below; the
  `datahub` CLI used to start the stack is a separate, global install of `acryl-datahub`
- `uv`, for running the DataHub MCP server
- **The Codex CLI, signed in.** `codex login status` should say so. Each demo agent is a real
  Codex session that reads the data, decides, and writes its table with its own tools. There is no
  API-key path and no offline mode — if Codex is missing or signed out, the run fails and says so.
  See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for the terms question this raises.

## Setup

Seven steps, in this order. Each one has a way to tell whether it worked, because several of them
fail quietly. The demo agents in `agents/` need their own Python environment — they are not
installed by `pnpm install`.

**1. Start DataHub.** The first run pulls several images and takes a few minutes.

```bash
datahub docker quickstart
curl -s http://localhost:8080/config      # should print JSON with a version
```

DataHub's UI is then at `http://localhost:9002`. Its API (GMS) is at `http://localhost:8080` —
these are different ports and are not interchangeable; point clients at 8080.

**2. Configure the environment.**

```bash
cp .env.example .env.local
```

`.env.example` documents every variable. The demo agents need no key here — they authenticate
through the Codex CLI. One variable,
`MCP_SERVER_DATAHUB_VERSION`, is pinned deliberately — read its comment before changing it, because
resolving it to `@latest` silently disables every write while still reporting success.

**3. Install the Node dependencies.**

```bash
pnpm install
```

**4. Create the Python environment for the agents.** This is separate from the Node install and is
easy to skip.

```bash
python3 -m venv agents/.venv
agents/.venv/bin/python -m pip install -r agents/requirements.txt
```

**5. Start obsel.**

```bash
pnpm dev        # http://localhost:3000 should show the cockpit, not an error
```

**6. Register obsel's vocabulary in DataHub.** Run every agent command from the repository root, so
`agents` imports as a package.

```bash
agents/.venv/bin/python -m agents.run setup
```

This creates `urn:li:tag:obsel-stale` and the demo DataFlow. It is not optional: obsel cannot create
a tag at run time, so without this step staleness is detected and silently not recorded. The command
fails loudly if either did not land.

**7. Run the demo.**

```bash
agents/.venv/bin/python -m agents.run register      # four tasks into DataHub
agents/.venv/bin/python -m agents.run run           # four agents finish, nothing stale
agents/.venv/bin/python -m agents.run rerun-same    # re-run produces the same table, marks nothing
agents/.venv/bin/python -m agents.run change        # renames a column, three tasks go stale
agents/.venv/bin/python -m agents.run reset         # back to the starting state
```

[`agents/README.md`](agents/README.md) explains what each command should print.

## Verified environment notes

[`docs/environment-findings.md`](docs/environment-findings.md) records DataHub behavior measured
directly on a local instance, including several traps that contradict the documentation and would
produce wrong results silently. Worth reading before writing code that touches DataHub:

| Finding                                                                      | Consequence                                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `GET /entities/<urn>` returns a valid-looking response for **invented** URNs | Existence is checked with `GET /openapi/v3/entity/<type>/<urn>`, which does 404 |
| The GraphQL lineage surface lags the graph store by minutes                  | Traversal is `GET /relationships`, never `searchAcrossLineage`                  |
| `mcp-server-datahub@latest` resolves to a read-only 0.4.0                    | The version is pinned everywhere; `@latest` is forbidden                        |
| Writes are asynchronous                                                      | Confirming a write needs bounded polling, not one read-back                     |
| New tags cannot be minted at runtime                                         | Vocabulary must be registered during setup                                      |
| The quickstart disables auth                                                 | No access token can be issued, and none is needed                               |

## Layout

```
app/                     routing and composition (Next.js), and the five HTTP routes
src/features/cockpit/    the cockpit: layout.ts, tone.ts, timing.ts, feed.ts (pure), then the pixels
src/server/coordinator/  types.ts, staleness.ts (pure rules), engine.ts (the IO half)
src/server/datahub/      client.ts (GMS HTTP), mcp.ts (tag writes), urns.ts (URN shapes)
src/server/domain/       reserved for deterministic logic; currently empty
agents/                  the four demo agent workers, fingerprinting, and the demo runner
docs/                    concept, architecture, environment findings, demo script
examples/                sample outputs for judges
tests/                   deterministic tests, no browser and no DataHub
e2e/                     Playwright checks that need a real browser
```

There is no event subscription and no scheduler. An agent reporting that it finished is what
triggers the check — see [`docs/architecture.md`](docs/architecture.md) section 3.

## Commands

```bash
pnpm dev         # cockpit at http://localhost:3000
pnpm verify      # format, lint, typecheck, test, build
pnpm test        # deterministic tests only
pnpm e2e         # browser checks; builds and serves the app itself
```

`pnpm e2e` is separate from `pnpm verify` on purpose. Verify is what this README asks a judge to
run, and it must stay free of Docker, DataHub and a browser download. The browser suite stubs
`GET /api/swarm` at the network layer, so it needs no DataHub either — which also means it verifies
the cockpit's rendering of a snapshot, not that obsel produces the right snapshot. The pure rules
cover that half.

Checked 2026-07-21: `pnpm verify` succeeds end to end — `pnpm format:check`, `pnpm lint`,
`pnpm typecheck`, `pnpm test` (114 passed), and `pnpm build`.

## Documentation

- [`docs/concept.md`](docs/concept.md) — what obsel is, the evidence the problem is real, what
  already exists, and what remains unverified
- [`docs/architecture.md`](docs/architecture.md) — how the pieces fit, why each decision was made,
  what exists, and the HTTP endpoint reference
- [`docs/environment-findings.md`](docs/environment-findings.md) — measured DataHub behavior
- [`docs/demo-script.md`](docs/demo-script.md) — the timed shot list for the submission video, with
  its preflight, its retake path, and what may and may not be claimed
- [`docs/upstream-contributions.md`](docs/upstream-contributions.md) — an upstream DataHub CLI bug
  found during setup, root-caused, with a proposed fix
- [`agents/README.md`](agents/README.md) — the four demo agents, what each command prints, and how
  they use the model
- [`examples/README.md`](examples/README.md) — sample outputs, and exactly which parts of them are
  real
- [`PREEXISTING.md`](PREEXISTING.md) — the hackathon's pre-existing-code disclosure
- [`hackathon.md`](hackathon.md) — submission requirements, judging criteria, and a self-assessment
- [`CLAUDE.md`](CLAUDE.md) — rules for working in this repository
