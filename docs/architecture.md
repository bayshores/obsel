# Architecture

How obsel is put together, and why each piece is where it is. Written 2026-07-21. This describes
the repository as it stands; anything not yet built is listed as such in
[What exists](#8-what-exists) rather than described in the present tense elsewhere.

---

## 1. The one idea

An agent task is a `DataJob` in DataHub.

That is the whole design. Everything else follows from it. A task's inputs and outputs are not a
description of its dependencies kept alongside the real ones — they are `Consumes` and `Produces`
lineage edges in DataHub's graph, the same edges a table would have. So "which finished agent work
does this change invalidate" and "what is downstream of this table" are the same question, answered
by the same traversal.

The consequence worth stating plainly: **obsel has no database.** There is no local store of task
state to fall out of sync with the catalog. If you delete obsel, the record of which agent built
what on top of what is still in DataHub, and it is still queryable.

## 2. Where task state lives

A `DataJob` gives us identity and edges. Everything else is carried in that DataJob's
`dataJobInfo.customProperties`, as strings, under an `obsel.` prefix. The keys are defined once, in
[`src/server/datahub/client.ts`](../src/server/datahub/client.ts) as `PROP`:

| Property                   | Holds                                                | Example                                                                                      |
| -------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `obsel.status`             | `registered`, `running`, `complete`, or `stale`      | `stale`                                                                                      |
| `obsel.finishedAt`         | ISO timestamp of the last completion                 | `2026-07-21T14:02:39.905Z`                                                                   |
| `obsel.fingerprints`       | JSON: dataset URN to `{schema, content}` sha256 pair | `{"urn:li:dataset:(...)":{"schema":"8c25...","content":"f521..."}}`                          |
| `obsel.stale.causedBy`     | dataset URN that actually moved                      | `urn:li:dataset:(...,obsel_demo.clean_orders,PROD)`                                          |
| `obsel.stale.causedByTask` | task URN that wrote it, or empty                     | `urn:li:dataJob:(...,clean_orders)`                                                          |
| `obsel.stale.hops`         | distance from the change, as a string                | `2`                                                                                          |
| `obsel.stale.changeKind`   | `schema`, `content`, or `both`                       | `schema`                                                                                     |
| `obsel.stale.reason`       | one plain-English sentence                           | `built on work from build_revenue, which is itself out of date because clean_orders changed` |
| `obsel.stale.since`        | ISO timestamp the mark was applied                   | `2026-07-21T14:05:52.244Z`                                                                   |

`customProperties` was chosen over structured properties for a measured reason, not a stylistic
one: a structured property has to be _defined_ before a value can be written, there is no MCP tool
that creates a definition, and the definition path was never exercised on this instance
([environment findings](environment-findings.md) section 8, item 1). Custom properties need no
setup and are visible in DataHub's UI. The cost is no typing and no per-property attribution, which
obsel does not currently need because the cause lives inside the value.

Alongside the properties, a stale task also gets the tag `urn:li:tag:obsel-stale`. The properties
are what obsel reads back; the tag is what a person sees in DataHub's own UI without knowing obsel
exists. **obsel cannot create that tag at runtime** — open-source DataHub's MCP surface has
`add_tags` but no `create_tag`, and applying an unregistered tag URN is rejected. It is created
once by [`agents/setup.py`](../agents/setup.py), which fails loudly if it did not land.

URN construction is in one place per language, and the two must agree character for character:
[`src/server/datahub/urns.ts`](../src/server/datahub/urns.ts) and
[`agents/graph.py`](../agents/graph.py).

```
dataset  urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.<name>,PROD)
task     urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),<taskId>)
flow     urn:li:dataFlow:(obsel,orders_pipeline,prod)
```

A DataJob URN _nests_ a DataFlow URN, so the task id is the last comma-separated segment, not the
second to last. That is a real bug that was hit and fixed during this work; both implementations
carry a comment saying so.

## 3. Completion is a push, not a poll

**An agent reporting that it finished is the trigger for everything obsel does.** There is no
polling loop over DataHub, no scheduler, and no event subscription.

This is the cheapest correct place to hang the check. An agent has to tell someone it is done
anyway. Doing the work at that moment means obsel's answer is computed against the graph as it is
at the instant of the change, and the latency it reports is honestly attributable to obsel rather
than to how often a timer happened to fire.

The flow, in [`src/server/coordinator/engine.ts`](../src/server/coordinator/engine.ts):

1. `POST /api/tasks/complete` arrives with a `CompletionReport` — the task URN, a fingerprint per
   output dataset, and a finish time.
2. Read the whole swarm out of DataHub. One snapshot, used for every decision that follows, so the
   answer is consistent even if the graph changes underneath.
3. For each reported output, compare its fingerprint against the one recorded when that task last
   finished. **A task that re-ran and produced exactly what it produced before yields nothing
   here**, and the rest of the work is skipped. This is the single most important branch in the
   product: without it every scheduled re-run marks the whole pipeline stale and the marks stop
   meaning anything.
4. Record the finishing task's new fingerprints and clear its own stale mark, if it had one. It has
   re-run, so it is trustworthy again.
5. Ask [`staleness.ts`](../src/server/coordinator/staleness.ts) which finished tasks the changed
   outputs invalidate, excluding the task that just ran so nothing marks itself.
6. Write each mark back: custom properties first, then the tag, so a tag never points at a task
   with no recorded cause. A tag write is confirmed by reading `globalTags` back, not by trusting
   the MCP server's acknowledgement.
7. Stamp the measured `detectedMs` onto every mark that was just written. This happens after the
   marks are already visible, on purpose: it is bookkeeping, and a failure here must not undo flags
   that landed. It is recorded rather than derived, because the dashboard subtracting two timestamps
   stamped in two different processes measures neither end of the real work and goes negative as
   soon as the upstream task runs again.
8. Return a `CoordinationResult` with a measured `elapsedMs` covering all of the above.

The dashboard is a separate, dumber path: it polls `GET /api/swarm` once a second and renders
whatever DataHub currently says. It never computes staleness.

## 4. Traversal reads the graph store, never the search index

This decision is load-bearing enough to have its own section, and it was a correction to an earlier
design rather than a first guess.

DataHub answers "what is downstream of this" from two different places:

| Surface                       | Backed by    | Sees data written seconds ago                |
| ----------------------------- | ------------ | -------------------------------------------- |
| GraphQL `searchAcrossLineage` | search index | **No** — measured lagging by over 90 seconds |
| REST `GET /relationships`     | graph store  | **Yes** — immediate                          |

obsel reasons about a swarm that is working right now, so the tasks it must see are always the most
recently registered ones — exactly the ones the search index cannot see yet. Building on
`searchAcrossLineage` would make obsel blind precisely when it matters, and the blindness would be
silent: it returns an empty list, not an error, and an empty list reads identically to "nothing is
affected".

`/relationships` returns one hop per call, so the cascade is walked by hand, alternating direction
by entity type:

```
dataset --(INCOMING "Consumes")--> the tasks that READ it
task    --(OUTGOING "Produces")--> the datasets it WROTE   --> repeat
```

That alternation is why a task can be reached that never touched the original change. Both
implementations do it: [`agents/graph.py`](../agents/graph.py) `downstream_of` (the version that
proved it against a live instance, full cascade measured at 92 ms) and
[`src/server/datahub/client.ts`](../src/server/datahub/client.ts) `relationships`.

Three other DataHub behaviours shape this module, all measured and all silent failure modes.
`GET /entities/<urn>` fabricates a well-formed response for any syntactically valid URN, so it is
never used to establish existence — `GET /openapi/v3/entity/datajob/<urn>` is, because it returns a
real 404 for a URN that was never written. `/relationships` pages, and a page followed only once
would understate what a change breaks, so `client.ts` follows pages until `total` is covered. And
writes are asynchronous, so confirming one requires polling with a bounded timeout rather than a
single read-back. Full reproductions are in
[`docs/environment-findings.md`](environment-findings.md), sections 1, 9, and 6.1.

## 5. Where the decisions are made, and where they are not

The split that matters most is between deciding and doing.

- [`src/server/coordinator/staleness.ts`](../src/server/coordinator/staleness.ts) is pure. No
  network, no clock, no DataHub. Every rule obsel's trustworthiness rests on — identical re-run
  marks nothing, the cascade is transitive, unfinished work is not eligible, a cycle terminates,
  the shortest path wins — is decided in this file and tested without standing anything up.
  [`tests/staleness.test.ts`](../tests/staleness.test.ts) holds 24 tests against it, about half of
  which assert that nothing is marked and nothing propagates.
- [`src/server/coordinator/engine.ts`](../src/server/coordinator/engine.ts) is the IO half. It
  reads, calls the pure functions, and writes the answers back. It decides nothing.

**Nothing in obsel's staleness reasoning is a model call.** It is graph traversal over recorded
hashes, so the same inputs always give the same answer, and the answer can be checked. A model is
used inside the demo agent workers to do those workers' actual jobs — cleaning a table, writing a
report — and nowhere else. The model in use is named in the workers' own output.

## 6. Where MCP is used

The DataHub MCP Server is used for one thing: applying and clearing the `obsel-stale` tag.
[`src/server/datahub/mcp.ts`](../src/server/datahub/mcp.ts).

It is not used for reads. Traversal goes over GMS HTTP for the latency and freshness reasons in
section 4, and reading a snapshot needs the exact `customProperties` map rather than a summarised
view. It is not used for entity creation either, because no MCP tool creates entities — that is the
Python SDK's job, in [`agents/graph.py`](../agents/graph.py) and
[`agents/setup.py`](../agents/setup.py).

Three constraints in that module are non-negotiable, each because the alternative fails silently:

- **The server version is pinned to 0.6.0.** `uvx mcp-server-datahub@latest` resolved to 0.4.0 on
  this machine, which registers zero mutation tools and ignores `TOOLS_IS_MUTATION_ENABLED` without
  a warning. obsel would detect staleness perfectly and mark nothing while reporting success.
- **The tool list is checked at connect time, not assumed.** The registered set is
  environment-dependent, so a missing `add_tags` is raised on connect rather than discovered when
  the first mark silently drops.
- **One connection per process.** Spawning a Python process per mark would add seconds to the
  latency obsel reports, and would make the measurement a claim about `uvx` startup.

## 7. The pieces, and the direction things move

```
  agents/                                    HTTP (localhost:3000)          app/api/
  ------------------------------             ---------------------          -------------------
  run.py       sequences the demo  --- POST /api/demo/reset ------------->  demo/reset/
  worker.py    executes one task  --- POST /api/tasks/register ----------->  tasks/register/
    |          calls a real model  --- POST /api/tasks/start -------------->  tasks/start/
    |                              --- POST /api/tasks/complete ---------->  tasks/complete/
    |                                                                             |
  fingerprint.py                                                                  v
    hashes what the task wrote                                     src/server/coordinator/
                                                                       engine.ts   (IO)
  setup.py     creates obsel-stale                                         |
  graph.py     registers DataJobs                                          | asks
  pipeline.py  the fixed 4-task shape                                      v
  seed_data.py the synthetic input                                     staleness.ts (pure,
                                                                        no network, no clock)
                                                                           |
  src/features/swarm/                                                      | writes via
    swarm-board.tsx  polls GET /api/swarm  <--- app/api/swarm/ ---+        v
    task-row.tsx     one task, its status                         |   src/server/datahub/
                                                                  |     client.ts  GMS HTTP
                                                                  +---- mcp.ts     MCP tag writes
                                                                        urns.ts    URN shapes
                                                                             |
                                                                             v
                                                                    DataHub GMS :8080
                                                                    DataHub UI  :9002
```

Port 8080 is GMS, the API. Port 9002 is the frontend proxy. They are not interchangeable; clients
point at 8080.

Directory rules, unchanged from [`CLAUDE.md`](../CLAUDE.md): `app/` routes and composes,
`src/features/` is browser code and must never import a server-only module, `src/server/domain/`
and `src/server/coordinator/` are deterministic and make no model calls, `src/server/datahub/` owns
every DataHub call.

## 8. What exists

Checked against the working tree on 2026-07-21. Several of these files landed while this document
was being written, so treat the shipped column as "present and readable", not as "covered by
end-to-end evidence" — see [Evidence](#9-evidence) below.

| Piece                                     | Path                                                       | State                                      |
| ----------------------------------------- | ---------------------------------------------------------- | ------------------------------------------ |
| The contracts                             | `src/server/coordinator/types.ts`                          | shipped                                    |
| Staleness rules                           | `src/server/coordinator/staleness.ts`                      | shipped, 24 passing tests                  |
| Coordinator IO                            | `src/server/coordinator/engine.ts`                         | shipped, no automated test yet             |
| GMS client                                | `src/server/datahub/client.ts`                             | shipped, no automated test yet             |
| MCP tag writes                            | `src/server/datahub/mcp.ts`                                | shipped, no automated test yet             |
| URN shapes                                | `src/server/datahub/urns.ts`                               | shipped                                    |
| HTTP API                                  | `app/api/swarm`, `app/api/tasks/{register,start,complete}` | shipped                                    |
| Dashboard                                 | `app/page.tsx`, `src/features/swarm/`                      | shipped                                    |
| Task registration and traversal in Python | `agents/graph.py`                                          | shipped, verified live                     |
| Fingerprinting                            | `agents/fingerprint.py`                                    | shipped, has a self-check                  |
| Demo shape and seed data                  | `agents/pipeline.py`, `agents/seed_data.py`                | shipped                                    |
| Vocabulary setup                          | `agents/setup.py`                                          | shipped                                    |
| Agent worker and demo runner              | `agents/worker.py`, `agents/run.py`                        | shipped, no automated test yet             |
| Demo reset                                | `app/api/demo/reset/route.ts`, `engine.resetSwarm`         | shipped, no automated test yet             |
| Sample outputs                            | `examples/`                                                | shipped, illustrative rather than captured |

## 9. Evidence

What has been verified directly, and what has not.

**Verified:**

- The staleness rules, by 24 deterministic tests in `tests/staleness.test.ts`, run 2026-07-21.
  These cover the negative cases specifically: identical re-run marks nothing, an unrelated branch
  is untouched, a running task is neither marked nor walked through, a cycle terminates, a task
  reachable two ways is reported once at its shortest distance.
- The lineage assumption, against a live DataHub (GMS v1.5.0.6, quickstart) on 2026-07-21: a
  `DataJob` registered with `Consumes`/`Produces` edges _is_ returned when walking downstream from
  a dataset it reads, and the cascade is transitive. Full walk measured at 92 ms.
- The MCP write path, by round trip: apply a tag, confirm it through GraphQL, remove it, confirm
  removal.
- The two HTTP behaviours `client.ts` depends on, by curl against the live instance on 2026-07-21:
  `GET /openapi/v3/entity/datajob/<urn>` returns 404 for an invented URN where `GET /entities/<urn>`
  returns a fabricated 200, and `GET /relationships` honours `start`/`count`/`total` when
  enumerating a flow's members. Reproductions in
  [`docs/environment-findings.md`](environment-findings.md) sections 1 and 9.

**Not verified:**

- **The demo has never been run end to end with a real model call.** Every step exists and is
  written down; nobody has executed `setup` through `change` against a live DataHub with a model key
  set and watched it work. This is the largest gap in the repository.
- The TypeScript path end to end against a live DataHub. Every module above exists and type-checks;
  none of it has an automated test that stands up DataHub and asserts the result.
- Whether obsel's marks survive a later re-ingestion.
- Any end-to-end latency number. The 92 ms figure is the Python traversal alone. `elapsedMs` in
  `examples/coordination-result.json` is a stand-in and is labelled as one.

## 10. Deliberately not here

- **A local database.** State lives in DataHub or it does not exist. That is the point.
- **A scheduler or event subscription.** Completion is a push, section 3.
- **Any model in the decision path.** Section 5.
- **Auth.** The local quickstart runs with `METADATA_SERVICE_AUTH_ENABLED=false` and issues no
  token. obsel sends one if `DATAHUB_GMS_TOKEN` is set and otherwise does not, which is the correct
  behaviour against a default quickstart and is not a production posture.
- **Anything that repairs stale work.** obsel reports which finished work is no longer built on
  something true. Deciding what to do about it is a person's job, or the next agent's.

## 11. The HTTP API

Five routes. All of them are `force-dynamic`; nothing here is cached.

**One asymmetry to know before you call anything:** `POST /api/tasks/register` takes **short dataset
names** — `clean_orders`, not a URN. Every other route, and every field in every response, uses full
URNs. The namespace and platform are applied server-side in `urns.ts` so that the naming convention
lives in one place and an agent cannot hand-build a malformed URN. If you send a URN to `register`
you get a task wired to `obsel_demo.urn:li:dataset:(...)`, which is a different entity that nothing
else will ever match.

Every route answers `400 {"error": string}` on a body that fails validation and
`500 {"error": string}` when the work fails. Errors are never an empty success: a swarm that cannot
be read is a 500, not an empty task list, because an empty board is indistinguishable from
"everything is fine".

The response types named below are defined in
[`src/server/coordinator/types.ts`](../src/server/coordinator/types.ts). [`examples/`](../examples)
holds full samples of the two largest, `GET /api/swarm` and `POST /api/tasks/complete`; the error
shapes are not sampled there.

### `POST /api/tasks/register`

Declare a task and what it will touch. Idempotent in the sense that re-registering resets the task
to `registered` with no run state; it does not preserve fingerprints, so it is not the way to
re-run a task.

```jsonc
// request — SHORT dataset names
{ "name": "build_revenue", "reads": ["clean_orders"], "writes": ["daily_revenue"] }
```

```jsonc
// 200 — a TaskRecord, with the URNs the server built
{
  "urn": "urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),build_revenue)",
  "name": "build_revenue",
  "reads": ["urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.clean_orders,PROD)"],
  "writes": ["urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.daily_revenue,PROD)"],
  "status": "registered",
  "fingerprints": {},
  "finishedAt": null,
  "stale": null,
}
```

The route fails rather than returning if DataHub stored a different number of inputs or outputs than
were sent — a rejected aspect pair can be dropped without failing the write.

### `POST /api/tasks/start`

Move a task to `running`. Work in flight is never marked stale, and its recorded fingerprints are
deliberately left in place as the baseline this run will be compared against.

```jsonc
// request — a full DataJob URN
{ "taskUrn": "urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),build_revenue)" }
```

Returns `200` with the updated `TaskRecord`. Starting a task that is already `running` is a 500.

### `POST /api/tasks/complete`

The one that matters. An agent reporting that it finished is what triggers the whole cascade.

```jsonc
// request — full URNs throughout; the fingerprint map is keyed by DATASET urn
{
  "taskUrn": "urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),clean_orders)",
  "fingerprints": {
    "urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.clean_orders,PROD)": {
      "schema": "f7b62a66…",
      "content": "f521e9dd…",
    },
  },
  "finishedAt": "2026-07-21T14:02:39.905Z",
}
```

```jsonc
// 200 — a CoordinationResult
{
  "taskUrn": "urn:li:dataJob:(…,clean_orders)",
  "changedOutputs": [
    { "dataset": "urn:li:dataset:(…,obsel_demo.clean_orders,PROD)", "kind": "schema" },
  ],
  "affected": [{ "task": { "…": "a TaskRecord as it was found" }, "mark": { "…": "a StaleMark" } }],
  "elapsedMs": 118,
}
```

`changedOutputs` empty means the fingerprints matched the previous run: nothing changed, so
`affected` is empty too. That is the quiet case, and it is the one the loud case depends on.
`elapsedMs` is measured across the whole call including the writes. Each `mark.detectedMs` carries
the same measurement, written onto the mark in DataHub.

### `GET /api/swarm`

Everything the dashboard shows, in one read. Polled once a second.

```jsonc
// 200
{
  "snapshot": {
    "flow": "urn:li:dataFlow:(obsel,orders_pipeline,prod)",
    "tasks": [],
    "at": "2026-07-21T…",
  },
  "ready": [],
  "blocked": [{ "task": {}, "waitingOn": ["urn:li:dataset:(…)"] }],
}
```

`tasks` is sorted by URN, so the board's row order does not depend on registration order. `ready`
and `blocked` are derived by `staleness.ts` from the same snapshot rather than computed separately.

### `POST /api/demo/reset`

Put the swarm back to its pre-run state for a second demo take. Any request body is ignored.

It clears two separate things, and that is the whole reason it exists: the `obsel.*` properties on
`dataJobInfo`, and the `urn:li:tag:obsel-stale` tag on `globalTags`. Those are different aspects, so
re-registering the tasks clears the properties and leaves the tags in place — DataHub's UI would
then show a stale tag from the previous take on a task obsel calls registered.

It deliberately does not delete the tasks. Their lineage edges are what the demo re-runs against.

```jsonc
// 200 — names, not URNs, because a human reads this one
{
  "ok": true,
  "reset": ["build_revenue", "clean_orders", "write_docs", "write_report"],
  "tagsCleared": ["write_docs"],
}
```

```jsonc
// 500
{ "ok": false, "error": "…" }
```

`reset` lists every task that was put back; `tagsCleared` lists only those that were actually
carrying a mark, so an empty `tagsCleared` means there was nothing to clear rather than that
clearing failed.
