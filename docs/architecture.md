# Architecture

How obsel is put together, and why each piece is where it is. Written 2026-07-21. This describes
the repository as it stands; anything not yet built is listed as such in
[What exists](#8-what-exists) rather than described in the present tense elsewhere.

---

## 1. The one idea

An agent task is a `DataJob` in DataHub.

That is the whole design. Everything else follows from it. A task's inputs and outputs are not a
description of its dependencies kept alongside the real ones. They are `Consumes` and `Produces`
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
| `obsel.stale.columns`      | JSON: which columns left and arrived, or absent      | `{"added":["order_total_usd"],"removed":["order_total"]}`                                    |
| `obsel.stale.reason`       | one plain-English sentence                           | `built on work from Daily revenue, which is itself out of date because clean orders changed` |
| `obsel.stale.since`        | ISO timestamp the mark was applied                   | `2026-07-21T14:05:52.244Z`                                                                   |

`startedAt`, the `obsel.run.*` group and `obsel.stale.columns` are display only. `startedAt` lets the
cockpit say how long work in flight has been in flight; `obsel.run.*` is what an agent reports about
its own run; `obsel.stale.columns` names which columns moved so the board can show
`- order_total / + order_total_usd` instead of a sha256. obsel's staleness answer reads none of them,
and a task carrying none of them still cascades correctly.

`obsel.stale.columns` describes a change rather than detecting one: `compareFingerprints` has already
settled `changeKind` from the sha256 pair by the time it is computed. It is derived from
`obsel.run.outputs`, which obsel already recorded, by comparing the previous run's column list
against the incoming one, so no new evidence is collected. It is absent on a content-only change and
on every mark written before 2026-07-23, and the board falls back to "the columns in clean orders
changed" when it is.

One consequence is worth naming because it reversed an earlier decision. `startTask` used to clear
`obsel.run.*`, so that live work could not be captioned with the previous run's row count. Those are
exactly the shapes the column diff is computed against, so clearing them left every mark with no
columns to report. They now survive a run, like the fingerprints and for the same reason: one is the
baseline for detecting a change, the other for describing it. Nothing mis-captions, because
`activityNote` returns an in-flight elapsed for a running task without ever consulting `run`.

`customProperties` was chosen over structured properties for a measured reason, not a stylistic
one: a structured property has to be _defined_ before a value can be written, there is no MCP tool
that creates a definition, and the definition path was never exercised on this instance
([environment findings](environment-findings.md) section 8, item 1). Custom properties need no
setup and are visible in DataHub's UI. The cost is no typing and no per-property attribution, which
obsel does not currently need because the cause lives inside the value.

Alongside the properties, a stale task also gets the tag `urn:li:tag:obsel-stale`. The properties
are what obsel reasons over; the tag is what a person sees in DataHub's own UI without knowing obsel
exists. **obsel cannot create that tag at runtime**, because open-source DataHub's MCP surface has
`add_tags` but no `create_tag`, and applying an unregistered tag URN is rejected. It is created
once by [`agents/setup.py`](../agents/setup.py), which fails loudly if it did not land.

### The tag is read back onto the board

`globalTags` is now parsed into every `TaskRecord` as `tags` (every tag URN DataHub reports, sorted)
and `staleTagged` (whether obsel's own is among them), by
[`src/server/datahub/tags.ts`](../src/server/datahub/tags.ts). This costs **no extra request**:
`readTaskEntity` already returns the aspect, which is how `readTagUrns` has always worked, and
`toTaskRecord` simply discarded it.

**Neither field enters any decision.** `compareFingerprints` decides staleness, on sha256 and nothing
else. They exist so the cockpit can show that obsel's contribution to the catalog actually landed
rather than assert it: the stat ribbon reports `3 of 3 tagged`, and the details panel lists the tags
in full and links to the entity page.

Three consequences worth stating, because each is a claim the board can now make and could get wrong:

- **A shortfall is usually a write in flight, not a failure.** obsel writes the mark and then the tag,
  and DataHub's writes are asynchronous, so a marked task legitimately has no tag for a moment. The
  ribbon therefore counts rather than ticks: `2 of 3` moving to `3 of 3` reads as progress, where a
  cross would read as broken and be wrong.
- **A tag with no mark never resolves itself**, and is counted separately as `left over`. It is what a
  reset done by hand leaves behind, since the properties and the tag live on different aspects of the
  same entity. That is the most damaging frame the demo video
  could contain, and the board can now say it out loud.
- **Absent is not zero.** A snapshot captured before these fields existed carries no tag information,
  and the board reports `not recorded`. Rendering `0 of 3` would claim DataHub is missing three tags
  obsel never looked for. Understating obsel's own contribution is as much a false claim as
  overstating it.

`parseTagUrns` drops an unusable entry rather than raising, following `parseRun` and not `parseStale`:
this is the one aspect obsel reads that it does not write, so a human or an ingestion recipe can put
anything there, and a malformed entry must not fail a whole snapshot read. The visible cost is that an
unreadable tag goes uncounted and the figure reads low, which errs toward understating obsel.

It lives in its own module rather than in `client.ts` because `client.ts` carries `import
"server-only"`, which makes it unimportable from a test as well as from the browser. That guard is why
`client.ts` has no unit tests at all; a pure parser behind it would be a pure parser nothing can
check.

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

1. `POST /api/tasks/complete` arrives with a `CompletionReport`, holding the task URN, a fingerprint
   per output dataset and a finish time.
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

What it _does_ compute is position and colour, and both are deliberately walled off from the
answer. `src/features/cockpit/graph/positions.ts` hands the swarm to dagre and never passes a task's
status, so the layout cannot move when three tasks flip to stale. `tone.ts` decides colour from
exactly `(status, hasMark)` and reads no timer. `graph/cascade.ts` decides which edges the change
travelled along by reading hop counts off the marks obsel wrote, rather than re-deriving them from
topology, so the picture cannot claim a change reached work obsel decided it did not reach. Between
them, the animation layer is left able to write only `stroke-dashoffset`: it is structurally
incapable of changing what the cockpit claims is true, so a dropped frame or an interrupted
transition cannot produce a wrong answer on camera.

The graph itself is [React Flow](https://reactflow.dev) with a dagre layout, which replaced about
800 lines of hand-written SVG on 2026-07-23. Two things came with the change. The cascade edges
animate continuously while the marks stand, where the previous version drew once over 400 ms and
then held still for the session, so a screenshot showed a finished picture with nothing to say a
change had travelled. And the nodes are HTML rather than positioned `<text>`, which is what lets the
changed table carry a two-line column diff.

Two invariants there are worth naming because breaking either produces a specific lie:

- **Amber fill if and only if `status === "stale"`.** A `StaleMark` deliberately outlives that
  status, since a stale task being re-run to fix it sits at `running` with its mark attached, so a mark
  on non-stale work renders as an _outline_. That satisfies "only finished work goes stale" and
  "every mark carries its reason" at once, where "amber iff a mark exists" would violate the first.
- **Box widths are reserved from the widest label the graph could ever show**, derived from its
  shape rather than its state. Sizing from the current label is the intuitive thing and is wrong:
  "out of date · 2 hops" is wider than "done", so the graph would rescale on exactly the frame that
  matters most.

React Flow's `fitView` prop frames the graph once, on mount, and never again, which is a trap here
rather than a detail. Three things change the framing afterwards: the panel has a 220px floor and
shrinks on a short viewport, the guide panel above it changes height as the demo moves between
stages, and the changed table's node grows from 56px to 84px when the column diff appears, so dagre
lays the whole graph out taller than the bounds that were fitted. `lineage.tsx` therefore refits on
two signals of its own: a `ResizeObserver` on the panel, and `useNodesInitialized` after the
picture's content changes.

The failure it prevents is silent and total. The panel clips its overflow, so a graph fitted
against a stale size sits entirely outside the visible area: nine nodes and eight edges present
and correct in the DOM, none of them on screen, and no warning anywhere. `e2e/cockpit.spec.ts`
asserts every node stays inside the panel across a resize.

Interaction is bounded rather than off, which reverses an earlier decision and records why. All
interaction used to be disabled: a stranded graph had no way back, so nothing was allowed to move
it. The forty-task board changed the arithmetic, because its whole-graph fit is zoom 0.58 and its
labels land at 7.5 px, so the fitted frame is an overview and the design-size detail exists only
if a reader can go and get it. The reading moves are on (drag pans, pinch zooms, React Flow's own
zoom and fit buttons restyled to obsel's tokens), the recovery the lock used to substitute for is
on screen at all times (the fit button), and the editing moves stay off: nodes cannot be dragged,
connected or selected, because the layout is dagre's statement of the pipeline's shape and a node
moved by hand would put the picture in disagreement with the record. The scroll wheel deliberately
does not zoom, so the tall page stays scrollable over its largest region. `READING` and `RANGE`
in `lineage.tsx` carry the full reasoning; `e2e/scale.spec.ts` zooms to design size, strands the
picture with a hard pan on purpose, and asserts the fit button recovers it.

## 4. Traversal reads the graph store, never the search index

This decision is load-bearing enough to have its own section, and it was a correction to an earlier
design rather than a first guess.

DataHub answers "what is downstream of this" from two different places:

| Surface                       | Backed by    | Sees data written seconds ago               |
| ----------------------------- | ------------ | ------------------------------------------- |
| GraphQL `searchAcrossLineage` | search index | **No**, measured lagging by over 90 seconds |
| REST `GET /relationships`     | graph store  | **Yes**, immediate                          |

obsel reasons about a swarm that is working right now, so the tasks it must see are always the most
recently registered ones, exactly the ones the search index cannot see yet. Building on
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
never used to establish existence. `GET /openapi/v3/entity/datajob/<urn>` is, because it returns a
real 404 for a URN that was never written. `/relationships` pages, and a page followed only once
would understate what a change breaks, so `client.ts` follows pages until `total` is covered. And
writes are asynchronous, so confirming one requires polling with a bounded timeout rather than a
single read-back. Full reproductions are in
[`docs/environment-findings.md`](environment-findings.md), sections 1, 9, and 6.1.

## 5. Where the decisions are made, and where they are not

The split that matters most is between deciding and doing.

- [`src/server/coordinator/staleness.ts`](../src/server/coordinator/staleness.ts) is pure. No
  network, no clock, no DataHub. Every rule obsel's trustworthiness rests on is decided in this file
  and tested without standing anything up: an identical re-run marks nothing, the cascade is
  transitive, unfinished work is not eligible, a cycle terminates, the shortest path wins.
  [`tests/staleness.test.ts`](../tests/staleness.test.ts) holds 38 tests against it, about half of
  which assert that nothing is marked and nothing propagates.
- [`src/server/coordinator/engine.ts`](../src/server/coordinator/engine.ts) is the IO half. It
  reads, calls the pure functions, and writes the answers back. It decides nothing.

**Nothing in obsel's staleness reasoning is a model call.** It is graph traversal over recorded
hashes, so the same inputs always give the same answer, and the answer can be checked. A model is
used inside the demo agent workers to do those workers' actual jobs, such as cleaning a table or
writing a report, and nowhere else. The model in use is named in the workers' own output.

## 6. Where MCP is used, in both directions

obsel is on both ends of the protocol, and the two ends have nothing to do with each other beyond
sharing a transport.

**As a client**, of DataHub's MCP server, for one thing: applying and clearing the `obsel-stale` tag.
[`src/server/datahub/mcp.ts`](../src/server/datahub/mcp.ts).

It is not used for reads. Traversal goes over GMS HTTP for the latency and freshness reasons in
section 4, and reading a snapshot needs the exact `customProperties` map rather than a summarised
view. It is not used for entity creation either, because no MCP tool creates entities. That is the
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

The cached connection survives its own subprocess dying, which was paid for on 2026-07-24: the
cache used to be cleared only when connecting failed, so a session that connected and died hours
later left a corpse every call hit, and completions 500ed at the tag step with the decision
already committed. The fix is drop-on-close plus one reconnect retry, matched narrowly to the
SDK's two closed-transport error shapes and safe because both tag tools are idempotent. The live
test kills the real subprocess and asserts the next apply lands, read back over GMS.

A related ceiling lives on the other side of the API: every agent mutation call, in
`agents/worker.py` and the MCP server both, waits up to `MUTATION_TIMEOUT` (300 s) rather than the
60 s read default, because a completion is answered only after the whole cascade is walked,
written and confirmed, and a slow DataHub genuinely outran a 60 s client once while the server
finished the work. A timeout on a mutation is an unknown outcome, not a failure; the ceiling is
what keeps the two distinct.

**As a server**, so an agent that is not in this repository can join a swarm.
[`agents/mcp_server.py`](../agents/mcp_server.py) serves six tools over stdio: `check_freshness`,
`register_task`, `announce_start`, `report_complete`, `abandon_task`, `read_board`. Three properties
of it are deliberate:

- **Every mutation goes through obsel's HTTP API** (section 11). The module imports no DataHub SDK
  and holds no credentials, so `staleness.ts` remains the only way anything is ever marked. There is
  no second path onto the graph for an agent to talk its way through.
- **There is no tool that marks or clears staleness.** A tool to declare something fresh would be a
  tool to silence obsel. A mark is cleared by redoing the work and reporting it.
- **Agents never compute a fingerprint.** `report_complete` takes a `{"path": ...}` to the real
  file (preferred, because a model pasting rows inline can drift them and a drifted row is a change
  nobody made) or the rows themselves, and hashes them on obsel's side, through the same
  `canonicalise_numbers` → `fingerprint` path `worker.run_task` uses. An agent that could hand
  obsel a hash could hand it the previous hash and be believed.
- **A completion can also carry what the task read**, in the same forms, as `inputs`. The engine
  compares each observation against what that dataset's producer recorded writing; a mismatch means
  the table was changed by something that never reported, and every finished task built on the old
  version is marked, with `causedByTask` left null because the author is unknown. This is the
  writer-independent half of detection: one silent writer cannot hide from the next honest reader.
  The first observation triggers the cascade and is written onto the producer's record
  (`obsel.observed`), so a second identical read compares clean instead of re-flagging.
- **A stale observation is not automatically a silent edit.** In a concurrent swarm a task can read
  a table, keep working while that table's producer re-reports it, and then finish holding an
  observation that is one version old with nothing unreported anywhere. The engine keeps the
  fingerprint each re-report replaces (`obsel.fingerprints.previous`, one version deep), and
  `classifyObservation` in `staleness.ts` decides what an observation means: matching the standing
  record is clean; matching the replaced version means the finishing task itself is marked stale,
  with the producer named and the reason saying the table was replaced before this task finished;
  matching nothing is the unreported-change path above. Before this distinction existed, the
  straddling reader was the worst of both worlds: itself unflagged, because the cascade excludes
  the reporter, while a false "nothing reported this change" alarm re-marked other tasks with a
  wrong story. One version of memory is deliberate: a run that straddles two re-reports of one
  input classifies as unknown and over-alarms with an unknown author, which is the direction every
  obsel rule falls, rather than under-flagging.

The decisions live in [`agents/mcp_core.py`](../agents/mcp_core.py), which imports nothing outside
the standard library so `pnpm verify` can check them without the virtual environment. The wiring is
covered by [`tests/live/obsel-mcp.live.test.ts`](../tests/live/obsel-mcp.live.test.ts): a real MCP
client, over real stdio, into the real Python server, against a real obsel and a real DataHub.

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
    cockpit.tsx        polls GET /api/swarm <--- app/api/swarm/ --+        v
    graph/positions.ts dagre layout, pure                         |   src/server/datahub/
    graph/cascade.ts   which edges lit, pure                      |
    lineage.tsx        React Flow + nodes.tsx                     |
    naming.ts          human names, pure                          |
    datahub-link.ts    links out to DataHub's UI, pure             |
    passes.ts          groups the trace by decision, pure          |
    trace-panel.tsx    polls GET /api/trace <--- app/api/trace/ --+
                                                                  |     client.ts  GMS HTTP
                                                                  +---- mcp.ts     MCP tag writes
                                                                        tags.ts    reads globalTags
                                                                        urns.ts    URN shapes
                                                                             |
                                                                             v
                                                                    DataHub GMS :8080
                                                                    DataHub UI  :9002
```

Port 8080 is GMS, the API. Port 9002 is the frontend proxy. They are not interchangeable; clients
point at 8080.

Directory rules: `app/` routes and composes,
`src/features/` is browser code and must never import a server-only module, `src/server/domain/`
and `src/server/coordinator/` are deterministic and make no model calls, `src/server/datahub/` owns
every DataHub call.

## 8. What exists

Checked against the working tree on 2026-07-23. Treat the shipped column as "present and
readable", not as "covered by end-to-end evidence". See [Evidence](#9-evidence) below.

| Piece                                       | Path                                                                                                                        | State                                               |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| The contracts                               | `src/server/coordinator/types.ts`                                                                                           | shipped                                             |
| Staleness rules                             | `src/server/coordinator/staleness.ts`                                                                                       | shipped, 34 passing tests                           |
| Coordinator IO                              | `src/server/coordinator/engine.ts`                                                                                          | shipped, 14 integration tests vs a live DataHub     |
| GMS client                                  | `src/server/datahub/client.ts`                                                                                              | shipped, exercised by those 14 plus 14 on `tags.ts` |
| MCP tag writes                              | `src/server/datahub/mcp.ts`                                                                                                 | shipped, 8 integration tests vs the real MCP server |
| The integration harness                     | `tests/live/`, `vitest.live.config.ts`, `tests/support/server-only.ts`                                                      | shipped, 44 tests, no stand-ins                     |
| URN shapes                                  | `src/server/datahub/urns.ts`                                                                                                | shipped                                             |
| HTTP API                                    | `app/api/swarm`, `app/api/trace`, `app/api/tasks/{register,start,abandon,complete}`, `app/api/demo/{reset,launch,activity}` | shipped                                             |
| Cockpit                                     | `app/page.tsx`, `src/features/cockpit/`                                                                                     | shipped, 133 unit + 51 browser tests                |
| Live agent progress                         | `src/features/cockpit/progress.ts`                                                                                          | shipped, 23 passing tests, seen live                |
| The guide                                   | `src/features/cockpit/guide.ts`, `guide-panel.tsx`                                                                          | shipped, 24 passing tests, driven live              |
| The joining guide, four steps off the swarm | `src/features/cockpit/joining.ts`, `joining-panel.tsx`                                                                      | shipped, 24 unit + 7 browser tests                  |
| Human names for tasks and tables            | `src/features/cockpit/naming.ts`, `staleness.ts` (`tableLabel`, `taskLabel`)                                                | shipped, 16 passing tests                           |
| The coordinator's live trace                | `src/server/coordinator/trace.ts`, `trace-buffer.ts`, `app/api/trace`, `trace-panel.tsx`                                    | shipped, 10 tests, seen live                        |
| Grouping the trace into decisions           | `src/features/cockpit/passes.ts`                                                                                            | shipped, 15 unit + 2 browser tests                  |
| The lineage graph                           | `src/features/cockpit/lineage.tsx`, `nodes.tsx`, `graph/positions.ts`, `graph/cascade.ts`, on React Flow and dagre          | shipped, 33 unit + 4 browser tests                  |
| Naming which columns moved                  | `src/server/coordinator/staleness.ts` (`columnChange`); `obsel.stale.columns`                                               | shipped, 9 tests, verified live                     |
| Reading the stale tag back onto the board   | `src/server/datahub/tags.ts`, `timing.ts` (`totals`); the ribbon's write-back cell                                          | shipped, 14 unit + 6 browser tests                  |
| The link into DataHub's own UI              | `src/features/cockpit/datahub-link.ts`, `inspector.tsx`                                                                     | shipped, 8 tests, path read from DataHub's bundle   |
| Demo runner                                 | `src/server/runner/`: `steps.ts`, `launcher.ts`, `preflight.ts`                                                             | shipped, 11 tests on the pure half                  |
| Task registration and traversal in Python   | `agents/graph.py`                                                                                                           | shipped, verified live                              |
| Fingerprinting                              | `agents/fingerprint.py`                                                                                                     | shipped, 7 self-check properties                    |
| Demo shape, jobs and seed data              | `agents/pipeline.py`, `agents/seed_data.py`                                                                                 | shipped                                             |
| Vocabulary setup                            | `agents/setup.py`                                                                                                           | shipped                                             |
| Agent worker                                | `agents/worker.py`                                                                                                          | shipped, 16 self-checks + 6 integration             |
| Demo command line                           | `agents/run.py`                                                                                                             | shipped, 33 self-checks + 8 integration             |
| The Codex session an agent actually is      | `agents/codex_runner.py`                                                                                                    | shipped, 22 self-checks + 1 real agent run          |
| Demo reset                                  | `app/api/demo/reset/route.ts`, `engine.resetSwarm`                                                                          | shipped, 2 integration tests vs a live DataHub      |
| Agent output contract                       | `agents/worker.py` (`canonicalise_numbers`)                                                                                 | shipped, 7 self-check properties                    |
| Sample outputs                              | `examples/`                                                                                                                 | shipped, captured from a real run                   |
| obsel's own MCP server                      | `agents/mcp_server.py` over `agents/mcp_core.py`                                                                            | shipped, 31 self-checks + 14 integration            |
| The agent skill                             | `skills/obsel-collaboration/SKILL.md`                                                                                       | shipped, instructions rather than code              |

## 9. Evidence

What has been verified directly, and what has not.

**Verified:**

- The staleness rules, by 34 deterministic tests in `tests/staleness.test.ts`.
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
  cockpit's guide (reset, re-declare, run, identical re-run, change) with no terminal. Register
  wrote each task's job description onto its DataJob and read it back in 506 ms; `run` took
  112.2 s; the identical re-run reported 0 changed outputs and 0 marks confirmed in 106 ms; the
  rename was called `schema` and marked the same three tasks in 2310 ms. Each button spawned the
  real `agents.run` step through `POST /api/demo/launch`, and as a cross-check that the guide is
  state-derived, the closing `reset` was run from a terminal, and the board tracked it identically.
- **The board naming agents in words, and narrating its own work**, on 2026-07-23 against a live
  DataHub and a signed-in Codex CLI. Driven from the browser: `reset` and `register` wrote each
  task's `obsel.title` and job description onto its DataJob and read both back, so the graph, the
  guide and the trace all name `clean_orders` as "Orders cleaner" from DataHub rather than from a map
  in the frontend; `run` took 142.6 s for four Codex sessions; the rename was called `schema`, marked
  the same three tasks, and **`GET /api/trace` reported each step as it happened**: the swarm read
  (4 tasks), the comparison, the walk ("Daily revenue (1 hop), Revenue report (2 hops), Table docs
  (2 hops)"), one step per confirmed mark, and a close of 3424 ms end to end, matching what the stat
  ribbon showed.
- **The graph rebuilt on React Flow, and the change named rather than hashed**, on 2026-07-23 against
  the same live DataHub and Codex CLI. `reset` → `run` → `change` from the terminal: `run` took
  143.1 s, the rename was called `schema`, and the same three tasks were marked in a measured
  3281 ms. Then confirmed in the browser at 1920 x 990 and 1280 x 800:
  - `GET /api/swarm` returned `columns: {"added":["order_total_usd"],"removed":["order_total"]}` on
    all three marks, including the two at two hops, which never read `clean_orders`.
  - The changed table's node rendered `clean orders / - order_total / + order_total_usd`, which is
    the fact the same node previously rendered as `s f7b62a66`.
  - 9 nodes and 8 edges, of which exactly 6 carried the cascade animation: the path from the changed
    table through both hops. Sampled ten times over four seconds and stable at those counts.
  - The animation reported `playState: "running"` with an unbounded iteration count, and its
    `stroke-dashoffset` advanced between samples, so the cascade is still moving after the run has
    settled rather than having played once.
  - 238 words on the page, zero em dashes, no horizontal scroll, and the whole board inside the
    990 px frame.

  Two defects were found by measuring rather than by looking, and both are recorded in the code that
  fixes them. React Flow drew **zero edges** while the poll handed it a new `nodes` array every
  second, because node measurement never settled and unmeasured endpoints are silently skipped; the
  graph is now rebuilt only when a signature of the swarm changes. And putting the log strip beside
  the graph left it 928 px at a 1280 laptop, which is zoom 0.59 and node labels at **eight pixels**,
  less legible than the 11 px SVG the rebuild replaced; the strip sits under the graph at every
  width, which holds the labels at 10.5 px on a laptop and 15 px at the recording size.

- A second `reset` → `register` → `run` → `change` the same day, from the terminal with `--capture`,
  which produced the current `examples/` set: `run` 124.1 s, the rename called `schema`, the same
  three tasks marked in a measured 745 ms. Its fingerprints came out identical to the previous day's
  capture, which is the column contract and `canonicalise_numbers` doing their job across runs.
- The agent output contract, by the self-check in `agents/worker.py`: `217` and `217.0` reach one
  fingerprint, an id column keeps its integers, and a value that genuinely moved still moves the
  hash. Added after a live run where a single value's spelling broke two demo steps at once.
- **That the tag obsel writes is actually on the entity**, on 2026-07-23 from a reset board: `run`
  140.5 s, `change` called `schema` and marked three tasks in 868 ms, and `GET /api/swarm` then
  reported `urn:li:tag:obsel-stale` on exactly those three and no tag on `clean_orders`. `reset`
  cleared both halves, after which every task reported no tags. This is the first time obsel's board
  could show its DataHub contribution rather than assert it, and the first time the two halves of a
  mark could be seen to agree.

- **The coordinator's own orchestration, the MCP tag path, and the worker's HTTP calls**, by 28
  integration tests in `tests/live/` against a real DataHub, the real
  `uvx mcp-server-datahub==0.6.0` subprocess, and a real obsel server. This closes the gap listed
  here since the first commit. Run with `pnpm test:live`, which needs DataHub up and `uvx` on PATH,
  and which fails loudly rather than skipping when either is missing: a suite that quietly passes for
  a path nothing exercised is the same shape of failure obsel exists to catch.

  The blocker had never been a judgement that this did not matter. `engine.ts`, `client.ts` and
  `mcp.ts` all import `server-only`, which throws unless the bundler resolves under React's
  `react-server` condition, so no test could load them. `vitest.config.ts` aliases that marker to a
  no-op for vitest alone, and Next.js still enforces the real guard at build time.

  **They run against their own DataFlow.** `OBSEL_FLOW_ID` is set in `vitest.live.config.ts` and read
  by both `src/server/datahub/urns.ts` and `agents/pipeline.py`, so the suite registers real DataJobs
  into a real but separate flow and cannot reset the operator's board. That is isolation, not a
  stand-in, and `tests/urns.test.ts` runs the Python module for real to check the two implementations
  still agree on every URN they build.

  Covered: registration writing real `Consumes`, `Produces` and `IsPartOf` edges; a first run and an
  identical re-run each marking nothing, including on an already-flagged board; a real change reaching
  one direct and two transitive tasks at the right distances over `GET /relationships`; the cause
  unmarked and untagged; an unrelated branch untouched; running and never-run tasks both ineligible,
  with the walk stopping at the running one; each mark's reason, cause, distance and column diff as
  DataHub holds them; the real `obsel-stale` tag applied through MCP and read back off `globalTags`;
  a human-authored tag surviving beside it; `run.*` and fingerprints surviving a start; an abandoned
  run reverting to its prior status including `stale` with its tag intact; reset clearing both aspects
  while keeping the lineage; the `==` version pin and the tool inventory; the tag round trip and its
  idempotence in both directions; a rejected unregistered tag URN; and `worker.py`'s in-flight guard,
  including the rule that its marker file decides only whether to ask while obsel decides what is
  true.

  **The suite earned its keep on the first run.** It found a real bug that the in-memory GMS it
  replaced had made structurally invisible: `registerTask` confirmed the entity and stopped, while
  membership is an `IsPartOf` edge in the graph store, which lags the aspect store. Measured at 218 ms
  for the entity and 1302 ms for the edge (§11), so obsel reported a task registered while its own
  snapshot could not yet see it, and a change upstream of a task missing from the snapshot traverses
  straight past it. A stand-in derives its edges from its own entity map, so they are never late and
  this did not exist in it.

- **`agents/worker.py`'s contract and its state on disk**, by 16 self-checks in
  `pnpm test:python`, wired into `pnpm verify` so they actually run. Real files in real temporary
  directories: the canonicalisation properties, a table surviving a save and load byte-stably, a
  missing table naming its path, a file that is not a table being rejected rather than half-read, and
  an instruction remembered together with the columns it produced, the pair whose separation
  reverted a rename live on 2026-07-22.

- **That nothing a live agent writes is taken on trust**, by 22 self-checks over
  `agents/codex_runner.py`. `_validate` is the only thing between a model's output and obsel's
  fingerprint, and every rejection branch is checked against a real file: a table the agent never
  wrote, one that is not JSON, one declaring no columns, one with no rows, a row missing a declared
  column, and columns that do not match the contract, including **the right columns in the wrong
  order**, since the contract is a list and column order moves the content fingerprint. The accepting
  side is checked too: a row carrying an undeclared scratch key is allowed, and the fingerprint proves
  it cannot move, because rows are hashed by declared column.

- **`agents/run.py`'s guards**, by 33 self-checks. The one that matters most is `_required_list`,
  checked against the anti-pattern it exists to avoid: `reply.get(key) or []` turns a reply obsel never
  sent into "nothing was affected". Mutating it to that form fails six of these checks. Also covered:
  every branch of the coordination printout including the singular "1 hop", that an unreported elapsed
  time prints `(unreported)` rather than `None ms`, that `EXPECTED_CASCADE` still describes the
  topology `pipeline.TASKS` declares, and that `reset` against an unreachable obsel deletes nothing
  locally, checked against a port genuinely nothing is listening on, with the local files under a
  temporary root.

- **A real model call**, by `tests/live/codex.live.test.ts`, which runs a genuine Codex session over a
  two-row table and confirms it read its input, wrote its output, and met an exact column contract.
  The subject is the invocation rather than the reasoning: `--sandbox workspace-write` and
  `--skip-git-repo-check` were learned by running the CLI, and no stand-in can say whether today's
  Codex still accepts them. The same file proves a stale output file is removed before the agent
  starts, isolated with a one-second ceiling Codex cannot meet, because a surviving stale table plus
  a run that wrote nothing would validate, fingerprint unchanged, and report a failed run as a
  successful no-change re-run.

- **`worker.py`'s `run_task` as a whole**, by `tests/live/run-task.live.test.ts`: a real agent run
  against a real obsel and a real DataHub, from announcement to confirmed completion. Three ordering
  decisions are checked because each is silent when wrong, and all three were confirmed to fail when
  the behavior is mutated. Inputs load **before** the announcement, so an agent that cannot read its
  upstream table never tells obsel it began, and moving the announcement first fails that test and
  wedges
  every later one at `running`, which is the failure itself. A failed agent hands its announcement
  back, so nothing is left at `running` where the cascade would skip it, and deleting the
  `_abandon_running`
  call fails with `expected 'running' to be 'complete'`. And the hand-back restores what the dead run
  left untouched, so a failure while re-running an already-complete task returns it to `complete`
  rather than erasing the good result. The fingerprint obsel records is also compared against one
  recomputed from the saved file, because canonicalising after the save instead of before would leave
  the record and the bytes permanently out of step; moving that call fails the test.

**Not verified:**

- **An identical re-run through a real agent.** That a re-run producing the same table marks nothing
  is obsel's central rule, and it is covered deterministically in `tests/staleness.test.ts` and against
  a live DataHub in `engine.live.test.ts`. Driving it through two real Codex sessions would test the
  model's determinism rather than obsel's decision, so it is left to the demo's own `rerun-same` step,
  which asserts it and exits non-zero when it fails.
- **`run_task(report=False)`.** Nothing calls it, so no test spends a real agent session on it.
- **The browser suite still uses canned bodies, for the four-task states.** `e2e/` intercepts
  `/api/swarm` to drive the board through states a live run cannot easily produce, notably a failed
  read, and those bodies are invented. Its fixtures say so in their own header. It is the one place
  left in the repository that tests against something invented, and it is named here rather than
  left to be found.

  Narrowed on 2026-07-24, and only narrowed. The forty-task board's two fixtures are recordings of
  real `GET /api/swarm` responses rather than invented ones, because a hand-typed forty-task graph
  would be a hand-typed claim about the layout those tests exist to check. The interception is
  unchanged: what is replayed is real, and it is still replayed, so the server half is still absent
  from every browser test.

- **Anything on a machine other than this one.** Every integration figure is a single observation
  against a Docker quickstart on one laptop.
- **The window between a mark landing and its tag landing.** `markStale` awaits the confirmed property
  write and then `applyStaleTag`, so a marked task genuinely has no tag for a moment, and the ribbon
  counts rather than ticks because of it. Polling the live board every two seconds on 2026-07-23, that
  moment was never caught: the board went from having nothing to write straight to `3 of 3`. So the partial
  count is asserted by a unit test and a browser test against a fixture, and the live evidence says
  only that the window is shorter than two seconds on this machine.

- **The demo has passed once per step, which is not a pass rate.** Codex is a live agent and its
  output has twice proved unstable in ways that made a re-run look like a real change: name casing,
  then numeric serialisation. Both are pinned now and both were caught by the demo's own assertions
  rather than on camera. A third category nobody has hit yet is a live possibility.
- The TypeScript path end to end against a live DataHub **as an automated test**. It has now been
  exercised by a real run (above), but nothing in `pnpm test` stands DataHub up and asserts the
  result, by design, so that `pnpm verify` needs no Docker.
- Whether obsel's marks survive a later re-ingestion.
- **A latency figure that means anything beyond one machine.** Every number quoted above is a single
  observation against a Docker quickstart on one laptop, and the spread across runs is wide: 745 ms,
  1611 ms, 2310 ms, 2591 ms, 3281 ms and 3424 ms for the same cascade, because it is dominated by how
  long DataHub takes to confirm each write rather than by the deciding. `elapsedMs` in
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
- **Anything that repairs stale work itself.** obsel reports which finished work is no longer
  built on something true. Deciding what to do about it is a person's job, or the next agent's.
  The demo's `repair` command does not change this: it is the agents redoing their own work in
  dependency order, with obsel doing exactly what it always does at each completion. The one
  thing the coordinator now derives on its own is the inverse of a mark: when a flagged task's
  redo lands byte-identical, the flags downstream of that output were standing on ground that
  never moved, and `restoredBy` (`src/server/coordinator/staleness.ts`) clears the ones the
  records prove. Nothing can request that clear, since no route and no tool takes a task to
  unflag, which keeps the only path to a clean board through redone work.

## 11. The HTTP API

Eight routes. All of them are `force-dynamic`; nothing here is cached. Six carry obsel's own
protocol; the last two (`/api/demo/launch` and `/api/demo/activity`) belong to the demo runner.
They execute and report the demo's own CLI steps on the machine obsel runs on, exist so the
cockpit's guide can drive the demo without a terminal, and are not part of what an agent
integrating with obsel would ever call.

**One asymmetry to know before you call anything:** `POST /api/tasks/register` takes **short dataset
names** like `clean_orders`, not a URN. Every other route, and every field in every response, uses full
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
// request: SHORT dataset names; description optional, ≤300 chars
{
  "name": "build_revenue",
  "reads": ["clean_orders"],
  "writes": ["daily_revenue"],
  "description": "totals the clean orders into one revenue row per day",
}
```

```jsonc
// 200: a TaskRecord, with the URNs the server built
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

The description is stored as the DataJob's own `dataJobInfo.description`, which is real graph
metadata, so
DataHub's UI shows the same sentence the cockpit does. Reading a task back returns it as
`description`, null when the task registered without one (the placeholder older registrations
carried is filtered out rather than shown as though an agent had said it). Confirmed live
2026-07-22: registered through this route, read back off GMS at
`/openapi/v3/entity/datajob/<urn>` with the sentence on the entity, in a measured 506 ms for all
four tasks.

The route fails rather than returning if DataHub stored a different number of inputs or outputs than
were sent, because a rejected aspect pair can be dropped without failing the write.

### `POST /api/tasks/start`

Move a task to `running`. Work in flight is never marked stale, and its recorded fingerprints are
deliberately left in place as the baseline this run will be compared against.

```jsonc
// request: a full DataJob URN
{ "taskUrn": "urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),build_revenue)" }
```

Returns `200` with the updated `TaskRecord`. Starting a task that is already `running` is a 500.

The server stamps `startedAt` here, on its own clock, and clears any `run` detail left by the
previous run. The cockpit subtracts `startedAt` from `SwarmSnapshot.at` to say how long work in
flight has been in flight, and both timestamps come from this process, so the difference is an interval
rather than two machines disagreeing about the time.

**Agents call this before doing their work, not after.** That is what lets the board show an agent
working while it is working; it also means a run that dies owes the announcement back, which is what
`POST /api/tasks/abandon` is for.

### `POST /api/tasks/abandon`

Put a task that announced a start back to `registered`, because the run behind it failed.

```jsonc
// request: a full DataJob URN
{ "taskUrn": "urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),clean_orders)" }
```

```jsonc
// 200: reverted is false when the task was not running, which is not an error
{ "task": { "…": "a TaskRecord, back at registered" }, "reverted": true }
```

Recorded fingerprints survive: they are the baseline the eventual successful run is compared
against, and dropping them would make that run read as a first run and mark nothing.

This route exists because obsel excludes `running` work from the cascade, correctly, since work in
flight picks up the new input itself. A task abandoned at `running` would therefore be skipped by
every later traversal while the board still showed a healthy swarm, which is a false negative.

### `POST /api/tasks/complete`

The one that matters. An agent reporting that it finished is what triggers the whole cascade.

```jsonc
// request: full URNs throughout; the fingerprint map is keyed by DATASET urn
{
  "taskUrn": "urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),clean_orders)",
  "fingerprints": {
    "urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.clean_orders,PROD)": {
      "schema": "f7b62a66…",
      "content": "f521e9dd…",
    },
  },
  "finishedAt": "2026-07-21T14:02:39.905Z",
  // Optional. Display only: obsel decides nothing on it, and an agent that
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
// 200: a CoordinationResult
{
  "taskUrn": "urn:li:dataJob:(…,clean_orders)",
  "changedOutputs": [
    { "dataset": "urn:li:dataset:(…,obsel_demo.clean_orders,PROD)", "kind": "schema" },
  ],
  "affected": [{ "task": { "…": "a TaskRecord as it was found" }, "mark": { "…": "a StaleMark" } }],
  "restored": [{ "task": { "…": "a TaskRecord as it was found" }, "reason": "a sentence" }],
  "elapsedMs": 118,
}
```

`changedOutputs` empty means the fingerprints matched the previous run: nothing changed, so
`affected` is empty too. That is the quiet case, and it is the one the loud case depends on.
`elapsedMs` is measured across the whole call including the writes. Each `mark.detectedMs` carries
the same measurement, written onto the mark in DataHub.

`restored` is the inverse of `affected`, and non-empty only on one specific completion: the
reporting task was itself flagged, it redid its work, and an output came back byte-identical to
the recorded baseline. The flags downstream of that output were then standing on ground that never
moved, and `restoredBy` (`staleness.ts`) clears the ones the records prove: producer settled, no
standing reader observation, the mark not naming that very table, and the producer's previous
report predating the reader's finish. Each clear removes the properties and the DataHub tag, and
carries a reason like a mark does. It cannot be requested: the field exists only as a consequence
of redone work.

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
  "datahubUrl": "http://localhost:9002",
}
```

`tasks` is sorted by URN, so the board's row order does not depend on registration order. `ready`
and `blocked` are derived by `staleness.ts` from the same snapshot rather than computed separately.

Each task carries `tags` and `staleTagged`, read off `globalTags`, see section 2. Both are absent on
a capture taken before they existed, which the board renders as `not recorded` rather than as zero.

`datahubUrl` is `DATAHUB_FRONTEND_URL` from the server's environment, with any trailing slash
stripped, and `null` when it is unset, in which case the cockpit offers no link rather than one that
looks live and goes nowhere. It sits on the envelope and deliberately **not** inside `snapshot`: the
snapshot is a domain value the coordinator writes and [`examples/`](../examples) captures as a record
of what DataHub held, and a browser base URL is neither, so it would outlive its meaning the moment a
capture were read on another machine.

Port 9002 is DataHub's frontend proxy. `DATAHUB_GMS_URL` is not a substitute: 8080 answers the API and
serves no entity pages.

### `POST /api/demo/reset`

Put the swarm back to its pre-run state for a second demo take. Any request body is ignored.

It clears two separate things, and that is the whole reason it exists: the `obsel.*` properties on
`dataJobInfo`, and the `urn:li:tag:obsel-stale` tag on `globalTags`. Those are different aspects, so
re-registering the tasks clears the properties and leaves the tags in place, and DataHub's UI would
then show a stale tag from the previous take on a task obsel calls registered.

It deliberately does not delete the tasks. Their lineage edges are what the demo re-runs against.

```jsonc
// 200: names, not URNs, because a human reads this one
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

Run one demo step on this machine, the same `agents/.venv/bin/python -m agents.run <step>` the
README documents, spawned verbatim with no shell and no interpolation: the step name is a Zod enum
of the seven commands, and nothing else from the request reaches the spawn. Answers immediately;
progress is read from `/api/demo/activity` and from the swarm itself.

One step at a time, enforced server-side with a 409, because the steps share the demo's tables, so a
`change` racing a `run` would corrupt both. A missing `agents/.venv` is also a 409, carrying the
exact commands that create it.

This route executes local processes by design. obsel's demo is a local tool on the machine that
owns the Codex login; nothing in this repository exposes it beyond localhost, and hosting was
explicitly decided against.

```jsonc
// request
{ "step": "run" } // "setup" | "register" | "run" | "rerun-same" | "change" | "repair" | "reset"
```

```jsonc
// 200
{ "ok": true, "running": { "step": "run", "startedAt": "2026-07-22T…" } }
```

```jsonc
// 409: refused, with the fix when there is one
{ "error": "run is already running. One step at a time, they share the same tables", "fix": null }
```

### `GET /api/demo/activity`

What the demo runner is doing right now: the running step, how the last one ended, the step's own
stdout/stderr tail (bounded to the newest 500 lines), and whether this machine's prerequisites
hold. The cockpit polls it every two seconds beside `/api/swarm`. Task state itself is never in
here. That lives in DataHub and comes back through the swarm read.

Each preflight check is a genuine observation carrying the exact fix command when it fails:
DataHub's `/config` answering, `agents/.venv` present, `codex login status` exiting 0 (cached ten
seconds so polling does not spawn it constantly), and `urn:li:tag:obsel-stale` existing, checked
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
    "durationMs": 61958, // start to exit, on one clock, the server's
  },
  "log": ["$ agents/.venv/bin/python -m agents.run rerun-same", "…"],
  "preflight": {
    // Two probes behind one verdict: `/config` separates "not running" from
    // "running and cannot answer", then the traversal `readSnapshot` opens with,
    // because GMS keeps serving `/config` with its search index gone. See
    // `docs/environment-findings.md` section 12.
    "datahub": {
      "ok": true,
      "detail": "DataHub answered at http://localhost:8080, and obsel could read the swarm from it.",
      "fix": null,
    },
    "vocabulary": { "ok": true, "detail": "urn:li:tag:obsel-stale is registered", "fix": null },
    "venv": { "ok": true, "detail": "agents/.venv exists", "fix": null },
    "codex": { "ok": false, "detail": "the Codex CLI is not signed in", "fix": "codex login" },
  },
  // The command that connects an outside MCP agent to this obsel, with this
  // machine's real absolute interpreter path. Display only; the board's
  // "bring your own agent" panel renders it, because a placeholder path would
  // hand the reader a command that fails.
  "joinCommand": "claude mcp add obsel -- /…/agents/.venv/bin/python -m agents.mcp_server",
}
```

### `GET /api/trace`

The steps the coordinator took, in the order it took them, for the "what obsel is doing" panel.
Oldest first. The cockpit polls it every second, faster than the activity feed, because a whole
cascade arrives in one burst and a two-second poll would show it already finished.

Emitted by `engine.ts` as it works: the swarm read, one step per fingerprint comparison **whichever
way it goes**, the lineage walk with what it found, one step per mark once that mark's writes are
confirmed, one step per restoration clear carrying its full reason (a cleared task keeps no mark to
carry it, so the trace and the reply are the only places the reason lives), and a closing step
carrying the measured end-to-end figure. Tables and tasks are named the way the stale reasons name
them, through `tableLabel` and `taskLabel` in `staleness.ts`, so one task is never called two
different things on one screen.

Reads nothing from DataHub, so it answers even when GMS is unreachable, which is deliberate: a
panel explaining what obsel is doing is most useful when something is wrong.

**Narration, not a decision path, and a view rather than a record**: bounded to the newest 200
steps, in memory, process-local, gone on restart. Section 12 sets out what this panel may and may not
claim, and why the buffer is deliberately something nothing else depends on.

Steps are written at log length rather than as sentences, and the panel renders only the newest
eight. Both are deliberate. The route still returns the full tail, so nothing is dropped from what
callers can read; what is bounded is how much of the board a 21-step run is allowed to occupy.

```jsonc
// 200
{
  "events": [
    {
      "seq": 42, // monotonic; survives a reset, so a fresh step is never mistaken for one already seen
      "at": "2026-07-23T01:52:53.514Z",
      "phase": "compare", // read | compare | walk | mark | write | done
      "message": "compared clean orders", // log length, not a sentence
      "outcome": "columns changed, values did not", // null when the step has nothing to report
    },
  ],
}
```

## 12. What the cockpit's two side panels may and may not say

Both sit in the strip under the lineage graph, and neither carries a demo beat.

Before them, one thing about the graph panel itself. Its heading is **what obsel is for**, "Each agent
reads a table another agent wrote, so a change in one can make another's finished work wrong", and
that is the only place on the board that states obsel's purpose. It reached that slot by replacing
"how the work connects", a caption explaining how to read a picture whose boxes carry names and whose
arrows show direction, so the statement cost an already-spent line rather than new prose. Two earlier
attempts at the same job were prose, a header tagline and then paragraphs above the graph, and both
were removed as part of cutting the board from 604 words; `guide.ts` was left holding a
`WHAT_OBSEL_IS` constant that nothing read, which is now deleted.

A third attempt sat here until 2026-07-23, and it is worth recording why it was replaced, because it
passed every check the repository had. It was a question, "is this finished work still built on
something that is still true?". Nothing measurable was wrong with it: it was short, it was in the
right slot, it was present in every state, and an e2e test asserted all three. It names nothing. Not
an agent, not a table, not a change. It reads well to a reader who already knows what obsel does,
which is the one reader who does not need a statement of purpose. The heading now names the actors,
and the e2e assertion is on those nouns rather than on the sentence, so the next rewrite cannot
compress them back out.

A question rather than a claim, because the graph beneath it is the answer: the amber path is what
"no longer true" looks like. It also fixes obsel's scope by what it does not ask. Not whether the work
is good, not whether the pipeline is healthy, not whether anything should be re-run.
`e2e/cockpit.spec.ts` asserts it is present in the flagged, settled and empty states, because a purpose
that appears only once something has gone wrong is not a statement of purpose.

**The inspector** shows one task's uncompressed values: full URNs, complete 64-character
fingerprints, and every field of its stale mark. It computes nothing. In particular it never derives
an age or a freshness, because the cockpit knows when it _read_ a value rather than when it became
true,
and an inspector is exactly the place that distinction gets quietly lost. It is mounted only while a
task is selected, which is now done by clicking a box on the graph. The strip's height is fixed, so
it appears without moving the graph or the stat ribbon; it borrows its room from the trace beside it
and gives it back on close.

Since 2026-07-23 it is also where the ledger's content went. The ledger rendered all four tasks as
cards carrying a status word, a human name, a code identifier, a job sentence, a reason sentence, a
timestamp and a line of runner metadata: 311 px and 205 words describing the same four tasks the
graph above already drew. Every one of those facts is here instead, including the mark's `reason`,
which is still stored on the mark, still written into DataHub, and still shown verbatim rather than
summarised. `e2e/cockpit.spec.ts` asserts it opens in full and is neither clipped nor ellipsised, so
the rule that a mark carries a traceable cause is unaffected by the move.

**The trace** is titled "what obsel is doing", and it replaced a panel that diffed two `GET
/api/swarm` bodies polled a second apart. That difference is the whole point of this section, so the
old panel's limits are worth stating: a diff could establish that a field differed from the previous
read and nothing else. It had not watched obsel read the lineage graph, compare a fingerprint, walk
the cascade, or poll DataHub until a write was confirmed, because none of that reached the browser.

It also had a sharper hazard, an **asserted absence**. `coordinateCompletion` writes the finishing
task's new fingerprints and its `complete` status _before_ it writes any stale mark, so there is a
window at least one poll wide in which a diff can truthfully observe "a new output was recorded, and
nothing was marked" while the cascade that is about to mark three tasks is still in flight. That
observation is true and the obvious sentence for it is a lie. The old panel therefore carried a
standing rule that no event may assert an absence.

The trace does not need that rule, and understanding why is the point. Its steps are emitted by
`coordinateCompletion` itself, in the order it performs them, so a step saying "Nothing was marked"
is not an inference drawn from a quiet screen a poll after the fact. It is the coordinator reporting
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

Each step is emitted **after** the thing it describes has happened, so a mark's step is emitted once
`updateTaskProperties` and the tag write have been confirmed by bounded polling, not when the write
was issued. So the panel is always describing completed work, and can never show an intent that
subsequently failed.

### Grouped by decision, because that is what the steps are

The steps are a flat list and the work is not. Measured on a live board after one `run` and one
`change`, the 25 steps held were five separate pieces of coordination:

```
write write | read compare done | read compare done | read compare done
            | read compare done | read compare walk mark mark mark done
```

One judgement per agent completion, four of which found nothing to do, and the board rendered all 25
as undifferentiated lines. That flattened the thing the demo's second half exists to establish: four
_separate_ judgements that stayed quiet are what make the fifth believable, and undivided they read as
one long preamble in which nothing happened.

`src/features/cockpit/passes.ts` groups them, purely and with its own tests. `read` is the boundary,
which is not a convention it imposes: `coordinateCompletion` cannot decide anything before
`readSnapshot`, so every pass begins with one. The `read` step's own message is already the trigger,
"Orders cleaner finished", so it becomes the group's **heading** rather than its first row. A heading
carrying the pass's _conclusion_ instead would print "marked 3 out of date" directly above the step
that says exactly that.

Headings are `sticky`, so the heading of the pass a reader is scrolling through stays in view instead
of leaving its steps belonging to nothing. Measured: scrolled 60px into the tallest group, a heading
holds 3px from the top edge.

A leading run of steps with no `read` gets no heading. The buffer is a bounded tail, so its oldest
steps can be the middle of a pass whose `read` has already been dropped; those steps are shown, and
what they do not get is a heading presenting a fragment as a whole decision.

### The panel used to promise steps it did not hold

It rendered only the most recent eight, which was defensible at 220px tall and stopped being so once
the panel grew. Measured at 1920 x 990 before the fix: the scroller was 307px, a row 45px, eight rows
were in the DOM and **six** were fully visible, with the first cut off entirely and a third of the
second gone. The header meanwhile read `last 8 of 25`, naming 17 steps that were not in the DOM at
all, so scrolling up reached the top of the eight and stopped.

It renders the whole trace now. That is still bounded, by `trace-buffer.ts` at 200 steps. The header
reads `5 decisions, 25 steps` and every step it counts is rendered, so the count is one a reader can
act on. After the change, 11 rows are fully visible and the top edge shows a 2px sliver of the
previous group rather than most of a sentence.

One consequence for the board's word-count guard, which is worth naming because getting it wrong
would invert the guard's purpose: `e2e/cockpit.spec.ts` counts the log's **visible** steps, not its
DOM text. Counting all of it would make the ceiling track how much obsel narrated rather than how
dense the board is, and the way to pass a failure would be to narrate less. A separate assertion
holds the line directly: tripling the trace must not increase what is on screen.
