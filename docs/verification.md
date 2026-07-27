# What is built, what is proven, and what is not

The full record behind the summary in [`README.md`](../README.md). It lives here rather than in the
README so the README can stay short, and because this is the part that gets read carefully rather
than skimmed: every number below came out of a run someone watched.

Two rules govern it. A figure is written down only if it was measured, and anything that has not
been established is in [Not done](#not-done) rather than left out.

---

## What is built

**The whole loop is built, and the whole demo now runs from the browser.** The cockpit carries a
guide that reads the live state once a second and offers the next real action as a button: set up
the demo agents, start them, run one again unchanged, or change one agent's instructions. Each button
launches the same `agents.run` step the terminal path runs, verbatim, and the step's own printed
output streams onto the board. On 2026-07-22 the full journey (reset → re-declare → run →
identical re-run → change) was driven end to end **with five clicks and no terminal**, against a
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

**Added 2026-07-24: the loop closes.** Three things shipped together, because each is what makes
the others mean something.

- **A flag is now something you act on.** The flagged board leads with **Redo the work obsel
  flagged**, a new `repair` demo step: the flagged agents re-run in dependency order, real Codex
  sessions replaying what each task last ran, and every flag comes off through a redo. There is
  still no way to clear a flag directly, anywhere, and that is the point of the wording on the
  button.
- **Restoration: an identical redo clears what it proves.** The semantics change this required was
  approved by the owner on 2026-07-24. When a _flagged_ task redoes its work and an output comes
  back byte-identical, the tasks downstream of that output were flagged for ground that never
  moved, and the engine clears them itself: properties nulled, the DataHub tag removed, a reason
  recorded in the trace and in the completion reply's new `restored` list. The rule is one pure
  function, `restoredBy` in `staleness.ts`, and it prefers a kept flag to a wrong clear: the
  producer must be settled, no reader observation may be standing, the mark must not name that very
  table, and the producer's previous report must predate the reader's finish. Nothing can request
  it. No route and no MCP tool takes a task to clear.
- **The joining panel.** A panel under the graph carrying a four-step checklist that ticks itself
  off from the swarm as a visiting agent declares, announces, reports and gets an answer, plus the
  `claude mcp add obsel …` command with this machine's real absolute path (served by the activity
  route, because a placeholder path is a command that fails), the six MCP tools with what each is
  for, and the two things a visiting agent deliberately cannot do. The copy button falls back to
  selecting the command when the clipboard API refuses, which an embedded webview does. It was a
  closed 17px disclosure until 2026-07-24; the entry further down records why that was a defect.

Updated 2026-07-24. Everything described below this section is code that exists in this repository
and type-checks, not a plan.

### Where each piece lives

| Piece                                                                          | Where                                                                    |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| A task is a `DataJob` with real lineage edges                                  | `agents/graph.py`, `src/server/datahub/urns.ts`                          |
| Output fingerprinting, schema and content separately                           | `agents/fingerprint.py`                                                  |
| The staleness rules, pure and testable                                         | `src/server/coordinator/staleness.ts`                                    |
| Marks written back into DataHub                                                | `src/server/coordinator/engine.ts`, `src/server/datahub/mcp.ts`          |
| Four demo agent workers, each a real Codex session                             | `agents/worker.py`, `agents/run.py`                                      |
| The agent output contract, names and number form                               | `agents/worker.py` (`canonicalise_numbers`), with a self-check           |
| The cockpit: graph, headline, stats, step log, details                         | `app/page.tsx`, `src/features/cockpit/`                                  |
| Live agent progress on the board                                               | `src/features/cockpit/progress.ts`                                       |
| The guide: stage derived from live state, buttons that launch the real steps   | `src/features/cockpit/guide.ts`, `guide-panel.tsx`                       |
| The demo runner: spawns `agents.run` steps, checks the machine's prerequisites | `src/server/runner/`                                                     |
| Each task's job, stored on its DataJob in DataHub and read back onto the board | `agents/pipeline.py`, `src/server/datahub/client.ts`                     |
| The stale tag read back off the entity, and counted on the board               | `src/server/datahub/tags.ts`, `src/features/cockpit/timing.ts`           |
| A link from any task to its real page in DataHub's UI                          | `src/features/cockpit/datahub-link.ts`, `inspector.tsx`                  |
| The restoration rule: which flags an identical redo provably clears            | `restoredBy` in `src/server/coordinator/staleness.ts`                    |
| The repair loop: flagged work redone in order, restored work skipped           | `cmd_repair` in `agents/run.py`, the guide's leading flagged action      |
| The joining panel and its four derived steps                                   | `joining.ts`, `joining-panel.tsx`, `joinCommand` on `/api/demo/activity` |
| Registering your own task from the board, wired into DataHub                   | `mine.ts`, `mine-panel.tsx`, over the agents' own `/api/tasks/register`  |
| The two animated captures and the script that takes them                       | `docs/images/*.gif`, `record.mjs`                                        |
| HTTP API, thirteen routes in three groups                                      | `app/api/`, see [`docs/architecture.md`](architecture.md) section 11     |

**Added 2026-07-23, the reader-side cross-check.** obsel's trigger is an agent reporting, so a
process that rewrites a shared table and never reports was invisible, and the silence read as "all
clear". Three things shipped against that, together:

- **A completion may carry what the task read**, hashed the same way as what it wrote. The demo
  worker sends these automatically (the tables were already in memory); an outside agent passes
  `inputs` to `report_complete`. The engine compares each observation against what that dataset's
  producer recorded writing; a mismatch marks every finished task built on the old version, with
  `causedByTask` null because the author is unknown and a reason that says the change was never
  reported. The first observation is recorded on the producer so a second identical read compares
  clean instead of re-flagging. Proven against the real DataHub in `tests/live/engine.live.test.ts`
  ("a change nothing reported is caught by the next honest read", three tests), and over the real
  MCP wire in `tests/live/obsel-mcp.live.test.ts`.
- **A table can be reported as a path to its real file**, `{"path": "data/clean_orders.json"}`, and
  the MCP server reads and hashes the file itself. This exists because a model pasting hundreds of
  rows into a tool call will eventually truncate or paraphrase one, the content hash moves, and
  obsel reports a change nobody made. A missing file, non-JSON bytes, a non-table shape and an
  ambiguous path-plus-rows value are each refused with the path in the message, and every one is
  exercised against a real file or a real absence in `agents/mcp_core.py`'s self-checks and live over stdio.
- **The quiet claim is bounded.** The board says "none of the tables they read has changed since,
  as of the last report at 17:42:07", because that timestamp is the edge of obsel's knowledge, and
  an unbounded all-clear claims more than it can know.

Also that day: **table boxes on the graph open a details view** (who writes it, who reads it,
columns, row count, the file's location as the writer reported it, both hashes), which is the
answer to a reader who cannot tell what "table" refers to. The writer's file location travels as a
display-only `path` on the run detail; nothing decides on it.

## Verified directly

- **The staleness rules**, by 65 deterministic tests in `tests/staleness.test.ts`. About half assert
  that nothing happens, which is deliberate, because the failure that kills this kind of tool is a
  false alarm rather than a miss. An identical re-run marks nothing, an unrelated branch is untouched,
  a running
  task is neither marked nor walked through, a cycle terminates. The reader-observed change carries
  no author at any hop, and a reported change still names its producer.
- **The straddling-reader rules, added 2026-07-24 for the concurrent swarm**, by 11 of those 65,
  over `classifyObservation` and `supersededMark`. A task that read a table, kept working while the
  producer re-reported it, and then finished used to be the worst of both worlds: itself unflagged
  (the cascade excludes the reporter) while a false "nothing reported this change" alarm re-marked
  other tasks with a wrong author. Now an observation matching the version a re-report replaced
  marks the finishing task itself, producer named; matching the version a noticed silent edit
  replaced marks it with the author unknown; matching what stands is clean; matching nothing is
  still the unreported path. **Every guard was pinned by breaking it**: four mutations, each
  deleting or reordering one rule, each failed at least one named test, and the restored file
  passed all 72. The engine half (keeping `obsel.fingerprints.previous`, writing the mark) is
  exercised live once the concurrent runner lands; see Not done.
- **The restoration rule, negative cases first**, by 16 of those 72. For `restoredBy` the dangerous
  wrong answer inverts: a false clear declares broken work sound, so the refusals lead, and an
  identical re-run by _unflagged_ work restores nothing (the rerun-same trap, twice, once at the
  gate and once as an ordinary completion), a direct reader of the changed table never clears, a
  second still-flagged producer holds, a changed redo restores nothing, running work and an
  unrelated flagged branch are untouched, a standing reader observation refuses, a missing finish
  time refuses rather than guessing the order, and a cycle terminates. **Every guard was pinned by
  breaking it**: six mutations, each deleting one guard, each failed at least one test, and the
  restored file passed all 72. The positives: the demo shape clears exactly two, a three-deep chain
  clears transitively through the fixpoint, and an input nothing in the swarm produces counts as
  stable ground.
- **The cockpit's own logic**, by 192 further tests across `tests/cockpit-*.test.ts`. The load-bearing
  ones: graph geometry is byte-identical across every task status, so nothing moves on the frame
  three tasks flip amber; no label can overflow its box, checked against measured per-character
  advances; a six-task pipeline the layout has never seen draws correctly; amber fills a node if and
  only if its status is `stale`; and no measurement is ever displayed that the coordinator did not
  record. The geometry assertions were confirmed to fail by reintroducing the status-dependent
  sizing they exist to forbid.
- **The coordinator, both MCP surfaces, the worker's HTTP calls, the demo command line and a whole
  agent run, against the real thing**, by 58
  integration tests in `tests/live/` against a live DataHub, the real `uvx mcp-server-datahub==0.6.0`
  subprocess, and a real obsel server. `pnpm test:live`. This closes what was for a long time the
  repository's most honest weakness, and the reason it stood so long is worth naming: `engine.ts`,
  `client.ts` and `mcp.ts` all import `server-only`, which throws unless the
  bundler resolves under React's `react-server` condition, so **no test could load them at all**.

  **Nothing is stood in for.** There was an in-memory DataHub for exactly one commit, and it was
  deleted rather than kept: it encoded a propagation delay attributed to a finding that says something
  else, and its tests agreed with the mistake, because a stand-in can only assert what its author
  already believed. The suite runs against its own real DataFlow via `OBSEL_FLOW_ID`, so it cannot
  reset the board you have open, and `tests/urns.test.ts` runs the Python module for real to check both
  languages still build identical URNs.

  **It found a real bug on its first run**, one the stand-in had made structurally invisible.
  `registerTask` confirmed the task's entity and stopped there, but swarm membership is an `IsPartOf`
  edge in DataHub's graph store, and that lags the aspect store: measured at 218 ms for the entity and
  **1302 ms** for the edge. So obsel reported a task registered while its own snapshot could not yet
  see it, and a change upstream of a task missing from the snapshot traverses straight past it,
  silently. Registration now confirms the edge too. A stand-in derives its edges from its own entity
  map, so they are never late and this could not exist in one.

- **The Python agents, by 125 self-checks** in `pnpm test:python`, now wired into `pnpm verify` so they
  actually run rather than sitting unrun. All over real files in real temporary directories. `worker.py`
  contributes 17, including the instruction remembered together with the columns it produced, the pair
  whose separation reverted a rename live. `codex_runner.py` contributes 22 over `_validate`, the only
  thing between a live model's output and obsel's fingerprint: a table the agent never wrote, one that
  is not JSON, one with no rows, a row missing a declared column, and the right columns in the wrong
  order are each refused, because a plausible-looking bad table hashes cleanly and would mark the whole
  chain stale for nothing. `run.py` contributes 38 over the guards behind its printed claims, the
  sharpest being that `_required_list` refuses a missing key rather than reading it as an empty list:
  mutating it to `reply.get(key) or []` fails six of them; the newest cover the repair's redo order
  and the refusal to read a reply that lost its `restored` key as "nothing was cleared".
  `mcp_core.py` contributes 41 over what
  obsel's own MCP server decides before it speaks: the same refusal of a missing key (the same
  mutation fails five of these), an output the task never declared it writes, a table with no
  registered producer reported as exactly that rather than as fresh, `217` and `217.0` reaching
  one fingerprint while `218` still moves it, and the summary of an identical redo carrying its
  cleared flags beside the quiet line.

- **One real Codex session**, in `tests/live/codex.live.test.ts`, the only automated model call in the
  repository. The subject is the invocation, not the reasoning: `--sandbox workspace-write` and
  `--skip-git-repo-check` were learned by running the CLI, both fail silently in the way that matters,
  and no stand-in can say whether today's Codex still accepts them. The agent reads a real file, writes
  a real table, and meets an exact column contract.

- **Restoration against the real DataHub**, added to `engine.live.test.ts` on 2026-07-24: from a
  flagged board with four marks standing, one deterministic identical redo of the middle task
  cleared exactly the two transitive marks, held the direct reader of the changed table with its
  tag still on (read back off `globalTags`, not inferred), left the cleared tasks' fingerprints and
  finish times untouched, and carried the reason on each entry. The changed-redo negative runs
  beside it: a redo landing a different table restores nothing and cascades instead, fresh marks
  naming the redone table. The identical re-run on a flagged board now also asserts
  `restored: []`, the trap where restoration would be catastrophically wrong, held live. Over the
  MCP wire, `obsel-mcp.live.test.ts` drives the same shape through a real client on real stdio:
  the reply's `restored` names the two-hop task, the summary carries
  `cleared mcpjoin_report without a re-run`, and both flags and both tags are confirmed off in
  DataHub itself.
- **The repair, live, both ways it can go.** Two full `repair` runs against the live DataHub with
  live Codex sessions on 2026-07-24, and they took the two different paths that exist:
  - **The first found a third agent instability.** The redone `daily_revenue` carried averages at
    full float precision (`104.48666666666666`) where the previous run had rounded, so its content
    hash moved, obsel correctly called it a change and refused to clear anything, marked the two
    downstream tasks with the redone table as cause, and the repair's pass loop redid all three:
    `redid 3 of the 3 flagged task(s) in 93.7 s`, exit 0, board clean. obsel was right at every
    step; the averaging precision is now pinned in `pipeline.py`, the third instruction pinned for
    the same class of reason.
  - **The second, after the pin, is the money moment.** One Codex session redid `build_revenue`
    over the renamed table, the output came back byte-identical, and obsel cleared the other two
    itself, each with its reason: `redid 1 of the 3 flagged task(s) in 30.0 s`,
    `obsel cleared 2 without a re-run: write_docs, write_report`, restoration confirmed end to end
    in a measured 1035 ms, the step exiting 0 in 30.2 s. Both runs' closing claims were read back
    from the board, not assumed from the loop ending.
- **The two animated captures**, `docs/images/cascade.gif` and `docs/images/repair.gif`, recorded
  2026-07-24 in one sequence by `record.mjs`: the real launch route, the live board, the moment
  decided from swarm reads rather than pixels. The cascade's ribbon landed at 2444 ms detection
  with `3 of 3 tagged`; the repair GIF holds the strip's two `cleared` lines with their reasons.
  The `change` and `repair` steps behind them exited 0 in 49.9 s and 30.2 s.
- **The cascade, end to end against a live DataHub** on 2026-07-21. A schema-only change posted to
  `POST /api/tasks/complete`, with content byte-identical and schema moved, marked exactly
  `build_revenue` (1 hop), `write_report` and `write_docs` (2 hops), each with its reason, in a
  measured **6867 ms** including the bounded-poll confirmation of every DataHub write. Re-posting
  the identical fingerprint returned `changedOutputs: []`, marked nothing new, and left all three
  existing marks untouched.
- **The lineage assumption**, against a live DataHub (GMS `v1.5.0.6`, quickstart) on 2026-07-21. A
  `DataJob` registered with `Consumes`/`Produces` edges is returned when walking downstream from a
  dataset it reads, and the cascade is transitive. The full walk was measured at 92 ms. That
  measurement is of [`agents/graph.py`](../agents/graph.py), the Python traversal, not the end-to-end
  path.
- **The board naming its agents in words, and narrating its own work**, on 2026-07-23 against a live
  DataHub and a signed-in Codex CLI, driven from the browser. `reset` and `register` wrote each
  task's `obsel.title` and job description onto its DataJob and read both back, so every panel named
  `clean_orders` as "Orders cleaner" from DataHub rather than from anything hard-coded. `run` took
  **142.6 s** for four Codex sessions. The upstream rename was called **`schema`** and marked the
  same three tasks, and `GET /api/trace` reported each step as it happened: the swarm read (4 tasks),
  the comparison, _"its columns changed; the values did not"_, then the walk, _"Daily revenue (1 hop),
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
  `tags: []` and the cell reported **nothing to write** with nothing left over. The board measured
  **251 words**, 96 of them prose, **zero em dashes**, whole board inside 990 px with no scroll.
  **Not observed live:** the moment between the mark landing and the tag landing. Polling every two
  seconds, the board went straight from having nothing to write to `3 of 3`, so the asynchronous window is
  shorter than that in practice. The partial count is covered by a unit test and a browser test
  against a fixture, not by a live sighting, and the ribbon is worded as a count for exactly that
  reason.
- **One flaw found by reading the rendered board rather than the code.** The ribbon lowercases its
  labels, which was fine until a label carried DataHub's name: the cell crediting DataHub rendered as
  "written into datahub". `StatCell` now takes `preserveCase`, used only there.
- **The whole demo, driven from the browser alone**, on 2026-07-22 against a live DataHub and a
  signed-in Codex CLI, in five clicks in the guide with no terminal: reset, then re-declare (which
  wrote each task's job description onto its DataJob and read it back onto the board in a
  measured **506 ms**), then `run`, four Codex sessions in **112.2 s**, watched live as
  "in flight for N s", then the identical re-run, which obsel answered with **0 changed outputs
  and 0 marks, confirmed in 106 ms**, then the upstream rename, which obsel called **`schema`**
  and answered by marking exactly `build_revenue` (1 hop), `write_docs` and `write_report`
  (2 hops each) in a measured **2310 ms**. Every step exited 0 with its own assertions passing,
  and the board followed each transition within a poll. As a cross-check that the guide derives
  from state rather than following a script, the final `reset` was run from a terminal instead,
  and the board tracked it identically.
- **The whole demo, end to end, from the terminal**, earlier on 2026-07-22 against the same live
  DataHub and Codex CLI. `reset` → `run` → `rerun-same` → `change`, exit 0, every assertion
  passing:

  - `run`, four Codex sessions in **134.0 s**, then `GET /api/swarm` read back to confirm 4 of 4
    complete with no marks. obsel held no previous fingerprint for any output, so it correctly
    marked nothing.
  - `rerun-same`, where `clean_orders` re-ran, produced a byte-identical table, and obsel reported
    **0 changed outputs and 0 marks**, confirmed in **60 ms**. This is the negative case the whole
    product rests on: a tool that flags the pipeline on every scheduled re-run is a tool people mute.
  - `change`, where one column was renamed, `order_total` → `order_total_usd`. obsel called it
    **`schema`, not `both`**, because the values did not move and only the name did, and it marked
    exactly `build_revenue` (1 hop), `write_docs` and `write_report` (2 hops each), in a measured **2591 ms**, each with its
    reason. The last two never read `clean_orders`; they were reached through `daily_revenue`.

  Four earlier runs of `run` measured 135.9 s, 119.4 s, 152.0 s and 134.0 s on the same machine.

- **The board showing an agent while it works.** During the second run the cockpit reported
  `clean_orders` as `in flight for 12.7 s`, then 20.7 s on a later poll, and after it finished
  `codex-cli 0.144.4 · 43.9 s · 39 rows · order_id, customer, order_total, order_date`, which were the
  same figures the terminal printed. Before this, obsel was told an agent had started only after its
  work was already over, so the board said "waiting" throughout.
- **The MCP write path**, by round trip: apply the tag, confirm it through GraphQL, remove it,
  confirm removal.
- **The existence predicate and swarm enumeration**, by curl against the live instance.
  See [`docs/environment-findings.md`](environment-findings.md) sections 1 and 9.

- **`readSnapshot` now reads the whole swarm in one `batchGet`, adopted 2026-07-24.** The
  2026-07-23 entry here recorded the per-task version's linear request count as a risk and the
  batch endpoint as researched but not worth adopting before a submission. The forty-task swarm
  changed that arithmetic: the board polls every second, and forty tasks would have put ~41
  requests per second on DataHub to render a screen. The endpoint adopted is the one already
  verified safe (`POST /openapi/v3/entity/datajob/batchGet` carries every aspect obsel reads and
  omits an invented URN rather than fabricating one, re-confirmed against this instance with a
  real and an invented URN before the switch). A URN the graph lists that the batch does not
  return is still an error, never a silent skip. Measured 2026-07-24 with the forty-task flow
  registered, five samples during a live concurrent run: 197, 274, 65, 65 and 54 ms, the first
  two including route warm-up. One `/relationships` call plus one `batchGet` per snapshot,
  regardless of swarm size, against the previous one-per-task.

- **The forty-task swarm, live, the whole loop, on 2026-07-24.** One sequence against a live
  DataHub with a live Codex CLI, on an isolated flow, every closing claim read back from the board
  rather than assumed from the loop ending. Three measured results:
  - **The concurrent run.** 41 real Codex sessions (the forty tasks plus the mid-run change)
    finished in **252.6 s** wall clock at a measured peak of 8 running at once, scheduled by
    `agents/swarm.py` with producers always before readers. The tables are one week of real NYC
    yellow-taxi trips, from the pinned extract in `agents/seeds/`.
  - **The change, landing mid-swarm.** `daily_trips` re-ran with its passenger column renamed
    while **9 agents were still in flight**. obsel marked exactly **8 of 40** finished tasks in a
    measured **13,349 ms**, five direct readers and three transitive, each with its reason, and
    none of the nine in-flight agents was touched. The 31 tasks outside the change's descendants
    ended complete and unflagged, including `report_city`, which finished after the cascade on
    inputs whose bytes had not moved and was correctly left alone. The step exited 0 with every
    assertion passing.
  - **The parallel repair.** From the 8-flag board, `scale-repair` redid the five direct readers
    concurrently and cancelled the other three out of its own plan as proofs landed:
    `weekday_profile`'s identical redo cleared `rider_overview` and `report_riders`,
    `fare_summary`'s cleared `revenue_overview`, each cancellation printed with obsel's reason.
    `docs_marts`'s redo correctly came back different, since its prose documents the renamed
    column, and being a leaf it cascaded to nothing. **Redid 5 of 8 in a measured 42.4 s** against about
    188 s to redo all eight, that baseline estimated from each task's last measured run and
    labeled as an estimate everywhere it appears. The board ended with zero flags, read back from
    DataHub.

- **A second full cycle on the same board, and three rules confirmed by accident, 2026-07-24.**
  Run while recording the browser fixtures, which is why it is here: these are observations from
  work with another purpose, not a benchmark set up to produce them.
  - **An identical re-run at forty tasks marked nothing.** `scale-change` was run against a board
    already carrying the rename. The agent produced a byte-identical table, obsel reported zero
    changed outputs and **zero marks across all 40**, and the producer's recorded previous
    fingerprint stayed at the version before the rename rather than collapsing to equal the
    current one. That is the documented behaviour of both rules, seen at scale without being
    arranged.
  - **The cascade is direction-agnostic.** Re-running the same task with its ORIGINAL instruction,
    putting `riders` back, is as much a schema change as the rename was: obsel marked **the same
    nine tasks at the same hops** (five at one, three at two, one at three) in a measured
    **6391 ms**. Nothing in the engine knows which direction is the demo's.
  - **The parallel repair, a second time, on nine flags.** **Redid 8 of 9 in a measured 62.0 s**
    against about 221 s to redo all nine, estimated from each task's last measured run.
    `rider_overview`'s redo came back identical and took `report_riders` off the plan without it
    running, obsel's reason printed as the proof landed. Two of the eight redos came back
    different and cascaded to nothing, both being leaves. Every flag came off through a redo or a
    proof.
  - **The forward change, a second time.** `daily_trips` renamed the column on a settled board:
    **9 of 40 marked out to 3 hops in a measured 3968 ms**, 30 tasks outside it and none flagged,
    all nine tags confirmed in DataHub. This is the run the browser fixtures were recorded from.

- **`scale-change` now renames whichever way the board sits, proven live in both directions,
  2026-07-24.** The step used to be one hard-coded direction, and a repair never touches the task
  that causes the cascade, so pressing the settled board's own button a second time in a session
  reproduced the table byte for byte and the step failed its own descendant assertion; obsel was
  right every time and the demo was wrong, observed three times. The step now reads the producer's
  recorded run columns off the board and renames away from wherever they sit
  (`scale.change_for`), with the choice printed in words before the agent runs. Five new
  self-checks pin the chooser and the mirror property. Live: the forward press marked the nine
  descendants at their exact hops with the schema kind and the right column diff, and the reverse
  press then exited 0 on its first attempt, printing "the passenger column is passenger_total on
  the board today; this run renames it to riders" and marking **the same nine at the same hops out
  to 3**. The final repair settled the board with zero flags and zero tags, read back. The
  mid-swarm form stays forward on purpose: it lands on a board that just ran the original
  instructions.

- **A night of load found two real operational bugs, both fixed and both now tested with real
  hostile input, 2026-07-24.** DataHub slowed under hours of forty-task runs, and two things broke
  that a quiet afternoon had never exposed.
  - **A client timeout on a completion that landed.** A cascade's coordination outran the worker's
    60 s HTTP ceiling; the server finished the work, every mark correct, and the worker declared
    the run dead: the operator told the opposite of the truth. Verified by read-back at the time
    (nine marks at the exact expected hops with the client having reported failure). Every
    mutation call now gets a 300 s ceiling (`MUTATION_TIMEOUT` in `agents/worker.py`, used by the
    demo runner and the MCP server both), sized so a genuine hang is the only thing left that can
    reach it. A timeout on a mutation is an unknown outcome, not a failure, and the ceiling is the
    difference between the two staying rare.
  - **A dead MCP session was cached forever.** `mcp.ts` cleared its cached connection only when
    CONNECTING failed; a session that connected and died hours later left a corpse every call hit,
    and every completion after that moment 500ed at the tag step with the decision already
    committed. Fixed with drop-on-close plus one reconnect retry, narrowly matched to the SDK's
    two closed-transport shapes; the retry is safe because both tag tools are proven idempotent.
    The live test kills the real subprocess with SIGKILL and asserts the next apply lands on the
    entity, read back over GMS. The kill found the second error shape ("Connection closed" for a
    call in flight) that the first fix missed, which is what a real hostile input is for. The MCP
    live file is 9 tests now; the live suite is 72.

- **A launched step now reports to the server that launched it, found by running two obsels at
  once, 2026-07-24.** The agents default to `http://localhost:3000`, and the launcher spawned
  steps with that default intact, so a button pressed on an obsel at any other port sent the
  step's writes to whatever was listening on 3000. With an operator's board and an isolated one
  both up, the isolated board's reset button reset the operator's flow, and its register button
  put one foreign task into the operator's pipeline before the step's own URN-mismatch guard
  stopped it at a single task. The launch route now passes its own origin (from the URL Next
  resolved, never from a client header) into the child's `OBSEL_URL`, so the child reports to
  the obsel whose button was pressed, whatever its port. Validated live by re-running the same
  two steps on the isolated port with the fix in place: both exited 0 against the isolated flow
  with the operator's board untouched. The operator's flow was restored through the ordinary
  demo path, and the one foreign task's soft delete is left as an owner action, the command
  dry-run verified.

- **The demo has a capture harness, and a reference picture lock exists, measured by ffprobe,
  2026-07-24.** `video.mjs` records the whole take in one shot through the real guide buttons: it
  refuses a board that is not forty registered tasks, clicks the swarm and the repair with a
  visible cursor, decides every beat from the swarm and the activity feed rather than from
  pixels, and refuses to save anything when a step exits non-zero or a beat never arrives. It
  writes the continuous recording, two same-run screenshots, and a `timeline.json` carrying the
  beats, the segment plan (1x through the moments, the three waits sped and labeled), and the
  exact ffmpeg command that assembles the lock. `--replan` recomputes the cut from a saved take
  without a seven minute retake.

  Two full dry takes ran end to end, both clean in one shot each. The first: marks at +143.9 s,
  swarm exit 0, first flag off at +260.9 s, assembled to a measured **162.9 s**. The second, with
  the holds tuned to the narration: the change landed mid-swarm and marked **7 of 40** (two of
  the nine descendants were still in flight, correctly untouched, and resolved on their own),
  swarm step "finished in 4 m 06 s" on its own result line, repair cleared everything, assembled
  to a measured **157.9 s against the 176 s cap**, ffprobe both times. The per-run marked count
  varying between 7, 8 and 9 on the mid-swarm form is the design working: only finished work is
  marked at the moment the change lands. The reference take, its lock, its screenshots and its
  timeline are kept under `out/take2/` (ignored by git). `docs/demo-script.md` was rewritten the
  same day around this sequence. Voiceover, the cut, and the upload are the owner's.

- **The forty-task labels problem is answered with bounded zoom, measured, 2026-07-24.** The
  whole-graph fit at 1920 x 990 lands at zoom 0.583, which is a 7.5 px label: fine on a monitor,
  mush on a 1080p recording. The hybrid keeps that fit as the establishing shot and adds the
  reading moves: drag pans, pinch zooms, and React Flow's own zoom and fit buttons (restyled to
  obsel's tokens, not rebuilt) give the mouse the same range. The instance now carries the zoom
  range too, which made a latent backstop real: `fitView`'s 0.2 floor option was silently clamped
  by the viewport's own 0.5 default the whole time. Editing stays off: nodes cannot be dragged,
  connected or selected, and the scroll wheel deliberately does not zoom so the tall page stays
  scrollable. Measured on the live board: six clicks reach zoom 1.5 with labels at **19.5 px**,
  and the fit button returns to exactly 0.583 with zero nodes clipped, which is the recovery the
  old interaction lock existed to substitute for. A browser test zooms, strands the picture on
  purpose with a hard pan, and asserts the fit button recovers it: **107 browser checks pass**.

- **The bring-your-own-data path, executed end to end over MCP, 2026-07-24.** A judge's own data
  through obsel's own door, nothing simulated: a five-row expenses CSV, read the way an agent
  reads a file, driven through the six MCP tools against a dedicated flow. Two tasks registered
  (a cleaner reading the file, a totals task reading the cleaner's table); first runs completed
  quietly in 39 and 49 ms of coordination; the file's `amount` column renamed to `amount_usd`;
  the cleaner re-reported and obsel answered **changed clean_expenses (schema), marked 1 finished
  task stale in 3934 ms**, the mark carrying "read clean expenses, and its columns changed after
  this finished". The totals redo landed identical (a rename upstream does not move the totals)
  and the flag came off through it. The walkthrough is written up in `docs/setup.md`; every reply
  quoted there is from this run.

- **The graph panel grows to the layout instead of clipping it, found and fixed the same day.**
  The first forty-task board rendered cut off at the top and bottom: `fitView` has a 0.5 zoom
  floor it clamps at, and the fixed 320px panel needed roughly 0.38. The panel now takes its
  height from the laid-out graph (`panelHeightFor` in `lineage.tsx`), the page scrolls when the
  board genuinely cannot fit the frame, and the four-task demo keeps its exact previous geometry.
  Measured after the fix at 1920 x 990: pane 1758 x 845, zoom 0.58, zero nodes clipped in either
  direction.

- **Growing the graph panel starved the panels under it, found by the owner and fixed the same
  day.** The strip below the graph holds the details panel and obsel's own narration, and it is
  `flex: 1 1 0` with a 172px floor. That pairing is what makes the four-task board work: the graph
  takes its fixed height first and the strip absorbs whatever the frame has left, so a taller
  display grows the step list rather than a black gap. All of it depends on there being slack.
  A tall board has none, so the strip resolved to its floor exactly, and the fix for the clipping
  had quietly made the panels beneath it as small as they are allowed to get.

  Measured at 1920 x 990 before: trace panel 172px, its scroller 105px, three of eighty-six steps
  legible, the details panel beside it identical. After, with the strip sized rather than fitted
  on a tall board: **panel 396px, scroller 329px**, both panels showing a full decision group and
  the whole detail list without scrolling at all. The laptop comes out at 360 and 293 against the
  clamp's floor. Nothing about the four-task board changed, which the browser suite checks by
  comparing the two rather than by pinning a number.

  A pinned ribbon was tried for the same complaint, the measured detection time sitting at y=1338
  in a 990px viewport, and rejected. `position: sticky` does put it on screen, and it also lays a
  62px bar across the bottom row of the graph at every scroll position: mmux's surface token is
  2.5% cream, so the first attempt was transparent and the nodes read through the number, and
  making it opaque only makes the covering honest. Hiding a row of the picture to save one scroll
  to the conclusion is the wrong way round. It is written up in `cockpit.module.css` so it is not
  tried a third time.

- **The straddling-reader mark, proven live and deterministically, 2026-07-24.** Three tests
  added to `tests/live/engine.live.test.ts` hold the concurrent race still by driving the real
  API: a reader announces, its input's producer re-reports a schema change mid-run (the running
  reader correctly skipped by that cascade, and the walk stopping at it), and the reader then
  finishes carrying an observation of the replaced version. obsel marks the finishing reader
  itself, with the producer named, hop 1, and the reason saying the table was replaced before this
  finished. It raises no unreported-change alarm, lands the tag (read back off the entity), and the producer's
  record carries the superseded fingerprint that made the verdict possible. Beside it: a reader
  that loaded the version that stands completes clean, and a reader two versions behind raises
  the unreported alarm with no author, which is the documented one-deep memory bound, pinned
  live. The whole suite: 71 tests across 7 files, exit 0. What remains chance-dependent is only
  the on-camera Codex-timed sighting during a scale run, where both interleavings are asserted
  correct for what they are.

- **The forty-task board is browser-tested, against two recordings of a real one, 2026-07-24.**
  `e2e/scale.spec.ts`, 13 tests, run at both viewports: **103 browser tests pass, 1 skipped,
  exit 0**, up from 78. Its fixtures are the difference worth stating. Every other fixture in that
  suite is hand-written and says so; these two are `GET /api/swarm` as the server sent it, captured
  a minute apart off the live board on flow `obsel_scale_v2`: forty finished Codex sessions with
  nothing marked, then the same board after `daily_trips` renamed one column, carrying the nine
  marks obsel wrote and the nine tags DataHub confirmed. A hand-typed forty-task graph would be a
  hand-typed claim about the layout these tests exist to check. They are read through a structural
  type check plus a runtime check of the three unions and every mark's cause, so a capture of a bug
  cannot pass as a fixture.

  What the browser establishes that nothing else did: no node clipped on either board, at either
  viewport, across a shrink to 1100 x 620 and back; eighty-two boxes with not one overlapping pair
  in pixels; no sideways scroll; exactly the recorded nine painted amber and no other, matched task
  by task against the capture, with the amber proven to still resolve to a colour; all three hop
  distances present, one task at three hops; the three-hop reason opening in full, naming the task
  in between in words; the changed table showing `riders` leaving and `passenger_total` arriving;
  and both scale buttons clicked, launching `scale-change` and `scale-repair`.

  Confirmed the same day against a live read rather than a recording, on a server pointed at the
  real flow at 1920 x 990: 82 nodes, **zero clipped**, pane 1758 x 846 at zoom 0.578, document
  width equal to the viewport so nothing scrolls sideways, page height 1411 so the tall board
  scrolls down as designed, 18 cascade edges lit, and no console error.

- **The board's word ceiling was measuring the wrong thing, and the correction moved the numbers.**
  Rescoping it for forty tasks turned up a defect in the measurement itself. `prose` is a
  subtraction, everything on the body less the parts counted separately, and the graph was being
  counted with `textContent` while the body used `innerText`, so each node ran its title into its
  status word and handed prose one word per node that was not prose. Nine nodes made that look like
  rounding; eighty-two made it a paragraph. Corrected in `e2e/fixtures/words.ts`, which both suites
  now share so the two boards are measured identically.

  Measured at 1920 x 990 after the correction: the four-task flagged board is **147 words of prose**
  (recorded as 154 before, with no copy changed) and the forty-task flagged board is **135**. Ten
  times the pipeline, twelve words fewer, because the taxi stage offers two actions where the demo
  offers three and every other sentence is the same sentence with different nouns in it. The graph
  left the combined total, which is a correction and not a relaxation: labels are scanned, there is
  one per box, and the box count is the user's pipeline rather than obsel's to budget. It is capped
  per node instead, at 9 against a worst observed 8. `scale.spec.ts` asserts the two boards' prose
  figures against each other rather than against a constant, so the claim that density does not
  track pipeline size is checked rather than assumed.

- **The prerequisite checklist reported four green ticks while obsel was completely blind.**
  Found on 2026-07-24 by opening the board cold. It showed "The board lost its connection" over a
  500, and its own checklist showed DataHub, the tag, the Python packages and Codex all passing.
  `docker ps -a` explained it: `datahub-opensearch-1  Exited (127) 4 hours ago`.

  The check asked `GET /config` and stopped there. That reply is served from the GMS process, so
  it kept answering 200 with the graph store gone, as did entity reads by URN against the aspect
  store, while every `/relationships` call returned 500 with `ESQueryException: Search query
failed`. Traversal is the whole of obsel's reasoning, so obsel could do nothing, and three
  separate signals said it was fine. Full measurements in `docs/environment-findings.md` section 12.

  This is the failure shape this repository treats as the worst available. A missing check leaves
  the reader looking. A green check that is wrong sends them looking inside obsel, which is the one
  place the fault was not.

  `checkDataHub` in `src/server/runner/preflight.ts` now asks `/config` first, which is what
  separates "DataHub is not running" from "DataHub is running and cannot answer", and then makes
  the exact `relationships()` call `readSnapshot` opens with. Measured after the fix, by genuinely
  stopping the container rather than simulating it:

  ```
  docker stop datahub-opensearch-1
  RED  datahub: DataHub is running at http://localhost:8080, but it could not answer what is
       connected to what (500). That question is served by DataHub's search index, which can stop
       while the rest of it keeps running.
  RED  vocabulary: Cannot be checked until DataHub answers.
  OK   venv, OK codex
  ```

  Every one of those four had read green in the same state ten minutes earlier.

  **The board's dead end closed with it, and no cockpit code changed.** The connect stage already
  renders a failing DataHub check with its fix; it had nothing to render because preflight was
  reporting success. With the truth reaching it, the same screen that had offered a newcomer no
  next step now carries the failure and `Run this in a terminal: datahub docker quickstart`.
  Recovery measured the same session: `docker start datahub-opensearch-1` reported healthy in about
  20 s and the board came back on its next poll about 3 s later, with no data lost, because the
  graph is rebuilt from the aspect store rather than stored only in the index.

- **The frontend port answers 200 to both probes a status check would make.** Measured the same
  day while looking for a hostile input that did not require stopping a container. `:9002` returns
  200 for `/config` and 200 for `/relationships`, the second with the web app's HTML, because an
  unknown path under a single-page app serves the page. So the old check called it healthy, and a
  traversal check reading only status codes would have called it healthy too. `relationships()`
  validates the body shape rather than the status, which is what catches it.

  It is the better test input precisely because it is not destructive: real server from the same
  quickstart, real failure, and the mistake an operator actually makes.
  `tests/live/preflight.live.test.ts` covers both that address and a port nothing is listening on,
  and asserts the two verdicts do not leak into each other now that the cache key names the address.

  **Pinned by breaking it, and the break found a false claim in the test's own comment.** With the
  traversal probe removed, the frontend case failed as intended, and the case asserting the healthy
  detail sentence stayed green: that sentence is written at the end of the function either way, so
  it never pinned the traversal it claimed to. The comment now says which test does.

- **The door an outside agent joins through was on the page, 17 pixels tall, and its own author
  did not know it was there.** The owner asked on 2026-07-24 why obsel had no way to help somebody
  get connected. It had one: a `<details>` carrying this machine's real `claude mcp add` command, a
  copy button, and the six tools with what each is for. Measured on the running board at 1440 x 900
  before it was replaced: **12px type in a 17px row**, closed, above the graph. He wrote its
  contents. A door its own author cannot find is not a door, and no amount of correct content
  inside it changes that.

  It is `src/features/cockpit/joining-panel.tsx` now, an mmux `Panel` under the graph and above the
  numbers, which is the order a judge reads in. Measured after: a **75px panel with a 13px
  heading**, a state line beside it, and a line inviting the click.

  What it gained is a checklist that ticks itself off, derived the way every other sentence on the
  board is derived. `src/features/cockpit/joining.ts` recomputes four steps from the swarm snapshot
  on every poll, in the order `skills/obsel-collaboration/SKILL.md` teaches: the agent declared what
  it reads and writes, it announced before writing, it reported what it produced, and obsel answered
  a change to its data. There is no stored step anywhere.

  Three decisions in it are worth recording, because each was the honest option rather than the
  impressive one:

  - **No step claims obsel can see an agent's settings**, because it cannot. Nothing on this
    machine can tell whether somebody pasted the command or edited a configuration file. The command
    sits above the list as the thing to do, and the first tick is that agent's own first call
    arriving. It is a weaker promise than a setup wizard makes and it is the only one obsel can keep.
  - **obsel's own work is the closed set, and everything else is a visitor.** The first version had
    this exactly backwards and it would have broken the feature completely. It classified anything
    outside the `obsel_demo` and `obsel_taxi` namespaces as a visitor, which sounds structural and
    is wrong: `datasetUrn` in `src/server/datahub/urns.ts` qualifies any unnamespaced table under
    `obsel_demo`, and the HTTP API takes short names, so a visiting agent registering
    `expenses_csv` lands in `obsel_demo.expenses_csv`. Every real visitor would have been counted
    as obsel's own and the panel would have sat at zero of four forever.

    **The unit tests passed, because the fixture was written to match the belief.** It gave the
    visitor a `finance.` prefix that no caller produces. What found it was asking what the MCP door
    actually emits and then running one, which is the same lesson as the deleted in-memory GMS in
    `CLAUDE.md`: a stand-in can only assert what its author already believed.

    The rule is now obsel's own four demo task names, read out of `agents/pipeline.py` by a test,
    plus anything touching the taxi namespace, read out of `agents/scale.py` by another. That also
    puts the risk on the safe side: an unknown task is a visitor, so the panel works for a stranger,
    and only an exact collision with one of four names misreads.

  - **An identical re-run does not tick the fourth step.** `previousFingerprints` is written
    whenever a completion replaces a fingerprint, including a re-run that produced the same bytes,
    and that case is the opposite of what the step is about. The hashes are compared, so only a
    genuine difference counts.

  **The panel refusing to close was a real bug, found by the browser suite.** A reader who opens a
  folded panel must not have it shut under them by the next one-second poll, so a choice that
  differs from the derivation is remembered. The first version remembered any `toggle` event at
  all, which is not the same thing: React sets `open` on the element after creating it, the browser
  sees `false` become `true` and fires `toggle`, so mount was indistinguishable from a click. The
  panel recorded a preference nobody had expressed and then honoured it forever, including through
  a failed read, where it kept displaying "3 of 4" about an agent obsel could no longer see. Storing
  the choice only while it differs from the derivation fixes it exactly. Both halves are pinned:
  "a reader who opens it is not overruled by the next poll" and "stops counting a visitor's progress
  the moment the read fails".

  **Driven end to end by a real MCP session, 2026-07-24.** A `next start` on port 3200 pointed at
  its own flow, `obsel_join_check`, and a real `agents.mcp_server` over stdio registering and
  reporting two tasks of its own. The board was read after each step:

  ```
  1. both registered            clean_expenses registered   monthly_totals registered
     writes=obsel_demo.clean_expenses      <- the URN that broke the first classifier
  2. the cleaner announced      clean_expenses running
  3. both reported              clean_expenses complete     monthly_totals complete
  4. one column renamed         clean_expenses complete     monthly_totals stale FLAGGED
  ```

  The panel read **4 of 4** with every step naming the visitor's own registered title: "Expense
  cleaner is on the board, with its tables wired to it", through to "obsel has seen Expense
  cleaner's table change since it was first recorded". The headline above it read "1 of 2 finished
  agents are out of date". Somebody else's two agents, on a real DataHub, with obsel answering.

  The demo flow on port 3000 was confirmed unchanged across the whole exercise, which is the check
  the launcher-origin incident earlier the same day earned.

  Measured cost to the board's prose budget: **147 words to 155**, ceiling 160. Twelve words bought
  the heading, the state line and the invitation, less the four the old disclosure spent. Everything
  behind the fold still costs nothing until opened, and `joining.ts` keeps it folded on exactly the
  board the ceiling measures. Counts after this work: 298 unit tests across 14 files, 76 live across
  8, 121 browser checks, 174 Python self-checks. (Both counts moved on 2026-07-26; see the
  defect section below.)

### Four defects an outside review found, and what each fix is pinned by (2026-07-26)

Three independent cold reviews of the coordinator turned up four ways it could give a wrong answer,
none of which any existing test caught. All four are fixed on branch `erasure-coverage`. Every fix
below was confirmed by breaking it again and watching a named test fail; the mutation and its
observed failure are recorded with each, because "the tests pass" is not evidence when the tests
passed before the fix as well.

- **Two tasks writing one table resolved three different ways.** `affectedBy` kept the LAST
  registered writer, `engine.ts` kept the FIRST, `restoredBy` kept the last. All three now go
  through one `producersOf` map that keeps every writer, and each caller states its own rule:
  `restoredBy` requires EVERY writer to be settled before a flag comes off, `readyToStart` requires
  every writer to have finished, `blocked` names all of them, and `affectedBy` names nobody as the
  author of a change either writer could have made. Which writer produced the bytes standing now is
  recorded nowhere, so a rule that consults one is picking at random.

  Pinned by 6 tests in `tests/staleness.test.ts` under "two tasks writing one table". Mutating
  `restoredBy` back to last-writer-wins clears `write_report` and `write_docs` on a board where the
  table's other writer is still stale: a false clear, the one answer that must never happen.
  Mutating the author rule back names an arbitrary writer; mutating `readyToStart` back starts a
  task on a table another writer is mid-way through replacing.

- **A cascade that failed halfway was lost permanently.** `recordCompletion` ran before the marks
  were written, advancing the baseline the decision had been computed against. A retry of the same
  report then compared the new fingerprints against themselves and answered `changedOutputs: []`.
  Marks are now written first; the baseline moves only once nothing is left that could fail and lose
  them, and every write in that order is idempotent under retry.

  Pinned live, with a real failure rather than a simulated one: `mcp.ts` spawns the tag server by
  bare `uvx` through PATH, so the test drops the cached connection and empties PATH. Measured
  against the pre-fix ordering: the retry returned `changedOutputs: []` and `affected: []` for a
  rename that had genuinely happened. After the fix it returns the rename and all three finished
  readers, with the tags confirmed on the entities.

- **Two completions at once tore each other's record.** `updateTaskProperties` is read-modify-write
  over one `dataJobInfo` aspect and DataHub offers no compare-and-swap, so two completions touching
  one task interleaved. `coordinateCompletion` now serializes process-wide. That scope is honest
  rather than complete: two obsel processes against one DataHub would need a lock DataHub does not
  offer. `elapsedMs` is stamped before the wait, so a completion queued behind another reports the
  time its caller actually waited rather than quietly excluding it.

  Measured against the unlocked engine, three runs of three: both completions rejected with
  `DataHubError: DataHub write was not confirmed within 10000 ms` — the collision surfacing, because
  `confirmWrite` polls for its own value and the other completion's write had replaced the aspect.
  The tag half lives on `globalTags` and is not rolled back with it, so an unlucky interleaving
  leaves a task obsel's record calls complete and DataHub's UI shows flagged.

- **A cascade tagged one URN per call through a single stdio pipe.** Structural, and verifiable at
  the `pre-erasure-proof` tag: `engine.ts:633` called `applyStaleTag([task.urn])` once per task
  inside a `Promise.all`, while `mcp.ts:177` had always accepted an array and nothing was passing
  one. `markAllStale` now writes every task's properties together and applies one tag call for the
  whole cascade, so its cost is one round trip regardless of width. The ordering rule survives: all
  properties are written and confirmed before any tag, so a tag never points at a task with no
  recorded cause.

  Covered by the live cascade tests, which read every tag back off its entity.

  **A correction, recorded rather than quietly dropped.** An earlier version of this section carried
  a specific failure measurement for this defect: roughly 48 marks, three tags landing at 14.6, 15.0
  and 17.6 seconds and the rest failing at 20.5 and 68.4. Those numbers came from a code review
  summary and were written here as though they were a recorded run. Searching every file at every
  commit in this repository finds no such measurement, and the largest cascade the scale board can
  produce is nine marks, not forty-eight, so the figure cannot have come from the scale runner
  either. **It has been removed rather than re-measured, because it was never obsel's measurement to
  begin with.** What justifies the fix is the structure above, which anyone can check out and read.
  The rule this violated is the project's own: a claim must name its evidence.

- **`resetSwarm` could not clean up the state that most needed cleaning.** Found while fixing the
  above, not reported by any review. It decided what to untag from obsel's own properties rather
  than from the tags DataHub actually holds, so a task whose properties were cleared while its tag
  survived was walked straight past — and that is exactly the disagreement a reset exists to remove.
  One was left in the integration flow by the run that measured the concurrency defect, and every
  later run started on a board carrying a flag from a take that was over. Now filtered on
  `staleTagged`, the real aspect. Confirmed by the live suite recovering from that leftover state
  on its first run after the change.

- **One test was vacuous, and is now real.** The reporter-exclusion guard at `staleness.ts` could be
  deleted with all tests still passing: the case that covered it used a reporter the walk could
  never have reached, so the graph shape was doing the work the option claimed to. Replaced with a
  two-task cycle where the reporter genuinely is downstream of its own change. Deleting the guard
  now fails that test by name.

Counts and measurements after this work, all on 2026-07-26 against DataHub v1.5.0.6:

- `pnpm verify` green: **305 unit tests across 14 files** (was 298), 174 Python self-checks, clean
  build.
- `pnpm test:live` green: **78 tests across 8 files in 267 s**, including two real Codex sessions.
  `engine.live.test.ts` is 24 of those (was 22) and runs in 164 s.
- `pnpm e2e` green: 121 browser checks across two viewports, 31 s, one skipped by design.

No timing claim is made for the batching fix. The mechanism it removes is verifiable in the
pre-pivot source, and the live cascades confirm the batched call tags every entity; what obsel does
not have is a before-and-after measurement at scale, and it does not assert one.

### The erasure coverage kernel, and reading a catalog obsel did not create (2026-07-26)

`src/server/coordinator/erasure.ts` implements `docs/erasure-coverage.md`. Pure, no model calls, no
network, the same discipline as `staleness.ts` and without importing its defaults. The
counterexample table from that document is `tests/erasure.test.ts`, one named test per row.

- **Twelve mutations against the kernel, all killed.** Eleven fell immediately to exactly one named
  test each: TOTAL, sole-producer, the recorded-lineage requirement, the closure cross-check, the
  input-attested requirement, predicate coverage, request scoping, retraction, version exactness,
  partition scope, and the least fixpoint (replacing it with a greatest fixpoint failed 17 of 24).
- **The twelfth survived, and mattered.** Deleting the signature check from the rebuild path passed
  all 24 tests, because the case covering ATTRIBUTED only ever exercised the direct path. An
  unsigned rebuild claim over attested inputs would have been accepted, and a rebuild claim is the
  one worth forging: it covers a whole table without anybody looking inside it. Now a named test,
  and the mutation is killed.
- **Nothing reaches ATTESTED in production yet, by design.** The kernel refuses any attestation
  whose `signatureVerified` is false, and the layer that sets it truthfully is Phase 3.

`readLineageDownstream` walks a real catalog over `GET /relationships`, and `datasetUrn` now passes
fully-qualified foreign URNs through, which is what makes a snowflake table or a looker dashboard
nameable at all. Both are covered by `tests/live/lineage.live.test.ts` against the real
`showcase-ecommerce` pack.

- **A live bug the unit tests could not have found.** `DownstreamOf` returns column-level lineage
  down the same edge type as table lineage: `order_details` answers with 109 upstream edges, **12
  datasets and 97 `schemaField` URNs**. Unfiltered, the kernel's closure cross-check would refuse
  every rebuild claim on that table for failing to declare ninety-seven columns as upstream tables.
  Nothing in the shape of the API suggests it. Written up as `environment-findings.md` §13.3;
  removing the filter fails a named live test.
- **Writing onto a foreign entity is refused before the read, not after.** `updateTaskProperties`
  rebuilds `dataJobInfo` from four fields, so on somebody's real entity it would drop `externalUrl`,
  `created` and `flowUrn`. The live test reads every aspect of a real showcase dataset before and
  after the refused call and asserts the set is unchanged, so it proves nothing happened rather than
  that an exception was raised. `resetSwarm` carries the same guard, and it names the flow
  independently of the scoping it is checking, because that scoping has silently failed once before.

Counts after this work: `pnpm verify` green with **334 unit tests across 15 files**; `pnpm test:live`
green with **84 tests across 9 files in 260 s**.

### The attestation layer: what turns a claim into evidence (2026-07-26)

`src/server/coordinator/attestation.ts` is the only thing entitled to set `signatureVerified` true,
and the kernel refuses everything where it is false. Real Ed25519 keys and real `node:crypto` in the
tests, generated per run; nothing is stubbed, because a stand-in for a signature check can only
assert what its author already believed.

Nothing here is invented where a standard exists. The signed bytes are DSSE's Pre-Authentication
Encoding, the format in-toto and Sigstore sign. Four conditions must all hold, and they fail
separately so the report can name which one: the signature verifies over the canonical bytes, the
key was usable and has not since been reported compromised, the attestor is in scope for that asset,
and obsel's challenge was fresh, unexpired and never used before.

- **Seven mutations, all killed.** Ignoring the signature result, dropping the challenge check,
  dropping scope, dropping the attestor binding, and time-bounding a compromise each fail named
  tests.
- **One mutation appeared to survive, and the harness was wrong, not the code.** Replacing the
  received payload with a re-serialisation before verifying passed all 30 tests. That is the classic
  way a signature check ends up covering something other than what was signed, so a test was written
  for it: a payload whose fields are re-ordered after signing parses to an identical record and must
  still be refused. Re-running then showed the earlier mutation had been rewriting the _signing_
  call rather than the verifying one, because both sites shared a string and only the first was
  replaced. The test stands on its own merits and does kill the real mutation; the sequence is
  recorded because a mutation that never applied looks exactly like a guard that is not needed.
- **Rotation and compromise are separate paths, deliberately.** A retired key's past signatures
  stand, because retirement says only that a key is out of use and dropping its work would punish
  good hygiene. A compromised key's signatures all fall, whenever they were made, because the report
  says somebody else may have held it and there is no honest way to say for how long. Same shape as
  RETRACTED against SUPERSEDED in the kernel.
- **Key compromise is not a write, and nothing else in obsel would notice it.** Every other way
  coverage is lost happens because somebody touched data. `invalidatedByKeys` is what takes back
  attestations after a compromise report, including for a key deleted from the registry rather than
  marked, since reading its absence as "still fine" is the exact failure obsel exists to catch. A
  test drives the whole loop: an asset goes ATTESTED, the key is reported compromised, nothing about
  the data changes, and the asset goes back to UNPROVEN.

Counts: `pnpm verify` green with **365 unit tests across 16 files**.

### One erasure, end to end, over real HTTP (2026-07-26)

Four routes now exist: `POST /api/erasure` opens a request and walks the catalog,
`POST /api/erasure/challenge` issues the one-time value an attestor binds into what it signs,
`POST /api/erasure/proof` takes a signed envelope, and `GET /api/erasure/[id]` reports coverage.
Mutating routes are behind a bearer token. `tests/live/erasure.live.test.ts` drives all of it
against a real Next server, real Ed25519 keys, real DataHub `document` records and a real lineage
walk across `showcase-ecommerce`: **9 tests, all passing.**

What that run demonstrates, in order: a request opens and every reachable asset is `UNPROVEN`; the
report does not echo the subject's identifiers back; an unsigned claim is refused with a 422; a
genuinely signed attestation moves exactly one asset to `ATTESTED` and leaves everything downstream
alone; the same envelope submitted twice is refused as a replay; a fresh `GET` recomputes the same
answer from DataHub; and a key reported compromised takes the coverage back with no data having
changed.

- **The token is not the trust root, and the code says so.** An attestation counts because it is
  signed by a key obsel was told out of band to trust, verified over canonical bytes, bound to a
  challenge obsel issued. The bearer token stops an unauthenticated party opening requests and
  burning challenges, which is denial of service rather than forgery. There is deliberately no route
  that registers a key: an endpoint that adds keys is an endpoint that mints attestations.
- **An unconfigured obsel refuses writes rather than allowing them.** With no `OBSEL_API_TOKEN`,
  mutating routes answer 503. The opposite default is how tools ship wide open, and the failure is
  silent because everything works.
- **A live test asserts the absence of the endpoint that must never exist.** No route marks an asset
  covered. Coverage is derived from the ledger on every read, so there is nothing to clear even in
  principle, and the absence of that endpoint is exactly the kind of thing a later commit adds for
  convenience.

Two defects were found by running this, neither reachable from the unit tests:

- **A malformed payload crashed the verifier instead of being refused.** Feeding `{}` through the
  real route produced a 500: every payload the unit tests build is well formed, so the first check
  that reached for a field the record did not have threw. A crash in a verification path is the
  wrong failure twice — the caller learns nothing, and unvalidated input travelled further into the
  check than it should. Shape validation now runs before the key is even looked up, and five
  malformed payloads are a named test.
- **The ledger could not be read back through search.** The first implementation enumerated it over
  GraphQL `searchAcrossEntities`, and a record written a moment earlier was not yet indexed, so a
  request could not find its own opening record. Every ledger URN is now derived from values the
  caller already holds, and attestations are enumerated by counting up until a genuine 404. No
  search index sits anywhere in the path that decides coverage. Written up as
  `environment-findings.md` §13.4, along with the `relatedAssets` field-name 400 that preceded it.

Counts at this point in the day, before the two sections below added to them: `pnpm verify` green
with **373 unit tests across 17 files**; `pnpm test:live` green with **93 tests across 10 files in
256 s**; `pnpm e2e` green with 121 browser checks in 35 s. The current figures are at the end.

### The door an agent joins the erasure board through (2026-07-26)

`agents/mcp_server.py` now registers **nine** tools rather than six: `erasure_board`,
`request_challenge` and `submit_attestation` sit beside the swarm's original set. Every mutation
still goes through obsel's HTTP API, so the server holds no DataHub credentials, and the decisions
live in `agents/mcp_core.py` where `pnpm verify` checks them with the system `python3`.

`open_obligations` is the agent-facing work: it turns a coverage report into a sorted list of gaps,
each with a named next step. An unattested upstream is offered before the assets built on it,
because closing it may close them without anyone querying a table. A cataloguing gap sorts last,
because an owner cannot answer a question about lineage DataHub never recorded. A merge is never
offered as a rebuild.

That mapping is a lookup table rather than a model judgement, deliberately: what closes a gap is a
fact about the rule in `erasure.ts`, so a model choosing per row would invent variation where the
answer is fixed. The model is for the parts that are genuinely judgement — which owner to ask, how
to phrase it, when to give up and say so.

- **Nine self-checks** cover it, including that an unknown residue kind produces `unknown` rather
  than a guessed action, that out-of-scope work is marked rather than hidden, and that nothing the
  module returns can mark an asset covered.
- **A live test asserts what is deliberately not behind the door**: no `clear_stale`, `mark_fresh`,
  `dismiss`, `mark_covered`, `attest` or `close_obligation`. The tool inventory is the interface, and
  a tool that took a name and called it done is exactly the convenience a later commit adds.
- Counts are reported against a total, never as a bare percentage, because "96% covered" invites a
  reader to round up to done and the remainder is the entire point.

### Hostile concurrency on the erasure path (2026-07-26)

A challenge is single use, and single use is only true if checking a nonce and consuming it cannot
interleave with another submission doing the same. Two genuinely concurrent HTTP requests carrying
the same valid envelope go to a real server writing to real DataHub.

**Measured against the unlocked engine: both were accepted, 200 and 200.** That is the replay the
challenge exists to stop, reproduced. With `serialized` in place, one is accepted and the other
refused with `challenge-replayed`.

A second test pins the ledger's append-only property: two challenges answered for one asset land as
two records, and the earlier record is asserted byte-identical afterwards rather than merely
present. A shared URN would silently replace the first, and the evidence chain would be a chain of
one.

The lock's scope is stated rather than implied. It holds because obsel is one process; two obsels
against one DataHub would need a lock DataHub does not offer. That is the same honest limit the
completion lock carries.

**A note on how this was checked, because the first attempt was wrong.** Running the concurrency
test alone with vitest's `-t` filter skipped the test that opens the request, so every run failed
for a reason unrelated to the lock, including the run with the lock restored. A mutation whose
control does not pass proves nothing. The result above is from running the whole file both ways.

### Driving the running dashboard by hand, and the one gap it found (2026-07-26)

Everything above was reached by tests. This was reached by starting `pnpm dev`, pointing a curl at
it, and behaving like an attestor's adapter — which found something no test had, for the reason
those tests all shared.

The run, against the `showcase-ecommerce` catalog on DataHub v1.5.0.6, seeded from
`snowflake … order_entry.customers`, four hops:

- **23 assets reached across five platforms** — postgres, snowflake, dbt, looker, powerbi, tableau —
  and every one came back `UNPROVEN` with `no-attestation`. That is the honest day-one board.
- The same walk seeded from the **postgres** copy of the same table reaches **1 asset**, because
  DataHub records no downstream edges from it. The report says `assetsReached: 1` rather than
  implying a small estate, which is the assurance field earning its place.
- One real Ed25519 keypair, one challenge, one signed direct attestation over
  `snowflake … analytics.order_details`, submitted to `POST /api/erasure/proof`: **1 of 23 attested,
  22 unattested**, `evidenceRecords` 1 → 3, and the sentence the board prints is
  `order details is attested absent over version unknown by warehouse-adapter@obsel.local`.
- With no `OBSEL_API_TOKEN` set, `POST /api/erasure` answered **503** and named the reason. That is
  the fail-closed default observed on a real server rather than asserted in a unit test.

**The gap.** The first attestation submitted carried a plausible-looking predicate an adapter author
would guess at — `predicate` as a bare SQL string, `columnsSearched`, `observed: 0` — instead of the
`predicate` / `scope` / `result` the kernel reads. It was **accepted**. It is signed by a registered
key, in scope, bound to a fresh challenge, so every check below the shape guard passed it; the route
answered `accepted: true` and wrote it into the append-only ledger permanently. Then it explained
nothing, because `residueFromDirect` looks for `result === "absent"` and found no direct attestation
at all. The report said **"nobody has attested to it"** while the attestation sat in the ledger.

That is the exact confusion the whole of `documents.ts` exists to prevent from one direction — a
lagging index making a real attestation invisible — arriving from the other. "Nobody attested" and
"somebody attested unusably" are different findings with different next steps, and an adapter
emitting the wrong shape has to be told on the submission, while a refusal still costs only a
re-sign. A ledger record costs forever.

No test caught it because every record in `tests/attestation.test.ts` is built by one `record()`
helper that always fills in the variant fields — the same blind spot that let `{}` reach a field
dereference and return a 500 earlier the same day, one field further in.

`describeShapeProblem` now validates the variant-specific fields too. Mutation: replacing the
variant dispatch with `return null` fails **"refuses a signed record whose kind promises fields it
does not carry"** on the first of its nine shapes. A companion test asserts the three shapes the
kernel can actually read still verify, because a guard that refused everything would pass the first
test. Re-running the malformed submission against the live route now returns **422**, with
`malformed-envelope: direct payload result is undefined, expected absent or present`.

Final counts, all measured 2026-07-26 against DataHub v1.5.0.6, after the fix above: `pnpm verify`
green with **375 unit tests across 17 files and 183 Python self-checks**; `pnpm test:live` green with
**96 tests across 10 files in 266 s**; `pnpm e2e` green with **121 browser checks in 37 s**.

**Still not built, and named rather than implied.** No demo agent yet drives the erasure board end to
end on its own: the live run signs its attestation directly rather than routing work to an owner and
waiting. **There is no coverage board**, so the panels a judge sees are still the staleness ones —
with one correction made after actually looking at the running dashboard on 2026-07-26: the "what
obsel is doing" trace panel already carries erasure, because `erasure-engine.ts` emits into the same
activity stream the coordinator does. Opening a request, issuing a challenge, accepting an
attestation and refusing one all appear there live, the refusal in the same colour a stale mark
uses. That is narration of the erasure path, not a view of coverage; the 23-asset board itself is
still only reachable as JSON from `GET /api/erasure/<id>`.
The demonstration script for the erasure path does not exist. Article 19 recipient notification is
out of scope and stated as such. No cascade timing figure is claimed at scale; see the correction above for why the one previously printed here was withdrawn.

### Registering your own tasks from the board, and the bug driving it found (2026-07-26)

The bring-your-own-data panel: a form for the one half of "point obsel at my own files" that is pure
declaration. Until it existed the only route was the MCP walkthrough in
[`setup.md`](setup.md#bring-your-own-data), which is five steps of hand-written JSON before anything
appears on screen, and nothing on the board said the route existed at all.

**What it is not.** It does not report work, and there is deliberately no route by which the browser
could. A fingerprint is taken from rows by `agents/fingerprint.py` through
`worker.canonicalise_numbers`, and a second implementation of that in TypeScript would be a second
definition of what counts as a change — which breaks the first correctness rule in
[`CLAUDE.md`](../CLAUDE.md), that an identical re-run must mark nothing, in the one way no test would
notice until the two disagreed by a byte. The panel POSTs to the agents' own
`POST /api/tasks/register` rather than a route of its own, so a task typed into the form and a task
an MCP client registered are the same entity.

**Driven by hand against a real DataHub**, on `OBSEL_FLOW_ID=obsel_ui_check` so the run could not
touch the operator's board, serving the production build:

- `clean_expenses` (reads `expenses_csv`, writes `clean_expenses`) typed into the form and
  registered. Read back off `GET /api/swarm`: a real `DataJob` on `obsel_ui_check` with both lineage
  edges as full URNs, drawn on the graph as `Expense cleaner` / `waiting` between the two tables, and
  the joining panel's own first step ticked to **1 of 4** off the same snapshot.
- `monthly_totals` (reads `clean_expenses`, writes `monthly_totals`) registered the same way, giving
  the two-task chain the walkthrough uses. Both read back with their lineage intact.
- No console errors, no page errors, no horizontal overflow. The panel measured 1251 x 433 px with
  four 485 x 26 px fields.

**The bug it found, which no test had.** After the first successful registration the panel **shut
itself**, taking the confirmation line and the new row with it. `mine.ts` paints the form only on a
board with nothing on it, so the first registration flips that derivation to folded — and the
`chosen ?? expanded` idiom borrowed from `joining-panel.tsx` does not save it, because at the moment
the reader opened the panel it was already open. Their choice matched the derivation, so nothing was
recorded, and one poll later the panel closed under somebody who was about to register the second
half of their pipeline.

That is the same toggle rule from the other direction: the joining panel's version was written
against a panel that _refused to close_, and it is exactly right there. What it cannot express is
intent, and a form is a place where the reader has intent. The fix records the fold on a successful
registration, which is an action the reader took rather than a state obsel inferred; closing it by
hand still hands control back to the derivation. Pinned by
**"stays open after a registration, rather than shutting on the reader"** in `e2e/cockpit.spec.ts`,
which fails on the code as first written.

**The word ceiling moved, 160 to 168, and it was argued rather than raised.** The panel costs 7 words
always painted: 4 of heading and 3 inviting the click. Two cheaper shapes were rejected and one was
taken, all recorded at the assertion in `e2e/cockpit.spec.ts`. Nothing was excluded from the
bare-identifier or em-dash guards to make this fit: both passed unchanged, which was checked rather
than assumed.

Counts after this work, measured 2026-07-26: `pnpm verify` green with **394 unit tests across 18
files and 183 Python self-checks**; `pnpm e2e` green with **139 browser checks across two viewports
in 41 s**, one skipped by design. `pnpm test:live` was not re-run for this change and its 96 tests
are unaffected by it; no live test covers the form, and the run above is a single observation on one
machine rather than a suite.

**Still not built.** Reporting a file from the board, which is the other half and the one that would
let somebody watch a cascade on their own CSV without an agent. It needs one definition of how a CSV
becomes rows, shared with the agents rather than private to the UI, and that is a decision about what
obsel considers a table.

**A name that builds an unreadable URN is now refused at both doors**, landed the same day in a
separate worktree. The route checked names for being non-empty and nothing else, so `clean,orders` or
`a.b.c` created a real DataJob whose lineage pointed at a URN no reader could recover the name from:
`datasetUrn` interpolates the name, and `datasetName`, `shortName` in the cockpit and
`dataset_short_name` in Python all split back on commas and dots. The board drew a box with a
truncated name and nothing downstream could tell. `NAME_PATTERN` in `urns.ts` is now applied by
`register-body.ts`, mirrored in `agents/mcp_core.py`, and `tests/register-body.test.ts` reads the
pattern out of the real Python module and asserts it identical, the way `tests/urns.test.ts` does for
the two URN builders.

The board's form keeps its own copy, because browser code here does not import server modules, and
`tests/cockpit-mine.test.ts` holds the two together by comparing the form's verdict against
`taskNameProblem` and `datasetNameProblem` over a shared list of names. **That comparison
immediately found the form was too strict**: it refused any dot, while the route allows one namespace
segment, so it would have refused `obsel_taxi.clean_trips`, a name obsel's own scale swarm registers.
A client narrower than its server blocks legitimate work while looking like a bug in the field. It
also surfaced a non-divergence worth writing down: a comma in the reads or writes field is the
field's separator, so `parseNames` turns `clean,expenses` into two names and the route can never
receive one, which is a property of the field rather than of the guard.

**One infrastructure fix, unrelated to obsel's behaviour.** `pnpm verify` failed with 504 lint errors
in generated JavaScript, because a git worktree under `.claude/worktrees/` had been built and
eslint's `.next/**` ignore anchors at the repository root. Working in worktrees is ordinary now, so
the ignores gained `**/.next/**` and `.claude/**`. A gate that breaks whenever a worktree exists is a
gate that cries wolf.

**Every counted sentence now agrees with the number it is about**, landed the same day in the second
worktree. "1 agents ready to run" reached a real browser, seen while driving the form above: obsel's
own demonstrations register four tasks or forty, so a count of one never reached a stage until the
board could register one at a time, and every sentence that counts something had been written for the
plural.

Two of those were wrong at counts that needed no new feature to reach. The flagged headline and
`summaryLine` both keyed their **noun** to the marked count when it belongs to the finished count, so
**"1 of 3 finished agent is out of date" was reachable on the demo board** — the ratio's own
denominator contradicted by the word after it. The noun counts the finished work; only the verb and
the pronoun count the stale part. `agreeing` in `naming.ts` deliberately does not print the number,
because half these sentences put the count elsewhere in the clause than beside the noun it governs,
so a helper owning the number could serve only the easy half and the hard half is where the bug was.
Every stage that counts something is now checked at one rather than only the stage that broke, since
zero, four and forty all pass a sentence written for the plural, which is how it survived.

**A one-task board is now rendered in a browser too**, which the merged work did not cover: its tests
are all unit-level over `guide()` and `summaryLine()`, and the state had no fixture. `justOne()` in
`e2e/fixtures/swarm.ts` gives the three states a count of one can be in, and "a swarm of one" in
`e2e/cockpit.spec.ts` asserts no sentence anywhere on the page says `1 agents` or `all 1`, or glues a
singular noun to a plural ratio. It reads the live region's `textContent` as well as the page's
`innerText`, because a visually-hidden sentence is the one most likely to be left plural: nothing but
a screen reader ever reads it. Mutation: restoring the counted form in `registered()` fails that test
on both viewports, checked rather than assumed.

Counts after both merges, measured 2026-07-26: `pnpm verify` green with **424 unit tests across 19
files and 183 Python self-checks**; `pnpm e2e` green with **145 browser checks across two
viewports**, one skipped by design. `pnpm test:live` was not re-run for any of this work; its 96
tests are unaffected, and no live test covers the form.

## Not done

- **Every scale figure above is one observation.** One registered board, one concurrent run, one
  mid-run cascade, one parallel repair, on one machine. That is a demonstration, not a pass rate,
  and the demo-stability bar the four-task demo was held to, repeated clean sequences across days,
  has not begun for the forty-task one.
- **The forty-task board is browser-tested against recordings, not against a live read.** See the
  entry above for what the browser suite now covers. What it still does not do is drive the real
  `/api/swarm`: the two fixtures are recordings of one, replayed. A scale button has been clicked
  in the browser and the launch call asserted, but the step it launches is intercepted, so no
  forty-agent run has yet been started from the board end to end.
- **The window between a committed decision and its tag is real, and a crash inside it leaves a
  tag behind.** Observed once on 2026-07-24, under the dead-session bug described above: two
  completions committed their clears, the tag removal failed with the session already dead, and
  two complete tasks kept the tag. The board named the state honestly ("tags left over from
  before"), and the residue laundered itself through the next ordinary cycle: the reverse change
  re-marked both tasks, the repair's redos cleared them properly, and the board ended with zero
  tags anywhere, read back. The reconnect retry makes the window smaller; it does not close it,
  and nothing yet re-sweeps a tag on a task obsel considers sound.
- **The scale commands are proven by their recorded runs, not yet by repeatable tests.** The
  straddling-reader ENGINE rules are now in the live suite (above); the concurrent runner, the
  mid-run choreography and the shrinking repair as commands are proven by the 2026-07-24 runs and
  their own exit-0 assertions, which is one observation each.
- **The demo has passed a handful of times, not repeatedly.** Seven full clean sequences across
  2026-07-22 to 2026-07-24, on one machine, the newest being the first to run the whole loop
  including `repair`. That is not a pass rate. Codex is a live agent and its output is not
  guaranteed identical between runs. See the next point for the instances already found and fixed,
  and expect the possibility of others in categories nobody has hit yet.
- **Restoration has fired live exactly once.** The rule is proven deterministically and against the
  real DataHub in the suites, but the on-camera version, a live Codex redo landing byte-identical
  and two flags coming off without re-runs, has one observation behind it, from the run the repair
  GIF shows. The other path, a redo landing different and the repair absorbing the new cascade, also
  has one. The demo script says what to do when either happens on the day, and neither is a broken
  take.
- **Codex's output has needed pinning down three times, and may need it again.** Three separate
  instabilities have shown up in live runs, each of which made a re-run look like a real change:
  customer-name casing (fixed by pinning the instruction, see `agents/pipeline.py`), numeric
  serialisation, with `order_id` 1012's money value written `217` on three runs and `217.0` on a
  fourth, which broke `rerun-same` and made `change` report `both` instead of `schema` (handled by
  `canonicalise_numbers` in `agents/worker.py`, which fixes the serialised form per column before
  anything is hashed), and averaging precision, found by the first live `repair` on 2026-07-24 and
  pinned in the instruction the same day. All three were caught by the demo's own assertions rather
  than seen on camera, which is the property worth keeping. obsel itself called every one of those
  runs correctly.
- **An outside agent joining the demo's own board has not been watched visually.** The join path is
  real and proven, since the MCP live suite registers, works and cascades through it against the
  integration flow and the layout suite proves a fifth joined task lays out on the demo's shape,
  but nobody has yet watched a fifth box appear on the demo board from a real outside agent. The
  join panel's command is the real one for this machine; the watching is still to do.
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
  produced one measured figure: 6867 ms on 2026-07-21; 2591 ms and 2310 ms on separate runs on
  2026-07-22; 3424 ms, 1611 ms, 745 ms and 3281 ms on 2026-07-23. The spread is dominated by how long
  the bounded polling waits for each DataHub write to be confirmed, not by the deciding. The separate
  92 ms
  figure is the Python traversal alone.
- **The live trace is narration, not evidence.** It is emitted by the coordinator as it works and has
  been watched during a real cascade, but nothing reads it back, it is bounded to the newest 200
  steps, and it does not survive a restart. Anything it says is corroborated by the marks in DataHub
  or it is not corroborated at all.
- **The word ceiling is a guard, not a design proof.** `e2e/cockpit.spec.ts` fails the build if the
  flagged board goes past 168 words of prose, or 263 of prose and visible step log together, which
  stops the density that prompted this rebuild from creeping back. It cannot tell whether what
  remains is the right 162 words, and no test can. The ceiling has been raised three times, each
  time with the purchase written down word by word at the assertion; that ledger is the only thing
  standing between "bought deliberately" and "crept up".
- **The graph is laid out for two pipeline shapes now, not one.** The unit suite exercises a
  six-task fan-out and a cycle, and the browser suite covers the four-task demo and the forty-task
  taxi board in both states at both viewports. Nothing has been checked between or beyond those:
  a swarm much wider than the taxi pipeline, or one deeper than three hops, has never been drawn.
- The submission video is not voiced or uploaded. A reference picture lock exists (157.9 s,
  ffprobe, from a clean one-shot take), and the shoot, the voiceover, the cut approval and
  the upload are the owner's.
- **That lock predates two panels now and no longer matches the board.** It was taken before the
  joining panel went in under the graph, and the bring-your-own-data panel went in beside it on
  2026-07-26, so every wide shot in it is missing two sections the live board has and the page is
  taller again. This also lengthens the scroll the demo script calls a deliberate camera move: the
  ribbon is now two folded panels below the graph rather than one, and
  [`demo-script.md`](demo-script.md) says to practise that move. `video.mjs` drives buttons rather
  than pixels so it needs no change, but the take does: the reference has to be shot again before
  anything is cut from it. Nothing has been re-recorded yet.
