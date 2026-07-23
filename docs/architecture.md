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
| `obsel.startedAt`          | ISO timestamp obsel moved the task to `running`      | `2026-07-21T14:01:56.031Z`                                                                   |
| `obsel.fingerprints`       | JSON: dataset URN to `{schema, content}` sha256 pair | `{"urn:li:dataset:(...)":{"schema":"8c25...","content":"f521..."}}`                          |
| `obsel.run.runner`         | what did the work, with its version                  | `codex-cli 0.144.4`                                                                          |
| `obsel.run.ms`             | ms the runner took, as the agent measured it         | `43937`                                                                                      |
| `obsel.run.outputs`        | JSON: dataset URN to `{rows, columns}`               | `{"urn:li:dataset:(...)":{"rows":39,"columns":["order_id","customer"]}}`                     |
| `obsel.stale.causedBy`     | dataset URN that actually moved                      | `urn:li:dataset:(...,obsel_demo.clean_orders,PROD)`                                          |
| `obsel.stale.causedByTask` | task URN that wrote it, or empty                     | `urn:li:dataJob:(...,clean_orders)`                                                          |
| `obsel.stale.hops`         | distance from the change, as a string                | `2`                                                                                          |
| `obsel.stale.changeKind`   | `schema`, `content`, or `both`                       | `schema`                                                                                     |
| `obsel.stale.reason`       | one plain-English sentence                           | `built on work from Daily revenue, which is itself out of date because clean orders changed` |
| `obsel.stale.since`        | ISO timestamp the mark was applied                   | `2026-07-21T14:05:52.244Z`                                                                   |

The last four are display only: `startedAt` lets the cockpit say how long work in flight has been in
flight, and the `obsel.run.*` group is what an agent reports about its own run. obsel's staleness
answer reads none of them, and a task carrying none of them still cascades correctly.

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

The cockpit is a separate, dumber path: it polls `GET /api/swarm` once a second and renders
whatever DataHub currently says. It never computes staleness.

What it _does_ compute is geometry and colour, and both are deliberately walled off from the
answer. `src/features/cockpit/graph/layout.ts` decides where every node and edge sits, and it never
receives a task's status — so the layout cannot move when three tasks flip to stale.
`tone.ts` decides colour from exactly `(status, hasMark)` and reads no timer. Between them, the
animation layer is left able to write only `stroke-dashoffset` and a caption's opacity: it is
structurally incapable of changing what the cockpit claims is true, so a dropped frame or an
interrupted transition cannot produce a wrong answer on camera.

Two invariants there are worth naming because breaking either produces a specific lie:

- **Amber fill if and only if `status === "stale"`.** A `StaleMark` deliberately outlives that
  status — a stale task being re-run to fix it sits at `running` with its mark attached — so a mark
  on non-stale work renders as an _outline_. That satisfies "only finished work goes stale" and
  "every mark carries its reason" at once, where "amber iff a mark exists" would violate the first.
- **Box widths are reserved from the widest label the graph could ever show**, derived from its
  shape rather than its state. Sizing from the current label is the intuitive thing and is wrong:
  "out of date · 2 hops" is wider than "done", so the graph would rescale on exactly the frame that
  matters most.

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
    |            announces BEFORE   --- POST /api/tasks/abandon ---------->  tasks/abandon/
    |            it works, and       --- POST /api/tasks/complete ---------->  tasks/complete/
    |            gives that back                                                  |
    |            if the work dies                                                 |
  fingerprint.py                                                                  v
    hashes what the task wrote                                     src/server/coordinator/
                                                                       engine.ts   (IO)
  setup.py     creates obsel-stale                                         |
  graph.py     registers DataJobs                                          | asks
  pipeline.py  the fixed 4-task shape                                      v
  seed_data.py the synthetic input                                     staleness.ts (pure,
                                                                        no network, no clock)
                                                                           |
  src/features/cockpit/                                                    | writes via
    cockpit.tsx      polls GET /api/swarm  <--- app/api/swarm/ ---+        v
    graph/layout.ts  geometry, pure                               |   src/server/datahub/
    naming.ts        human names, pure                            |
    trace-panel.tsx  polls GET /api/trace  <--- app/api/trace/ ---+
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

Checked against the working tree on 2026-07-23. Treat the shipped column as "present and
readable", not as "covered by end-to-end evidence" — see [Evidence](#9-evidence) below.

| Piece                                     | Path                                                                                                                        | State                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| The contracts                             | `src/server/coordinator/types.ts`                                                                                           | shipped                                |
| Staleness rules                           | `src/server/coordinator/staleness.ts`                                                                                       | shipped, 25 passing tests              |
| Coordinator IO                            | `src/server/coordinator/engine.ts`                                                                                          | shipped, no automated test yet         |
| GMS client                                | `src/server/datahub/client.ts`                                                                                              | shipped, no automated test yet         |
| MCP tag writes                            | `src/server/datahub/mcp.ts`                                                                                                 | shipped, no automated test yet         |
| URN shapes                                | `src/server/datahub/urns.ts`                                                                                                | shipped                                |
| HTTP API                                  | `app/api/swarm`, `app/api/trace`, `app/api/tasks/{register,start,abandon,complete}`, `app/api/demo/{reset,launch,activity}` | shipped                                |
| Cockpit                                   | `app/page.tsx`, `src/features/cockpit/`                                                                                     | shipped, 129 unit + 46 browser tests   |
| Live agent progress                       | `src/features/cockpit/progress.ts`                                                                                          | shipped, 23 passing tests, seen live   |
| The guide                                 | `src/features/cockpit/guide.ts`, `guide-panel.tsx`                                                                          | shipped, 19 passing tests, driven live |
| Human names for tasks and tables          | `src/features/cockpit/naming.ts`, `staleness.ts` — `tableLabel`, `taskLabel`                                                | shipped, 16 passing tests              |
| The coordinator's live trace              | `src/server/coordinator/trace.ts`, `trace-buffer.ts`, `app/api/trace`, `trace-panel.tsx`                                    | shipped, 10 tests, seen live           |
| Demo runner                               | `src/server/runner/` — `steps.ts`, `launcher.ts`, `preflight.ts`                                                            | shipped, 11 tests on the pure half     |
| Task registration and traversal in Python | `agents/graph.py`                                                                                                           | shipped, verified live                 |
| Fingerprinting                            | `agents/fingerprint.py`                                                                                                     | shipped, has a self-check              |
| Demo shape, jobs and seed data            | `agents/pipeline.py`, `agents/seed_data.py`                                                                                 | shipped                                |
| Vocabulary setup                          | `agents/setup.py`                                                                                                           | shipped                                |
| Agent worker and demo runner              | `agents/worker.py`, `agents/run.py`                                                                                         | shipped, no automated test yet         |
| Demo reset                                | `app/api/demo/reset/route.ts`, `engine.resetSwarm`                                                                          | shipped, no automated test yet         |
| Agent output contract                     | `agents/worker.py` — `canonicalise_numbers`                                                                                 | shipped, 7 self-check properties       |
| Sample outputs                            | `examples/`                                                                                                                 | shipped, captured from a real run      |

## 9. Evidence

What has been verified directly, and what has not.

**Verified:**

- The staleness rules, by 25 deterministic tests in `tests/staleness.test.ts`.
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

- **The demo end to end with live agents**, on 2026-07-22 against a live DataHub and a signed-in
  Codex CLI. `reset` → `run` → `rerun-same` → `change`, exit 0, every step's own assertions passing.
  `run` took 134.0 s for four Codex sessions; `rerun-same` produced a byte-identical table and obsel
  reported 0 changed outputs and 0 marks in 60 ms; `change` renamed one column, was correctly called
  `schema` rather than `both`, and marked exactly `build_revenue` (1 hop), `write_docs` and
  `write_report` (2 hops) in 2591 ms. That run exercises `engine.ts`, `client.ts` and `mcp.ts`
  against real DataHub, by hand rather than by an automated test.
- **The same demo driven from the browser alone**, later on 2026-07-22: five clicks in the
  cockpit's guide — reset, re-declare, run, identical re-run, change — with no terminal. Register
  wrote each task's job description onto its DataJob and read it back in 506 ms; `run` took
  112.2 s; the identical re-run reported 0 changed outputs and 0 marks confirmed in 106 ms; the
  rename was called `schema` and marked the same three tasks in 2310 ms. Each button spawned the
  real `agents.run` step through `POST /api/demo/launch`, and as a cross-check that the guide is
  state-derived, the closing `reset` was run from a terminal — the board tracked it identically.
- **The board naming agents in words, and narrating its own work**, on 2026-07-23 against a live
  DataHub and a signed-in Codex CLI. Driven from the browser: `reset` and `register` wrote each
  task's `obsel.title` and job description onto its DataJob and read both back, so the graph, the
  ledger, the guide and the trace all name `clean_orders` as "Orders cleaner" from DataHub rather
  than from a map in the frontend; `run` took 142.6 s for four Codex sessions; the rename was called
  `schema`, marked the same three tasks, and **`GET /api/trace` reported each step as it happened** —
  the swarm read (4 tasks), the comparison ("its columns changed; the values did not"), the walk
  ("Daily revenue (1 hop), Revenue report (2 hops), Table docs (2 hops)"), one step per confirmed
  mark, and a close of 3424 ms end to end, matching what the ledger and the stat ribbon showed.
- A second `reset` → `register` → `run` → `change` the same day, from the terminal with `--capture`,
  which produced the current `examples/` set: `run` 124.1 s, the rename called `schema`, the same
  three tasks marked in a measured 745 ms. Its fingerprints came out identical to the previous day's
  capture, which is the column contract and `canonicalise_numbers` doing their job across runs.
- The agent output contract, by the self-check in `agents/worker.py`: `217` and `217.0` reach one
  fingerprint, an id column keeps its integers, and a value that genuinely moved still moves the
  hash. Added after a live run where a single value's spelling broke two demo steps at once.

**Not verified:**

- **The demo has passed once per step, which is not a pass rate.** Codex is a live agent and its
  output has twice proved unstable in ways that made a re-run look like a real change — name casing,
  then numeric serialisation. Both are pinned now and both were caught by the demo's own assertions
  rather than on camera. A third category nobody has hit yet is a live possibility.
- The TypeScript path end to end against a live DataHub **as an automated test**. It has now been
  exercised by a real run (above), but nothing in `pnpm test` stands DataHub up and asserts the
  result, by design, so that `pnpm verify` needs no Docker.
- Whether obsel's marks survive a later re-ingestion.
- **A latency figure that means anything beyond one machine.** Every number quoted above is a single
  observation against a Docker quickstart on one laptop, and the spread across runs is wide — 745 ms,
  2310 ms, 2591 ms, 3424 ms for the same cascade — because it is dominated by how long DataHub takes
  to confirm each write, not by the deciding. `elapsedMs` in
  `examples/coordination-result.json` is measured, not a stand-in, but it is one sample.
- **The trace as anything more than narration.** It is emitted by the coordinator and has been
  watched live, but nothing reads it back and it is not persisted, so it is evidence of nothing on
  its own. The evidence is the marks in DataHub and the captures in `examples/`.

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

Eight routes. All of them are `force-dynamic`; nothing here is cached. Six carry obsel's own
protocol; the last two (`/api/demo/launch` and `/api/demo/activity`) belong to the demo runner —
they execute and report the demo's own CLI steps on the machine obsel runs on, exist so the
cockpit's guide can drive the demo without a terminal, and are not part of what an agent
integrating with obsel would ever call.

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

Declare a task, what it will touch, and optionally its job in one sentence. Idempotent in the
sense that re-registering resets the task to `registered` with no run state; it does not preserve
fingerprints, so it is not the way to re-run a task.

```jsonc
// request — SHORT dataset names; description optional, ≤300 chars
{
  "name": "build_revenue",
  "reads": ["clean_orders"],
  "writes": ["daily_revenue"],
  "description": "totals the clean orders into one revenue row per day",
}
```

```jsonc
// 200 — a TaskRecord, with the URNs the server built
{
  "urn": "urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),build_revenue)",
  "name": "build_revenue",
  "description": "totals the clean orders into one revenue row per day",
  "reads": ["urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.clean_orders,PROD)"],
  "writes": ["urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.daily_revenue,PROD)"],
  "status": "registered",
  "fingerprints": {},
  "finishedAt": null,
  "startedAt": null,
  "run": null,
  "stale": null,
}
```

The description is stored as the DataJob's own `dataJobInfo.description` — real graph metadata, so
DataHub's UI shows the same sentence the cockpit does. Reading a task back returns it as
`description`, null when the task registered without one (the placeholder older registrations
carried is filtered out rather than shown as though an agent had said it). Confirmed live
2026-07-22: registered through this route, read back off GMS at
`/openapi/v3/entity/datajob/<urn>` with the sentence on the entity, in a measured 506 ms for all
four tasks.

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

The server stamps `startedAt` here, on its own clock, and clears any `run` detail left by the
previous run. The cockpit subtracts `startedAt` from `SwarmSnapshot.at` to say how long work in
flight has been in flight — both timestamps come from this process, so the difference is an interval
rather than two machines disagreeing about the time.

**Agents call this before doing their work, not after.** That is what lets the board show an agent
working while it is working; it also means a run that dies owes the announcement back, which is what
`POST /api/tasks/abandon` is for.

### `POST /api/tasks/abandon`

Put a task that announced a start back to `registered`, because the run behind it failed.

```jsonc
// request — a full DataJob URN
{ "taskUrn": "urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),clean_orders)" }
```

```jsonc
// 200 — reverted is false when the task was not running, which is not an error
{ "task": { "…": "a TaskRecord, back at registered" }, "reverted": true }
```

Recorded fingerprints survive: they are the baseline the eventual successful run is compared
against, and dropping them would make that run read as a first run and mark nothing.

This route exists because obsel excludes `running` work from the cascade — correctly, since work in
flight picks up the new input itself. A task abandoned at `running` would therefore be skipped by
every later traversal while the board still showed a healthy swarm, which is a false negative.

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
  // Optional. Display only — obsel decides nothing on it, and an agent that
  // omits it gets an identical staleness answer.
  "run": {
    "runner": "codex-cli 0.144.4",
    "ms": 51128,
    "outputs": {
      "urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.clean_orders,PROD)": {
        "rows": 39,
        "columns": ["order_id", "customer", "order_total", "order_date"],
      },
    },
  },
}
```

`run.ms` is the **agent's** measurement of its own run, taken in one process, and obsel stores it
verbatim. It is deliberately not derived from `finishedAt` minus `startedAt`: those two are stamped
on different clocks, a mistake this codebase has already made once and documents in
[`timing.ts`](../src/features/cockpit/timing.ts). A completion that omits `run` clears any previous
detail rather than leaving it, so the cockpit never captions a run with the last one's numbers.

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

### `POST /api/demo/launch`

Run one demo step on this machine — the same `agents/.venv/bin/python -m agents.run <step>` the
README documents, spawned verbatim with no shell and no interpolation: the step name is a Zod enum
of the six commands, and nothing else from the request reaches the spawn. Answers immediately;
progress is read from `/api/demo/activity` and from the swarm itself.

One step at a time, enforced server-side with a 409 — the steps share the demo's tables, so a
`change` racing a `run` would corrupt both. A missing `agents/.venv` is also a 409, carrying the
exact commands that create it.

This route executes local processes by design. obsel's demo is a local tool on the machine that
owns the Codex login; nothing in this repository exposes it beyond localhost, and hosting was
explicitly decided against.

```jsonc
// request
{ "step": "run" } // "setup" | "register" | "run" | "rerun-same" | "change" | "reset"
```

```jsonc
// 200
{ "ok": true, "running": { "step": "run", "startedAt": "2026-07-22T…" } }
```

```jsonc
// 409 — refused, with the fix when there is one
{ "error": "run is already running — one step at a time, they share the same tables", "fix": null }
```

### `GET /api/demo/activity`

What the demo runner is doing right now: the running step, how the last one ended, the step's own
stdout/stderr tail (bounded to the newest 500 lines), and whether this machine's prerequisites
hold. The cockpit polls it every two seconds beside `/api/swarm`. Task state itself is never in
here — that lives in DataHub and comes back through the swarm read.

Each preflight check is a genuine observation carrying the exact fix command when it fails:
DataHub's `/config` answering, `agents/.venv` present, `codex login status` exiting 0 (cached ten
seconds so polling does not spawn it constantly), and `urn:li:tag:obsel-stale` existing — checked
with the genuine-404 predicate from [`environment-findings.md`](environment-findings.md) section 1,
because without the tag staleness would be detected and silently not recorded.

```jsonc
// 200
{
  "running": null,
  "lastResult": {
    "step": "rerun-same",
    "exitCode": 0, // null when killed by a signal instead
    "signal": null,
    "startedAt": "2026-07-22T…",
    "finishedAt": "2026-07-22T…",
    "durationMs": 61958, // start to exit, one clock — the server's
  },
  "log": ["$ agents/.venv/bin/python -m agents.run rerun-same", "…"],
  "preflight": {
    "datahub": { "ok": true, "detail": "DataHub answered at http://localhost:8080", "fix": null },
    "vocabulary": { "ok": true, "detail": "urn:li:tag:obsel-stale is registered", "fix": null },
    "venv": { "ok": true, "detail": "agents/.venv exists", "fix": null },
    "codex": { "ok": false, "detail": "the Codex CLI is not signed in", "fix": "codex login" },
  },
}
```

### `GET /api/trace`

The steps the coordinator took, in the order it took them, for the "what obsel is doing" panel.
Oldest first. The cockpit polls it every second — faster than the activity feed, because a whole
cascade arrives in one burst and a two-second poll would show it already finished.

Emitted by `engine.ts` as it works: the swarm read, one step per fingerprint comparison **whichever
way it goes**, the lineage walk with what it found, one step per mark once that mark's writes are
confirmed, and a closing step carrying the measured end-to-end figure. Tables and tasks are named the
way the stale reasons name them, through `tableLabel` and `taskLabel` in `staleness.ts`, so one task
is never called two different things on one screen.

Reads nothing from DataHub, so it answers even when GMS is unreachable — which is deliberate: a
panel explaining what obsel is doing is most useful when something is wrong.

**Narration, not a decision path, and a view rather than a record** — bounded to the newest 200
steps, in memory, process-local, gone on restart. Section 12 sets out what this panel may and may not
claim, and why the buffer is deliberately something nothing else depends on.

```jsonc
// 200
{
  "events": [
    {
      "seq": 42, // monotonic; survives a reset, so a fresh step is never mistaken for one already seen
      "at": "2026-07-23T01:52:53.514Z",
      "phase": "compare", // read | compare | walk | mark | write | done
      "message": "Compared the new clean orders against the fingerprint recorded last time.",
      "outcome": "its columns changed; the values did not", // null when the step has nothing to report
    },
  ],
}
```

## 12. What the cockpit's two side panels may and may not say

Both sit in the gutter beside the lineage graph, and neither carries a demo beat.

**The inspector** shows one task's uncompressed values: full URNs, complete 64-character
fingerprints, and every field of its stale mark. It computes nothing. In particular it never derives
an age or a freshness — the cockpit knows when it _read_ a value, not when that value became true,
and an inspector is exactly the place that distinction gets quietly lost. It is mounted only while a
task is selected. The gutter's height is fixed, so it appears without moving the graph, the ledger or
the stat ribbon; it borrows its room from the trace beside it and gives it back on close.

**The trace** is titled "what obsel is doing", and it replaced a panel that diffed two `GET
/api/swarm` bodies polled a second apart. That difference is the whole point of this section, so the
old panel's limits are worth stating: a diff could establish that a field differed from the previous
read and nothing else. It had not watched obsel read the lineage graph, compare a fingerprint, walk
the cascade, or poll DataHub until a write was confirmed, because none of that reached the browser.

It also had a sharper hazard — an **asserted absence**. `coordinateCompletion` writes the finishing
task's new fingerprints and its `complete` status _before_ it writes any stale mark, so there is a
window at least one poll wide in which a diff can truthfully observe "a new output was recorded, and
nothing was marked" while the cascade that is about to mark three tasks is still in flight. That
observation is true and the obvious sentence for it is a lie. The old panel therefore carried a
standing rule that no event may assert an absence.

The trace does not need that rule, and understanding why is the point. Its steps are emitted by
`coordinateCompletion` itself, in the order it performs them, so a step saying "Nothing was marked"
is not an inference drawn from a quiet screen a poll after the fact — it is the coordinator reporting
the result of a comparison it has finished making, in the same call, before it returns. The quiet
case became reportable by moving the reporting to the only place that knows.

Two limits still hold, and both are stated on the panel rather than left to be inferred:

- **It is narration, not a decision path.** Nothing in obsel reads these events back. Deleting every
  `emit` call would change no mark, no fingerprint and no traversal. That direction is deliberate: a
  trace something depended on would be state, and state that duplicates DataHub is state that can
  disagree with it.
- **It is a view, not a record.** The buffer is in memory, process-local, bounded to the newest 200
  steps, and does not survive a restart. The record is the marks in DataHub and the captures in
  `examples/`. The panel's footer says so, pinned below the scroller rather than inside it, because a
  disclosure that scrolls out of view is not a disclosure.

Each step is emitted **after** the thing it describes has happened — a mark's step is emitted once
`updateTaskProperties` and the tag write have been confirmed by bounded polling, not when the write
was issued. So the panel is always describing completed work, and can never show an intent that
subsequently failed.
