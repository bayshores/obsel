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

![The obsel cockpit with three agents flagged. The changed table shows order_total leaving and
order_total_usd arriving; an amber path runs outward from it through two hops to Revenue report and
Table docs; and the ribbon reports a measured detection time of 3636 ms beside three of three marks
tagged in DataHub.](docs/images/flagged.png)

_The flagged board, captured 2026-07-23 from commit `a485b95` against a live DataHub and a live Codex
CLI. Not a mockup, and not assembled: `run` took 2 m 30 s for four real Codex sessions, then one
agent's instructions changed, and every number here came out of that run. **The wording on screen is
older than the app.** Both images predate the plain-English pass described under Status, so the
headline, the key and the button lines below the graph read differently now. Everything the images
are evidence of, the cascade, the column diff, the measured time and the confirmed tags, is
unchanged; they are recaptured before the video._

![The same cockpit minutes earlier: four agent boxes all showing done, the heading reporting that all
four finished and nothing is out of date, and the write-back cell reporting that there is nothing to
write.](docs/images/settled.png)

_The same board minutes earlier in the same run, before anything changed. The contrast is the whole
product: obsel is quiet until something is genuinely wrong, and an identical re-run keeps it quiet._

---

## Any agent can join, not just the four in this repo

obsel speaks MCP in both directions. It is a **client** of DataHub's MCP server, which is how the
`obsel-stale` tag gets written. It also **serves** its own, so any MCP-capable agent (Claude Code,
Cursor, Codex) can join a swarm:

| Tool                                              | What an agent uses it for                               |
| ------------------------------------------------- | ------------------------------------------------------- |
| `check_freshness(reads)`                          | before working: are my inputs still trustworthy?        |
| `register_task(name, reads, writes, title?, ...)` | declare what I read and write, once                     |
| `announce_start(taskUrn)`                         | before writing, so in-flight work is never marked       |
| `report_complete(taskUrn, outputs, runner?, ms?)` | what I produced; obsel answers with what it invalidated |
| `abandon_task(taskUrn)`                           | hand the announcement back after a failure              |
| `read_board()`                                    | who else is in the swarm and what state they are in     |

**Agents never compute a fingerprint.** `report_complete` takes the real rows and columns and hashes
them on obsel's side, through the same path its own workers use. There is no tool that accepts a
hash, because an agent that could hand obsel a hash could hand it the _previous_ hash and be
believed. There is also no tool that marks or clears staleness: the way to clear a mark is to redo
the work and report it.

Point an agent at it (from the repository root, with obsel running):

```bash
claude mcp add obsel -- "$PWD/agents/.venv/bin/python" -m agents.mcp_server
```

`skills/obsel-collaboration/SKILL.md` teaches an agent the order that makes obsel's answers mean
something: check freshness first, register once, announce before writing, report even when nothing
changed. Copy it into `.claude/skills/` to install it.

The whole path is covered by [`tests/live/obsel-mcp.live.test.ts`](tests/live/obsel-mcp.live.test.ts)
— a real MCP client, over real stdio, into the real Python server, against a real obsel and a real
DataHub.

---

## Status

**The whole loop is built, and the whole demo now runs from the browser.** The cockpit carries a
guide that reads the live state once a second and offers the next real action as a button — set up
the four agents, start them, run one again unchanged, change one agent's instructions. Each button
launches the same `agents.run` step the terminal path runs, verbatim, and the step's own printed
output streams onto the board. On 2026-07-22 the full journey — reset → re-declare → run →
identical re-run → change — was driven end to end **with five clicks and no terminal**, against a
live DataHub with a live Codex CLI, every step exiting 0.

Several things were rebuilt on 2026-07-23, all for the same reason: a stranger looking at the board
could not tell what it was.

- **Every sentence on screen is written for someone who has not read this file.** Two earlier passes
  had the same goal and did not hold, because the only guard on the copy was a word count and an
  identifier is short: `venv: the agents' Python environment (agents/.venv) does not exist yet` scores
  better on a word count than a sentence that explains itself. So the rule is written into
  `guide.ts`'s header and a check enforces the half a machine can see. **No internal name reaches the
  board**: not the `DemoStep` ids the launcher takes, not the keys of the preflight record, not an
  exit code, not a URN outside the details panel and the step log. It was run against the previous
  copy first and failed on six leaks across four states, which is how it is known to work. What went
  with them: "if obsel flags anything, it cried wolf", "now try to break it", "work in flight is never
  judged, only finished work can go stale", "every number is withheld until a read succeeds". Each
  reads well to somebody who already knows what obsel does.
- **The setup screen is a checklist, not a list of complaints.** It showed only the checks that were
  failing, each prefixed with its key in the preflight record: `venv:`, `codex:`, `vocabulary:`. Three
  opaque labels, no ordering, no way to tell whether that was the first problem of one or the last of
  four. All four are listed now, in the order they have to be done, with the passing ones ticked, and
  the fix command still verbatim and copyable. The data is unchanged: `preflight` always carried all
  four, and only the passing half was being thrown away.
- **The key says which box is which.** It glossed three colours whose words are already printed on
  every node ("done", "out of date", "running"), and called green "still true" while the node beside
  it said "done": two vocabularies for one colour, on one screen. Nothing anywhere said which box was
  an agent and which was a table, so the graph's whole premise rested on a distinction the reader had
  to already know. The key names the two shapes now, and the shapes are genuinely different: an agent
  is a bordered box with a status bar, a table is an unbordered lighter chip. They used to differ by
  `--mm-ink-2` against `--mm-surface`, which is 2.5% cream over a near-black background, a difference
  the CSS asserted was enough "without needing a label to say so" and which nobody can see.

- **Agents and tables are named in words.** Every agent registers a human name and a one-sentence
  job as real DataHub metadata, `obsel.title` and the DataJob's description, and the board reads them
  back, so `clean_orders` appears as "Orders cleaner" everywhere, including in the reason written
  onto a stale mark. Nothing is mapped in the frontend; a pipeline that registers no title still
  reads as words, via a fallback.
- **The change is named, not hashed.** The demo renames a column, and the board used to render that
  fact as `s f7b62a66`: obsel's real evidence, and unreadable. The changed table now shows
  `- order_total` and `+ order_total_usd`, and the headline reads "clean orders lost order_total and
  gained order_total_usd after they finished". It says lost and gained rather than renamed, because a
  column leaving while another arrives cannot be told apart from a drop plus an unrelated addition,
  and obsel reports what it observed. Staleness is still decided by comparing sha256 fingerprints and
  by nothing else; the column list is a description of a change already detected, derived from
  `obsel.run.outputs`, which obsel already recorded.
- **The graph is a real graph library, and it moves.** It was about 800 lines of hand-written SVG:
  bezier control points, a collision test for edges crossing boxes, hand-rolled arrowheads. It is
  React Flow with a dagre layout now. The cascade edges animate continuously while the marks stand,
  where the old one drew once over 400 ms and then held still, so a screenshot of a finished cascade
  had nothing in it to say a change had travelled.
- **obsel narrates its own work, grouped into the decisions it made.** A strip under the graph shows
  the steps the coordinator took as it takes them: the swarm read, each fingerprint comparison and its
  verdict, the lineage walk and what it found, one line per mark once DataHub has confirmed the write,
  and a measured close. A `run` followed by a `change` is **five separate judgements**, four of which
  found nothing to do, and the strip used to render all 25 steps as one undifferentiated stream. Each
  pass is now headed by the completion that triggered it, so those four quiet judgements read as four
  decisions rather than a preamble, which matters because they are what make the fifth believable. It
  is narration, not a decision path: nothing reads it back, and it is not the record. The record is the
  marks in DataHub.
- **The board says what obsel is for.** It never did, which was the complaint underneath ten rounds
  of feedback. Both previous attempts were prose, a tagline in the header and then paragraphs above
  the graph, and both got deleted for the reason they should have been: they are how the screen reached
  604 words. The graph's heading carries it instead, in the slot that used to hold "how the work
  connects", a caption explaining how to read a picture whose boxes are already named and whose arrows
  already show direction. It reads "Each agent reads a table another agent wrote, so a change in one
  can make another's finished work wrong", and it states obsel's limits as much as its scope: not
  whether the work is good, not whether the pipeline is healthy, just whether it is still built on
  something still true.
- **The board says far less.** The flagged screen was 604 words in two stacked panels of prose, with
  nothing on it set larger than 13 px, so there was no entry point and the only way in was to read
  all of it. It is 267 words now, one headline leads, and the graph carries the mechanism. Nothing
  was deleted from the system: every reason, fingerprint, timing and code identifier is one click
  away on a node. Three checks in the suite hold the line, because ten rounds of hand-edited copy is
  what produced the 604 in the first place: a word ceiling on the flagged board, an assertion that no
  em dash reaches the screen in any state, and the identifier guard described next.
- **What obsel wrote into DataHub is on the board, and counted.** obsel tags each marked job
  `urn:li:tag:obsel-stale` through the MCP server, which is the thing a person browsing DataHub sees
  without knowing obsel exists, and the board used to mention it in five grey words at the bottom of a
  scroller. obsel now reads `globalTags` back off the entity it was already fetching, so the ribbon
  reports `3 of 3 tagged` and the details panel lists every tag on the job and links to its real
  DataHub page. It is a check rather than a badge, and the states are distinguished on purpose: a
  count that reads low is a write still in flight, since obsel writes the mark before the tag and
  DataHub's writes are asynchronous; a tag with no mark never resolves and is reported separately as
  `left over`; and a snapshot with no tag information says `not recorded` rather than zero, because
  claiming DataHub is missing tags obsel never looked for would understate obsel's own contribution.
  Neither field enters a staleness decision, which is still `compareFingerprints` on sha256 alone.
- **The reason lineage is needed is stated in words.** Two of the three flagged agents never read the
  changed table, which is the whole argument for walking a lineage graph rather than watching a file,
  and it was on screen only as `· 2 hops`. The subline now reads "clean orders lost order_total and
  gained order_total_usd after they finished, and 2 of the 3 never read it". The count comes from each
  task's `reads`, not from its hop count, because "never read it" is a claim about what a task
  consumes and the two can disagree.

The guide is a lens, not a script: it derives its stage from what DataHub actually holds, so
driving a step from the terminal instead moves the board the same way, and nothing on screen is
staged or pre-recorded.

Updated 2026-07-23. Everything described below this section is code that exists in this repository
and type-checks, not a plan.

### Built

| Piece                                                                           | Where                                                                      |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| A task is a `DataJob` with real lineage edges                                   | `agents/graph.py`, `src/server/datahub/urns.ts`                            |
| Output fingerprinting, schema and content separately                            | `agents/fingerprint.py`                                                    |
| The staleness rules, pure and testable                                          | `src/server/coordinator/staleness.ts`                                      |
| Marks written back into DataHub                                                 | `src/server/coordinator/engine.ts`, `src/server/datahub/mcp.ts`            |
| Four demo agent workers, each a real Codex session                              | `agents/worker.py`, `agents/run.py`                                        |
| The agent output contract, names and number form                                | `agents/worker.py` — `canonicalise_numbers`, with a self-check             |
| The cockpit — graph, headline, stats, step log, details                         | `app/page.tsx`, `src/features/cockpit/`                                    |
| Live agent progress on the board                                                | `src/features/cockpit/progress.ts`                                         |
| The guide — stage derived from live state, buttons that launch the real steps   | `src/features/cockpit/guide.ts`, `guide-panel.tsx`                         |
| The demo runner — spawns `agents.run` steps, checks the machine's prerequisites | `src/server/runner/`                                                       |
| Each task's job, stored on its DataJob in DataHub and read back onto the board  | `agents/pipeline.py`, `src/server/datahub/client.ts`                       |
| The stale tag read back off the entity, and counted on the board                | `src/server/datahub/tags.ts`, `src/features/cockpit/timing.ts`             |
| A link from any task to its real page in DataHub's UI                           | `src/features/cockpit/datahub-link.ts`, `inspector.tsx`                    |
| HTTP API, eight routes including launch and activity                            | `app/api/` — see [`docs/architecture.md`](docs/architecture.md) section 11 |

### Verify these claims yourself

Every claim below is one command away. Nothing here is a summary of a summary — each row names the
file that would fail if the claim were false.

| Claim                                                                                  | Run this                           | Where it lives                                                      |
| -------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------- |
| An identical re-run marks nothing. False alarms are the failure mode designed against. | `pnpm test`                        | `tests/staleness.test.ts` (about half its tests assert no action)   |
| ...and it still marks nothing through a real DataHub, and through the MCP path         | `pnpm test:live`                   | `engine.live.test.ts`, `obsel-mcp.live.test.ts`                     |
| A change reaches work that never read the table that changed                           | `pnpm test:live`                   | `obsel-mcp.live.test.ts` asserts hops 1 and 2, each with its reason |
| Work in flight is never marked                                                         | `pnpm test`                        | `tests/staleness.test.ts`                                           |
| The `obsel-stale` tag really lands in DataHub, confirmed by reading it back            | `pnpm test:live`                   | `mcp.live.test.ts`, `obsel-mcp.live.test.ts`                        |
| The same number written `217` and `217.0` is not treated as a change                   | `python3 -m agents.worker`         | and again through the MCP path in `agents/mcp_core.py`              |
| A reply obsel never sent is refused, not read as "nothing was affected"                | `python3 -m agents.run self-check` | mutating the guard fails six checks; five more in `mcp_core.py`     |
| Any MCP agent can join and drive a real cascade, and an unreachable obsel is named     | `pnpm test:live`                   | `obsel-mcp.live.test.ts` (a real client, a dead port, and the GMS)  |
| TypeScript and Python build byte-identical URNs                                        | `pnpm test`                        | `tests/urns.test.ts` runs the Python module for real                |

`pnpm verify` needs no Docker. `pnpm test:live` needs DataHub up, plus `uvx` and `codex` on PATH.

### Verified directly

- **The staleness rules**, by 24 deterministic tests in `tests/staleness.test.ts`. About half assert
  that nothing happens, which is deliberate — the failure that kills this kind of tool is a false
  alarm, not a miss. An identical re-run marks nothing, an unrelated branch is untouched, a running
  task is neither marked nor walked through, a cycle terminates.
- **The cockpit's own logic**, by 157 further tests across `tests/cockpit-*.test.ts`. The load-bearing
  ones: graph geometry is byte-identical across every task status, so nothing moves on the frame
  three tasks flip amber; no label can overflow its box, checked against measured per-character
  advances; a six-task pipeline the layout has never seen draws correctly; amber fills a node if and
  only if its status is `stale`; and no measurement is ever displayed that the coordinator did not
  record. The geometry assertions were confirmed to fail by reintroducing the status-dependent
  sizing they exist to forbid.
- **The coordinator, both MCP surfaces, the worker's HTTP calls, the demo command line and a whole
  agent run, against the real thing**, by 58
  integration tests in `tests/live/` — a live DataHub, the real `uvx mcp-server-datahub==0.6.0`
  subprocess, and a real obsel server. `pnpm test:live`. This closes what `hackathon.md` had called the
  repository's most honest weakness since the first commit, and the reason it stood so long is worth
  naming: `engine.ts`, `client.ts` and `mcp.ts` all import `server-only`, which throws unless the
  bundler resolves under React's `react-server` condition, so **no test could load them at all**.

  **Nothing is stood in for.** There was an in-memory DataHub for exactly one commit, and it was
  deleted rather than kept: it encoded a propagation delay attributed to a finding that says something
  else, and its tests agreed with the mistake, because a stand-in can only assert what its author
  already believed. The suite runs against its own real DataFlow via `OBSEL_FLOW_ID`, so it cannot
  reset the board you have open, and `tests/urns.test.ts` runs the Python module for real to check both
  languages still build identical URNs.

  **It found a real bug on its first run** — one the stand-in had made structurally invisible.
  `registerTask` confirmed the task's entity and stopped there, but swarm membership is an `IsPartOf`
  edge in DataHub's graph store, and that lags the aspect store: measured at 218 ms for the entity and
  **1302 ms** for the edge. So obsel reported a task registered while its own snapshot could not yet
  see it, and a change upstream of a task missing from the snapshot traverses straight past it,
  silently. Registration now confirms the edge too. A stand-in derives its edges from its own entity
  map, so they are never late and this could not exist in one.

- **The Python agents, by 109 self-checks** in `pnpm test:python`, now wired into `pnpm verify` so they
  actually run rather than sitting unrun. All over real files in real temporary directories. `worker.py`
  contributes 16, including the instruction remembered together with the columns it produced, the pair
  whose separation reverted a rename live. `codex_runner.py` contributes 22 over `_validate`, the only
  thing between a live model's output and obsel's fingerprint: a table the agent never wrote, one that
  is not JSON, one with no rows, a row missing a declared column, and the right columns in the wrong
  order are each refused, because a plausible-looking bad table hashes cleanly and would mark the whole
  chain stale for nothing. `run.py` contributes 33 over the guards behind its printed claims, the
  sharpest being that `_required_list` refuses a missing key rather than reading it as an empty list:
  mutating it to `reply.get(key) or []` fails six of them. `mcp_core.py` contributes 31 over what
  obsel's own MCP server decides before it speaks: the same refusal of a missing key (the same
  mutation fails five of these), an output the task never declared it writes, a table with no
  registered producer reported as exactly that rather than as fresh, and `217` and `217.0` reaching
  one fingerprint while `218` still moves it.

- **One real Codex session**, in `tests/live/codex.live.test.ts` — the only automated model call in the
  repository. The subject is the invocation, not the reasoning: `--sandbox workspace-write` and
  `--skip-git-repo-check` were learned by running the CLI, both fail silently in the way that matters,
  and no stand-in can say whether today's Codex still accepts them. The agent reads a real file, writes
  a real table, and meets an exact column contract.

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
- **The board naming its agents in words, and narrating its own work**, on 2026-07-23 against a live
  DataHub and a signed-in Codex CLI, driven from the browser. `reset` and `register` wrote each
  task's `obsel.title` and job description onto its DataJob and read both back, so every panel named
  `clean_orders` as "Orders cleaner" from DataHub rather than from anything hard-coded. `run` took
  **142.6 s** for four Codex sessions. The upstream rename was called **`schema`** and marked the
  same three tasks, and `GET /api/trace` reported each step as it happened: the swarm read (4 tasks),
  the comparison — _"its columns changed; the values did not"_ — the walk, _"Daily revenue (1 hop),
  Revenue report (2 hops), Table docs (2 hops)"_, one line per confirmed mark, and a close of
  **3424 ms** end to end. That figure matched what the stat ribbon showed at the same moment. A
  second sequence the same day, from the terminal with `--capture`, produced the current `examples/`
  set: `run` **124.1 s**, the same three tasks marked in a measured **745 ms**, and fingerprints
  identical to the previous day's capture, the column contract holding across runs.
- **The rebuilt board, measured rather than eyeballed**, on 2026-07-23 against the same live DataHub
  and Codex CLI. `run` took **143.1 s**; the rename was called **`schema`** and marked the same three
  tasks in a measured **3281 ms**. `GET /api/swarm` returned
  `columns: {"added":["order_total_usd"],"removed":["order_total"]}` on all three marks, including
  the two at two hops that never read `clean_orders`, and the changed node rendered
  `clean orders / - order_total / + order_total_usd`. In the browser at 1920 x 990: 9 nodes, 8 edges,
  exactly **6 of them animated** (the cascade path), stable across ten samples over four seconds,
  with the animation reporting an unbounded iteration count and a `stroke-dashoffset` still advancing
  between samples. **238 words** on the page, **zero em dashes**, no horizontal scroll, whole board
  inside the frame. Three defects were caught by measuring rather than looking, none of which was
  visible in a screenshot of a freshly loaded page: React Flow drew **zero edges** while the poll
  replaced its node array every second; the log strip beside the graph squeezed node labels to
  **8 px** on a 1280 laptop; and `fitView`, which runs once on mount, left the graph framed against
  a stale panel size, so after a resize all nine nodes sat outside a panel that clips its overflow.
  All three are fixed, each is written up in the code that fixes it, and the last is now asserted in
  `e2e/cockpit.spec.ts` across a resize.
- **The write-back, read back off DataHub**, on 2026-07-23 against the same live stack. From a reset
  board: `run` took **140.5 s** for four Codex sessions, then `change` was called **`schema`** and
  marked three tasks in a measured **868 ms**. `GET /api/swarm` reported
  `tags: ["urn:li:tag:obsel-stale"]` on exactly those three and `tags: []` on `clean_orders`, which is
  the cause rather than a casualty, so the ribbon read **`3 of 3 tagged`** beside the detection time.
  Clicking a flagged node showed the tag and a link resolving to
  `http://localhost:9002/tasks/urn:li:dataJob:(...,build_revenue)`. `POST /api/demo/reset` then
  reported clearing properties on all four and the tag from all three, after which every task read
  `tags: []` and the cell read **`nothing marked`** with nothing left over. The board measured
  **251 words**, 96 of them prose, **zero em dashes**, whole board inside 990 px with no scroll.
  **Not observed live:** the moment between the mark landing and the tag landing. Polling every two
  seconds, the board went straight from nothing marked to `3 of 3`, so the asynchronous window is
  shorter than that in practice. The partial count is covered by a unit test and a browser test
  against a fixture, not by a live sighting, and the ribbon is worded as a count for exactly that
  reason.
- **One flaw found by reading the rendered board rather than the code.** The ribbon lowercases its
  labels, which was fine until a label carried DataHub's name: the cell crediting DataHub rendered as
  "written into datahub". `StatCell` now takes `preserveCase`, used only there.
- **The whole demo, driven from the browser alone**, on 2026-07-22 against a live DataHub and a
  signed-in Codex CLI — five clicks in the guide, no terminal: reset, then re-declare (which
  wrote each task's job description onto its DataJob and read it back onto the board in a
  measured **506 ms**), then `run` — four Codex sessions in **112.2 s**, watched live as
  "in flight for N s" — then the identical re-run, which obsel answered with **0 changed outputs
  and 0 marks, confirmed in 106 ms**, then the upstream rename, which obsel called **`schema`**
  and answered by marking exactly `build_revenue` (1 hop), `write_docs` and `write_report`
  (2 hops each) in a measured **2310 ms**. Every step exited 0 with its own assertions passing,
  and the board followed each transition within a poll. As a cross-check that the guide derives
  from state rather than following a script, the final `reset` was run from a terminal instead —
  the board tracked it identically.
- **The whole demo, end to end, from the terminal**, earlier on 2026-07-22 against the same live
  DataHub and Codex CLI. `reset` → `run` → `rerun-same` → `change`, exit 0, every assertion
  passing:

  - `run` — four Codex sessions in **134.0 s**, then `GET /api/swarm` read back to confirm 4 of 4
    complete with no marks. obsel held no previous fingerprint for any output, so it correctly
    marked nothing.
  - `rerun-same` — `clean_orders` re-ran, produced a byte-identical table, and obsel reported
    **0 changed outputs and 0 marks**, confirmed in **60 ms**. This is the negative case the whole
    product rests on: a tool that flags the pipeline on every scheduled re-run is a tool people mute.
  - `change` — one column renamed, `order_total` → `order_total_usd`. obsel called it **`schema`,
    not `both`** — the values did not move, only the name — and marked exactly `build_revenue`
    (1 hop), `write_docs` and `write_report` (2 hops each), in a measured **2591 ms**, each with its
    reason. The last two never read `clean_orders`; they were reached through `daily_revenue`.

  Four earlier runs of `run` measured 135.9 s, 119.4 s, 152.0 s and 134.0 s on the same machine.

- **The board showing an agent while it works.** During the second run the cockpit reported
  `clean_orders` as `in flight for 12.7 s`, then 20.7 s on a later poll, and after it finished
  `codex-cli 0.144.4 · 43.9 s · 39 rows · order_id, customer, order_total, order_date` — the same
  figures the terminal printed. Before this, obsel was told an agent had started only after its work
  was already over, so the board said "waiting" throughout.
- **The MCP write path**, by round trip: apply the tag, confirm it through GraphQL, remove it,
  confirm removal.
- **The existence predicate and swarm enumeration**, by curl against the live instance —
  see [`docs/environment-findings.md`](docs/environment-findings.md) sections 1 and 9.

### Not done

- **The demo has passed a handful of times, not repeatedly.** Six full clean sequences across
  2026-07-22 and 2026-07-23 — four from the terminal, two from the browser — on one machine. That is
  not a pass rate. Codex is a live agent and its output is not guaranteed identical between runs — see the
  next point for the one instance of that already found and fixed, and expect the possibility of
  others in categories nobody has hit yet.
- **Codex's output needed pinning down twice, and may need it again.** Two separate instabilities
  have shown up in live runs, both of which made a re-run look like a real change: customer-name
  casing (fixed by pinning the instruction, see `agents/pipeline.py`) and numeric serialisation —
  `order_id` 1012's money value written `217` on three runs and `217.0` on a fourth, which broke
  `rerun-same` and made `change` report `both` instead of `schema`. The second is now handled by
  `canonicalise_numbers` in `agents/worker.py`, which fixes the serialised form per column before
  anything is hashed. Both were caught by the demo's own assertions rather than seen on camera,
  which is the property worth keeping. obsel itself called every one of those runs correctly.
- **An identical re-run is not driven through two real agents.** Everything that used to sit here is
  closed: `agents/run.py`, `agents/codex_runner.py` and `worker.py`'s `run_task` are all now covered,
  the last of them by a real agent run against a real obsel from announcement to confirmed completion.
  What is deliberately not tested that way is obsel's central rule, that a re-run producing the same
  table marks nothing. It is covered deterministically in `tests/staleness.test.ts` and against a live
  DataHub in `engine.live.test.ts`; running it through two real Codex sessions would be testing the
  model's determinism rather than obsel's decision. The demo's own `rerun-same` step asserts it on
  real runs and exits non-zero when it fails, which is how both agent instabilities above were found.
  The demo runner in `src/server/runner/` is still tested on its pure half only.
- **The detection latency numbers are single observations, not a benchmark.** Each cascade run has
  produced one measured figure — 6867 ms on 2026-07-21; 2591 ms and 2310 ms on separate runs on
  2026-07-22; 3424 ms, 1611 ms, 745 ms and 3281 ms on 2026-07-23 — and the spread is dominated by how long the bounded
  polling waits for each DataHub write to be confirmed, not by the deciding. The separate 92 ms
  figure is the Python traversal alone.
- **The live trace is narration, not evidence.** It is emitted by the coordinator as it works and has
  been watched during a real cascade, but nothing reads it back, it is bounded to the newest 200
  steps, and it does not survive a restart. Anything it says is corroborated by the marks in DataHub
  or it is not corroborated at all.
- **The word ceiling is a guard, not a design proof.** `e2e/cockpit.spec.ts` fails the build if the
  flagged board goes past 110 words of prose or 260 words in total, which stops the density that
  prompted this rebuild from creeping back. It cannot tell whether what remains is the right 238
  words, and no test can.
- **The graph has only been laid out for one pipeline shape.** dagre handles arbitrary DAGs and the
  unit suite exercises a six-task fan-out and a cycle, but every visual check has been of the same
  four-task demo. A swarm with many more parallel branches would be taller than the strip reserved
  for it, and nothing yet says what should give.
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

The short version — the app guides you through the rest:

```bash
datahub docker quickstart        # first run pulls images, takes a few minutes
cp .env.example .env.local
pnpm install && pnpm dev
```

Then open `http://localhost:3000`. **The board opens on a checklist**, because the three commands
above are not the whole of it: the demo agents need their own Python environment and a signed-in
Codex CLI, and obsel needs its tag registered in DataHub. Each item is genuinely checked on your
machine every couple of seconds, the ones already done are ticked, and anything missing shows the
exact command to run. Work down the list and it empties.

Once it does, the whole demo is buttons: set up the four agents, put them to work, re-run one
identically, change a requirement upstream, reset. Each button runs the same `agents.run` command
listed in step 8 below, verbatim, and streams that step's own output onto the board.

### Every step, spelled out

The same setup as eight explicit steps, for when something fails or you prefer the terminal. Each
one has a way to tell whether it worked, because several of them fail quietly. The demo agents in
`agents/` need their own Python environment — they are not installed by `pnpm install`.

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

**5. Install `uv`.** obsel writes its `obsel-stale` tag through DataHub's own MCP server, which is
run with `uvx`. Without this the staleness engine still decides correctly and the tag write is the
step that fails, so it is worth having before the first run rather than after it.

```bash
brew install uv                  # or: curl -LsSf https://astral.sh/uv/install.sh | sh
uvx --version                    # should print a version
```

**6. Start obsel.**

```bash
pnpm dev        # http://localhost:3000 should show the cockpit, not an error
```

**7. Register obsel's vocabulary in DataHub.** Run every agent command from the repository root, so
`agents` imports as a package.

```bash
agents/.venv/bin/python -m agents.run setup
```

This creates `urn:li:tag:obsel-stale` and the demo DataFlow. It is not optional: obsel cannot create
a tag at run time, so without this step staleness is detected and silently not recorded. The command
fails loudly if either did not land.

**8. Run the demo** — from the guide's buttons, or as the same commands:

```bash
agents/.venv/bin/python -m agents.run register      # four tasks into DataHub, each with its job
agents/.venv/bin/python -m agents.run run           # four agents finish, nothing stale
agents/.venv/bin/python -m agents.run rerun-same    # re-run produces the same table, marks nothing
agents/.venv/bin/python -m agents.run change        # renames a column, three tasks go stale
agents/.venv/bin/python -m agents.run reset         # back to the starting state
```

[`agents/README.md`](agents/README.md) explains what each command should print. The board follows
either path identically, because the guide derives everything from what DataHub holds.

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
app/                     routing and composition (Next.js), and the nine HTTP routes
src/features/cockpit/    the cockpit: lineage.tsx and nodes.tsx (React Flow), graph/positions.ts
                         (dagre) and graph/cascade.ts, tone.ts, timing.ts, naming.ts, progress.ts,
                         guide.ts (pure), then the pixels
src/server/coordinator/  types.ts, staleness.ts (pure rules), engine.ts (the IO half),
                         trace-buffer.ts (pure) and trace.ts (the one instance)
src/server/datahub/      client.ts (GMS HTTP), mcp.ts (tag writes), urns.ts (URN shapes)
src/server/runner/       the demo runner: steps.ts (pure), launcher.ts (spawn), preflight.ts
src/server/domain/       reserved for deterministic logic; currently empty
agents/                  the four demo agent workers, fingerprinting, the demo runner, and
                         obsel's own MCP server (mcp_server.py over pure mcp_core.py)
skills/                  the agent skill: how to work in a swarm obsel is watching
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
pnpm verify      # format, lint, typecheck, test, test:python, build
pnpm test        # pure logic only, no Docker
pnpm test:live   # integration; NEEDS DataHub up, and uvx and codex on PATH
pnpm e2e         # browser checks; builds and serves the app itself
```

**What each one needs, and what it is worth.**

`pnpm verify` is the one this README asks a judge to run, so it must stay free of Docker, DataHub and
a browser download. Everything in it is pure: functions taking data and returning data, with nothing
stood in for because nothing needs to be. It also runs the Python self-checks, which use real files
in real temporary directories.

`pnpm test:live` is where anything crossing a process boundary is covered, and it is covered against
the real thing — a live DataHub, the real `uvx mcp-server-datahub==0.6.0` subprocess, a real obsel
server that the suite starts itself, and a real `codex exec` session. It refuses to skip when any of
them is missing, because a green run for a path nothing exercised is the same shape of failure obsel
exists to catch. It writes into its own real DataFlow, so it cannot disturb the board you have open.
It builds first, because it serves the app with `next start` and a suite testing a stale build would
be worse than no suite. Budget about 155 s: the two real agent sessions are most of it.

`pnpm e2e` is the one place left that tests against something invented: it intercepts
`GET /api/swarm` with canned bodies to drive the board through states a live run cannot easily
produce, notably a failed read. So it verifies the cockpit's rendering of a snapshot, not that obsel
produces the right snapshot — the live suite covers that half. Its fixtures say so in their own
header.

Checked 2026-07-23: `pnpm verify` succeeds end to end — `pnpm format:check`, `pnpm lint`,
`pnpm typecheck`, `pnpm test` (232 passed), `pnpm test:python` (109 properties across five modules),
and `pnpm build`. `pnpm test:live` passes 58 integration tests across seven files in about 120 s, of
which one is a real Codex session. `pnpm e2e` passes 71
browser checks across both viewports, with one skipped by design — a recording-frame assertion that
does not apply at laptop height.

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
