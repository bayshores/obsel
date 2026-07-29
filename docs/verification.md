# What is built, what is proven, and what is not

The full record behind the summary in [`README.md`](../README.md). It lives here rather than in the
README so the README can stay short, and because this is the part that gets read carefully rather
than skimmed: every number below came out of a run someone watched.

Two rules govern it. A figure is written down only if it was measured, and anything that has not
been established is in [Not done](#not-done) rather than left out.

---

## What is built

**The whole loop is built, and the whole demo now runs from the browser.** The page carries a
guide that reads the live state once a second and offers the next real action as a button: set up
the demo agents, start them, run one again unchanged, or change one agent's instructions. Each button
launches the same `agents.run` step the terminal path runs, verbatim, and the step's own printed
output streams onto the page. On 2026-07-22 the full journey (reset → re-declare → run →
identical re-run → change) was driven end to end **with five clicks and no terminal**, against a
live DataHub with a live Codex CLI, every step exiting 0.

Several things were rebuilt on 2026-07-23, all for the same reason: a stranger looking at the page
could not tell what it was.

- **Every sentence on screen is written for someone who has not read this file.** Two earlier passes
  had the same goal and did not hold, because the only guard on the copy was a word count and an
  identifier is short: `venv: the agents' Python environment (agents/.venv) does not exist yet` scores
  better on a word count than a sentence that explains itself. So the rule is written into
  `guide.ts`'s header and a check enforces the half a machine can see. **No internal name reaches the
  page**: not the `DemoStep` ids the launcher takes, not the keys of the preflight record, not an
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
  job as real DataHub metadata, `obsel.title` and the DataJob's description, and the page reads them
  back, so `clean_orders` appears as "Orders cleaner" everywhere, including in the reason written
  onto a stale mark. Nothing is mapped in the frontend; a pipeline that registers no title still
  reads as words, via a fallback.
- **The change is named, not hashed.** The demo renames a column, and the page used to render that
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
- **The page says what obsel is for.** It never did, which was the complaint underneath ten rounds
  of feedback. Both previous attempts were prose, a tagline in the header and then paragraphs above
  the graph, and both got deleted for the reason they should have been: they are how the screen reached
  604 words. The graph's heading carries it instead, in the slot that used to hold "how the work
  connects", a caption explaining how to read a picture whose boxes are already named and whose arrows
  already show direction. It reads "Each agent reads a table another agent wrote, so a change in one
  can make another's finished work wrong", and it states obsel's limits as much as its scope: not
  whether the work is good, not whether the pipeline is healthy, just whether it is still built on
  something still true.
- **The page says far less.** The flagged screen was 604 words in two stacked panels of prose, with
  nothing on it set larger than 13 px, so there was no entry point and the only way in was to read
  all of it. It is 267 words now, one headline leads, and the graph carries the mechanism. Nothing
  was deleted from the system: every reason, fingerprint, timing and code identifier is one click
  away on a node. Checks in the suite hold the line, because ten rounds of hand-edited copy is what
  produced the 604 in the first place: the two pages must say the same amount whatever the size of
  the pipeline, a longer run may not put more on screen, no box label may grow into a sentence, no
  em dash may reach the screen in any state, and the identifier guard described next. A hard ceiling
  on the page's total word count was among these and was removed on 2026-07-27; the dated section
  below records why.
- **What obsel wrote into DataHub is on the page, and counted.** obsel tags each marked job
  `urn:li:tag:obsel-stale` through the MCP server, which is the thing a person browsing DataHub sees
  without knowing obsel exists, and the page used to mention it in five grey words at the bottom of a
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
driving a step from the terminal instead moves the page the same way, and nothing on screen is
staged or pre-recorded.

**Added 2026-07-24: the loop closes.** Three things shipped together, because each is what makes
the others mean something.

- **A flag is now something you act on.** The flagged pipeline leads with **Redo the work obsel
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
| The agent output contract, names and number form                               | `agents/tables.py` (`canonicalise_numbers`), with a self-check           |
| The page: graph, headline, stats, step log, details                            | `app/page.tsx`, `src/features/dashboard/`                                |
| Live agent progress on the page                                                | `src/features/dashboard/progress.ts`                                     |
| The guide: stage derived from live state, buttons that launch the real steps   | `src/features/dashboard/guide.ts`, `guide-panel.tsx`                     |
| The demo runner: spawns `agents.run` steps, checks the machine's prerequisites | `src/server/runner/`                                                     |
| Each task's job, stored on its DataJob in DataHub and read back onto the page  | `agents/pipeline.py`, `src/server/datahub/client.ts`                     |
| The stale tag read back off the entity, and counted on the page                | `src/server/datahub/tags.ts`, `src/features/dashboard/timing.ts`         |
| A link from any task to its real page in DataHub's UI                          | `src/features/dashboard/datahub-link.ts`, `inspector.tsx`                |
| The restoration rule: which flags an identical redo provably clears            | `restoredBy` in `src/server/coordinator/staleness.ts`                    |
| The repair loop: flagged work redone in order, restored work skipped           | `cmd_repair` in `agents/run_demo.py`, the guide's leading flagged action |
| The joining panel and its four derived steps                                   | `joining.ts`, `joining-panel.tsx`, `joinCommand` on `/api/demo/activity` |
| Registering your own task from the page, wired into DataHub                    | `mine.ts`, `mine-panel.tsx`, over the agents' own `/api/tasks/register`  |
| The two animated captures and the script that takes them                       | `docs/images/*.gif`, `scripts/record.mjs`                                |
| The mark in the header and the browser tab icon                                | `src/features/dashboard/mark.tsx`, `mark-geometry.ts`, `app/icon.svg`    |
| The header lockup, and the name it reveals on hover                            | `src/features/dashboard/brand.tsx`, `brand.module.css`                   |
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
- **The quiet claim is bounded.** The page says "none of the tables they read has changed since,
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
- **The page's own logic**, by 192 further tests across `tests/dashboard-*.test.ts`. The load-bearing
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
  reset the page you have open, and `tests/urns.test.ts` runs the Python module for real to check both
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
  `mcp_core.py` contributes 49, and `mcp_erasure.py` a further 9, over what
  obsel's own MCP server decides before it speaks: the same refusal of a missing key (the same
  mutation fails five of these), an output the task never declared it writes, a table with no
  registered producer reported as exactly that rather than as fresh, `217` and `217.0` reaching
  one fingerprint while `218` still moves it, and the summary of an identical redo carrying its
  cleared flags beside the quiet line.

- **One real agent session per installed runner**, in `tests/live/runners.live.test.ts`, the only
  automated model calls in the repository. The subject is the invocation, not the reasoning. Every
  flag was learned by running the CLI, all of them fail silently in the way that matters, and no
  stand-in can say whether today's CLI still accepts them: Codex `--sandbox workspace-write` and
  `--skip-git-repo-check`; Claude Code `-p`, `--permission-mode acceptEdits` and `--safe-mode`. The
  agent reads a real file, writes a real table, and meets an exact column contract.

  **This introduces the repository's first deliberate skip, and it weakens a rule that was
  absolute.** `reachable.ts` says in its own words that a missing CLI is never skipped, because a
  green run without one reports on a path nothing exercised. That is still true of everything else.
  It is no longer true here: on a machine with only one CLI installed, `pnpm test:live` goes green
  with the other runner's invocation never run.

  The alternative is worse in a way that is easy to check: requiring both would make a machine with
  one CLI unable to run the suite at all, which is the exact wall this change exists to remove. So
  the skip is announced rather than silent — the absent runner gets its own named block in the
  output saying it did not run. An announcement in test output is a weak guard, and it is the one
  chosen. **A run of this suite is evidence about the runners that machine has, not about both.**

- **Restoration against the real DataHub**, added to `engine.live.test.ts` on 2026-07-24: from a
  flagged pipeline with four marks standing, one deterministic identical redo of the middle task
  cleared exactly the two transitive marks, held the direct reader of the changed table with its
  tag still on (read back off `globalTags`, not inferred), left the cleared tasks' fingerprints and
  finish times untouched, and carried the reason on each entry. The changed-redo negative runs
  beside it: a redo landing a different table restores nothing and cascades instead, fresh marks
  naming the redone table. The identical re-run on a flagged pipeline now also asserts
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
    `redid 3 of the 3 flagged task(s) in 93.7 s`, exit 0, page clean. obsel was right at every
    step; the averaging precision is now pinned in `pipeline.py`, the third instruction pinned for
    the same class of reason.
  - **The second, after the pin, is the money moment.** One Codex session redid `build_revenue`
    over the renamed table, the output came back byte-identical, and obsel cleared the other two
    itself, each with its reason: `redid 1 of the 3 flagged task(s) in 30.0 s`,
    `obsel cleared 2 without a re-run: write_docs, write_report`, restoration confirmed end to end
    in a measured 1035 ms, the step exiting 0 in 30.2 s. Both runs' closing claims were read back
    from the page, not assumed from the loop ending.
- **The two animated captures**, `docs/images/cascade.gif` and `docs/images/repair.gif`, recorded
  2026-07-24 in one sequence by `scripts/record.mjs`: the real launch route, the live page, the moment
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
- **The page naming its agents in words, and narrating its own work**, on 2026-07-23 against a live
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
- **The rebuilt page, measured rather than eyeballed**, on 2026-07-23 against the same live DataHub
  and Codex CLI. `run` took **143.1 s**; the rename was called **`schema`** and marked the same three
  tasks in a measured **3281 ms**. `GET /api/swarm` returned
  `columns: {"added":["order_total_usd"],"removed":["order_total"]}` on all three marks, including
  the two at two hops that never read `clean_orders`, and the changed node rendered
  `clean orders / - order_total / + order_total_usd`. In the browser at 1920 x 990: 9 nodes, 8 edges,
  exactly **6 of them animated** (the cascade path), stable across ten samples over four seconds,
  with the animation reporting an unbounded iteration count and a `stroke-dashoffset` still advancing
  between samples. **238 words** on the page, **zero em dashes**, no horizontal scroll, whole page
  inside the frame. Three defects were caught by measuring rather than looking, none of which was
  visible in a screenshot of a freshly loaded page: React Flow drew **zero edges** while the poll
  replaced its node array every second; the log strip beside the graph squeezed node labels to
  **8 px** on a 1280 laptop; and `fitView`, which runs once on mount, left the graph framed against
  a stale panel size, so after a resize all nine nodes sat outside a panel that clips its overflow.
  All three are fixed, each is written up in the code that fixes it, and the last is now asserted in
  `e2e/dashboard.spec.ts` across a resize.
- **The write-back, read back off DataHub**, on 2026-07-23 against the same live stack. From a reset
  page: `run` took **140.5 s** for four Codex sessions, then `change` was called **`schema`** and
  marked three tasks in a measured **868 ms**. `GET /api/swarm` reported
  `tags: ["urn:li:tag:obsel-stale"]` on exactly those three and `tags: []` on `clean_orders`, which is
  the cause rather than a casualty, so the ribbon read **`3 of 3 tagged`** beside the detection time.
  Clicking a flagged node showed the tag and a link resolving to
  `http://localhost:9002/tasks/urn:li:dataJob:(...,build_revenue)`. `POST /api/demo/reset` then
  reported clearing properties on all four and the tag from all three, after which every task read
  `tags: []` and the cell reported **nothing to write** with nothing left over. The page measured
  **251 words**, 96 of them prose, **zero em dashes**, whole page inside 990 px with no scroll.
  **Not observed live:** the moment between the mark landing and the tag landing. Polling every two
  seconds, the page went straight from having nothing to write to `3 of 3`, so the asynchronous window is
  shorter than that in practice. The partial count is covered by a unit test and a browser test
  against a fixture, not by a live sighting, and the ribbon is worded as a count for exactly that
  reason.
- **One flaw found by reading the rendered page rather than the code.** The ribbon lowercases its
  labels, which was fine until a label carried DataHub's name: the cell crediting DataHub rendered as
  "written into datahub". `StatCell` now takes `preserveCase`, used only there.
- **The whole demo, driven from the browser alone**, on 2026-07-22 against a live DataHub and a
  signed-in Codex CLI, in five clicks in the guide with no terminal: reset, then re-declare (which
  wrote each task's job description onto its DataJob and read it back onto the page in a
  measured **506 ms**), then `run`, four Codex sessions in **112.2 s**, watched live as
  "in flight for N s", then the identical re-run, which obsel answered with **0 changed outputs
  and 0 marks, confirmed in 106 ms**, then the upstream rename, which obsel called **`schema`**
  and answered by marking exactly `build_revenue` (1 hop), `write_docs` and `write_report`
  (2 hops each) in a measured **2310 ms**. Every step exited 0 with its own assertions passing,
  and the page followed each transition within a poll. As a cross-check that the guide derives
  from state rather than following a script, the final `reset` was run from a terminal instead,
  and the page tracked it identically.
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

- **The page showing an agent while it works.** During the second run the page reported
  `clean_orders` as `in flight for 12.7 s`, then 20.7 s on a later poll, and after it finished
  `codex-cli 0.144.4 · 43.9 s · 39 rows · order_id, customer, order_total, order_date`, which were the
  same figures the terminal printed. Before this, obsel was told an agent had started only after its
  work was already over, so the page said "waiting" throughout.
- **The MCP write path**, by round trip: apply the tag, confirm it through GraphQL, remove it,
  confirm removal.
- **The existence predicate and swarm enumeration**, by curl against the live instance.
  See [`docs/environment-findings.md`](environment-findings.md) sections 1 and 9.

- **`readSnapshot` now reads the whole swarm in one `batchGet`, adopted 2026-07-24.** The
  2026-07-23 entry here recorded the per-task version's linear request count as a risk and the
  batch endpoint as researched but not worth adopting before a submission. The forty-task swarm
  changed that arithmetic: the page polls every second, and forty tasks would have put ~41
  requests per second on DataHub to render a screen. The endpoint adopted is the one already
  verified safe (`POST /openapi/v3/entity/datajob/batchGet` carries every aspect obsel reads and
  omits an invented URN rather than fabricating one, re-confirmed against this instance with a
  real and an invented URN before the switch). A URN the graph lists that the batch does not
  return is still an error, never a silent skip. Measured 2026-07-24 with the forty-task flow
  registered, five samples during a live concurrent run: 197, 274, 65, 65 and 54 ms, the first
  two including route warm-up. One `/relationships` call plus one `batchGet` per snapshot,
  regardless of swarm size, against the previous one-per-task.

- **The forty-task swarm, live, the whole loop, on 2026-07-24.** One sequence against a live
  DataHub with a live Codex CLI, on an isolated flow, every closing claim read back from the page
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
  - **The parallel repair.** From the 8-flag page, `scale-repair` redid the five direct readers
    concurrently and cancelled the other three out of its own plan as proofs landed:
    `weekday_profile`'s identical redo cleared `rider_overview` and `report_riders`,
    `fare_summary`'s cleared `revenue_overview`, each cancellation printed with obsel's reason.
    `docs_marts`'s redo correctly came back different, since its prose documents the renamed
    column, and being a leaf it cascaded to nothing. **Redid 5 of 8 in a measured 42.4 s** against about
    188 s to redo all eight, that baseline estimated from each task's last measured run and
    labeled as an estimate everywhere it appears. The page ended with zero flags, read back from
    DataHub.

- **A second full cycle on the same page, and three rules confirmed by accident, 2026-07-24.**
  Run while recording the browser fixtures, which is why it is here: these are observations from
  work with another purpose, not a benchmark set up to produce them.
  - **An identical re-run at forty tasks marked nothing.** `scale-change` was run against a page
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
  - **The forward change, a second time.** `daily_trips` renamed the column on a settled pipeline:
    **9 of 40 marked out to 3 hops in a measured 3968 ms**, 30 tasks outside it and none flagged,
    all nine tags confirmed in DataHub. This is the run the browser fixtures were recorded from.

- **`scale-change` now renames whichever way the page sits, proven live in both directions,
  2026-07-24.** The step used to be one hard-coded direction, and a repair never touches the task
  that causes the cascade, so pressing the settled pipeline's own button a second time in a session
  reproduced the table byte for byte and the step failed its own descendant assertion; obsel was
  right every time and the demo was wrong, observed three times. The step now reads the producer's
  recorded run columns off the page and renames away from wherever they sit
  (`scale.change_for`), with the choice printed in words before the agent runs. Five new
  self-checks pin the chooser and the mirror property. Live: the forward press marked the nine
  descendants at their exact hops with the schema kind and the right column diff, and the reverse
  press then exited 0 on its first attempt, printing "the passenger column is passenger_total on
  the page today; this run renames it to riders" and marking **the same nine at the same hops out
  to 3**. The final repair settled the page with zero flags and zero tags, read back. The
  mid-swarm form stays forward on purpose: it lands on a page that just ran the original
  instructions.

- **A night of load found two real operational bugs, both fixed and both now tested with real
  hostile input, 2026-07-24.** DataHub slowed under hours of forty-task runs, and two things broke
  that a quiet afternoon had never exposed.
  - **A client timeout on a completion that landed.** A cascade's coordination outran the worker's
    60 s HTTP ceiling; the server finished the work, every mark correct, and the worker declared
    the run dead: the operator told the opposite of the truth. Verified by read-back at the time
    (nine marks at the exact expected hops with the client having reported failure). Every
    mutation call now gets a 300 s ceiling (`MUTATION_TIMEOUT` in `agents/obsel_client.py`, used by the
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
  step's writes to whatever was listening on 3000. With an operator's page and an isolated one
  both up, the isolated page's reset button reset the operator's flow, and its register button
  put one foreign task into the operator's pipeline before the step's own URN-mismatch guard
  stopped it at a single task. The launch route now passes its own origin (from the URL Next
  resolved, never from a client header) into the child's `OBSEL_URL`, so the child reports to
  the obsel whose button was pressed, whatever its port. Validated live by re-running the same
  two steps on the isolated port with the fix in place: both exited 0 against the isolated flow
  with the operator's page untouched. The operator's flow was restored through the ordinary
  demo path, and the one foreign task's soft delete is left as an owner action, the command
  dry-run verified.

- **The demo has a capture harness, and a reference picture lock exists, measured by ffprobe,
  2026-07-24.** `scripts/video.mjs` records the whole take in one shot through the real guide buttons: it
  refuses a page that is not forty registered tasks, clicks the swarm and the repair with a
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
  scrollable. Measured on the live page: six clicks reach zoom 1.5 with labels at **19.5 px**,
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
  The first forty-task pipeline rendered cut off at the top and bottom: `fitView` has a 0.5 zoom
  floor it clamps at, and the fixed 320px panel needed roughly 0.38. The panel now takes its
  height from the laid-out graph (`panelHeightFor` in `lineage.tsx`), the page scrolls when the
  page genuinely cannot fit the frame, and the four-task demo keeps its exact previous geometry.
  Measured after the fix at 1920 x 990: pane 1758 x 845, zoom 0.58, zero nodes clipped in either
  direction.

- **Growing the graph panel starved the panels under it, found by the owner and fixed the same
  day.** The strip below the graph holds the details panel and obsel's own narration, and it is
  `flex: 1 1 0` with a 172px floor. That pairing is what makes the four-task pipeline work: the graph
  takes its fixed height first and the strip absorbs whatever the frame has left, so a taller
  display grows the step list rather than a black gap. All of it depends on there being slack.
  A tall page has none, so the strip resolved to its floor exactly, and the fix for the clipping
  had quietly made the panels beneath it as small as they are allowed to get.

  Measured at 1920 x 990 before: trace panel 172px, its scroller 105px, three of eighty-six steps
  legible, the details panel beside it identical. After, with the strip sized rather than fitted
  on a tall page: **panel 396px, scroller 329px**, both panels showing a full decision group and
  the whole detail list without scrolling at all. The laptop comes out at 360 and 293 against the
  clamp's floor. Nothing about the four-task pipeline changed, which the browser suite checks by
  comparing the two rather than by pinning a number.

  A pinned ribbon was tried for the same complaint, the measured detection time sitting at y=1338
  in a 990px viewport, and rejected. `position: sticky` does put it on screen, and it also lays a
  62px bar across the bottom row of the graph at every scroll position: mmux's surface token is
  2.5% cream, so the first attempt was transparent and the nodes read through the number, and
  making it opaque only makes the covering honest. Hiding a row of the picture to save one scroll
  to the conclusion is the wrong way round. It is written up in `dashboard.module.css` so it is not
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

- **The forty-task pipeline is browser-tested, against two recordings of a real one, 2026-07-24.**
  `e2e/scale.spec.ts`, 13 tests, run at both viewports: **103 browser tests pass, 1 skipped,
  exit 0**, up from 78. Its fixtures are the difference worth stating. Every other fixture in that
  suite is hand-written and says so; these two are `GET /api/swarm` as the server sent it, captured
  a minute apart off the live page on flow `obsel_scale_v2`: forty finished Codex sessions with
  nothing marked, then the same page after `daily_trips` renamed one column, carrying the nine
  marks obsel wrote and the nine tags DataHub confirmed. A hand-typed forty-task graph would be a
  hand-typed claim about the layout these tests exist to check. They are read through a structural
  type check plus a runtime check of the three unions and every mark's cause, so a capture of a bug
  cannot pass as a fixture.

  What the browser establishes that nothing else did: no node clipped on either page, at either
  viewport, across a shrink to 1100 x 620 and back; eighty-two boxes with not one overlapping pair
  in pixels; no sideways scroll; exactly the recorded nine painted amber and no other, matched task
  by task against the capture, with the amber proven to still resolve to a colour; all three hop
  distances present, one task at three hops; the three-hop reason opening in full, naming the task
  in between in words; the changed table showing `riders` leaving and `passenger_total` arriving;
  and both scale buttons clicked, launching `scale-change` and `scale-repair`.

  Confirmed the same day against a live read rather than a recording, on a server pointed at the
  real flow at 1920 x 990: 82 nodes, **zero clipped**, pane 1758 x 846 at zoom 0.578, document
  width equal to the viewport so nothing scrolls sideways, page height 1411 so the tall page
  scrolls down as designed, 18 cascade edges lit, and no console error.

- **The page's word ceiling was measuring the wrong thing, and the correction moved the numbers.**
  Rescoping it for forty tasks turned up a defect in the measurement itself. `prose` is a
  subtraction, everything on the body less the parts counted separately, and the graph was being
  counted with `textContent` while the body used `innerText`, so each node ran its title into its
  status word and handed prose one word per node that was not prose. Nine nodes made that look like
  rounding; eighty-two made it a paragraph. Corrected in `e2e/fixtures/words.ts`, which both suites
  now share so the two pages are measured identically.

  Measured at 1920 x 990 after the correction: the four-task flagged pipeline is **147 words of prose**
  (recorded as 154 before, with no copy changed) and the forty-task flagged pipeline is **135**. Ten
  times the pipeline, twelve words fewer, because the taxi stage offers two actions where the demo
  offers three and every other sentence is the same sentence with different nouns in it. The graph
  left the combined total, which is a correction and not a relaxation: labels are scanned, there is
  one per box, and the box count is the user's pipeline rather than obsel's to budget. It is capped
  per node instead, at 9 against a worst observed 8. `scale.spec.ts` asserts the two pages' prose
  figures against each other rather than against a constant, so the claim that density does not
  track pipeline size is checked rather than assumed.

- **The prerequisite checklist reported four green ticks while obsel was completely blind.**
  Found on 2026-07-24 by opening the page cold. It showed "This page lost its connection" over a
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

  **The page's dead end closed with it, and no page code changed.** The connect stage already
  renders a failing DataHub check with its fix; it had nothing to render because preflight was
  reporting success. With the truth reaching it, the same screen that had offered a newcomer no
  next step now carries the failure and `Run this in a terminal: datahub docker quickstart`.
  Recovery measured the same session: `docker start datahub-opensearch-1` reported healthy in about
  20 s and the page came back on its next poll about 3 s later, with no data lost, because the
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
  copy button, and the six tools with what each is for. Measured on the running page at 1440 x 900
  before it was replaced: **12px type in a 17px row**, closed, above the graph. He wrote its
  contents. A door its own author cannot find is not a door, and no amount of correct content
  inside it changes that.

  It is `src/features/dashboard/joining-panel.tsx` now, an mmux `Panel` under the graph and above the
  numbers, which is the order a judge reads in. Measured after: a **75px panel with a 13px
  heading**, a state line beside it, and a line inviting the click.

  What it gained is a checklist that ticks itself off, derived the way every other sentence on the
  page is derived. `src/features/dashboard/joining.ts` recomputes four steps from the swarm snapshot
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
  reporting two tasks of its own. The page was read after each step:

  ```
  1. both registered            clean_expenses registered   monthly_totals registered
     writes=obsel_demo.clean_expenses      <- the URN that broke the first classifier
  2. the cleaner announced      clean_expenses running
  3. both reported              clean_expenses complete     monthly_totals complete
  4. one column renamed         clean_expenses complete     monthly_totals stale FLAGGED
  ```

  The panel read **4 of 4** with every step naming the visitor's own registered title: "Expense
  cleaner is on the graph, with its tables wired to it", through to "obsel has seen Expense
  cleaner's table change since it was first recorded". The headline above it read "1 of 2 finished
  agents are out of date". Somebody else's two agents, on a real DataHub, with obsel answering.

  The demo flow on port 3000 was confirmed unchanged across the whole exercise, which is the check
  the launcher-origin incident earlier the same day earned.

  Measured cost to the page's prose budget: **147 words to 155**, ceiling 160. Twelve words bought
  the heading, the state line and the invitation, less the four the old disclosure spent. Everything
  behind the fold still costs nothing until opened, and `joining.ts` keeps it folded on exactly the
  page the ceiling measures. Counts after this work: 298 unit tests across 14 files, 76 live across
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
  `restoredBy` back to last-writer-wins clears `write_report` and `write_docs` on a page where the
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
  commit in this repository finds no such measurement, and the largest cascade the scale page can
  produce is nine marks, not forty-eight, so the figure cannot have come from the scale runner
  either. **It has been removed rather than re-measured, because it was never obsel's measurement to
  begin with.** What justifies the fix is the structure above, which anyone can check out and read.
  The rule this violated is the project's own: a claim must name its evidence.

- **`resetSwarm` could not clean up the state that most needed cleaning.** Found while fixing the
  above, not reported by any review. It decided what to untag from obsel's own properties rather
  than from the tags DataHub actually holds, so a task whose properties were cleared while its tag
  survived was walked straight past — and that is exactly the disagreement a reset exists to remove.
  One was left in the integration flow by the run that measured the concurrency defect, and every
  later run started on a page carrying a flag from a take that was over. Now filtered on
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

### The door an agent joins the erasure view through (2026-07-26)

`agents/mcp_server.py` now registers **nine** tools rather than six: `erasure_board`,
`request_challenge` and `submit_attestation` sit beside the swarm's original set. Every mutation
still goes through obsel's HTTP API, so the server holds no DataHub credentials, and the decisions
live in `agents/mcp_core.py` and `agents/mcp_erasure.py`, where `pnpm verify` checks them with the
system `python3`.

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
  and every one came back `UNPROVEN` with `no-attestation`. That is the honest day-one page.
- The same walk seeded from the **postgres** copy of the same table reaches **1 asset**, because
  DataHub records no downstream edges from it. The report says `assetsReached: 1` rather than
  implying a small estate, which is the assurance field earning its place.
- One real Ed25519 keypair, one challenge, one signed direct attestation over
  `snowflake … analytics.order_details`, submitted to `POST /api/erasure/proof`: **1 of 23 attested,
  22 unattested**, `evidenceRecords` 1 → 3, and the sentence the page prints is
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

**Still not built, and named rather than implied.** No demo agent yet drives the erasure view end to
end on its own: the live run signs its attestation directly rather than routing work to an owner and
waiting. **There is no coverage page**, so the panels a judge sees are still the staleness ones —
with one correction made after actually looking at the running dashboard on 2026-07-26: the "what
obsel is doing" trace panel already carries erasure, because `erasure-engine.ts` emits into the same
activity stream the coordinator does. Opening a request, issuing a challenge, accepting an
attestation and refusing one all appear there live, the refusal in the same colour a stale mark
uses. That is narration of the erasure path, not a view of coverage; the 23-asset page itself is
still only reachable as JSON from `GET /api/erasure/<id>`.
The demonstration script for the erasure path does not exist. Article 19 recipient notification is
out of scope and stated as such. No cascade timing figure is claimed at scale; see the correction above for why the one previously printed here was withdrawn.

### Registering your own tasks from the page, and the bug driving it found (2026-07-26)

The bring-your-own-data panel: a form for the one half of "point obsel at my own files" that is pure
declaration. Until it existed the only route was the MCP walkthrough in
[`setup.md`](setup.md#bring-your-own-data), which is five steps of hand-written JSON before anything
appears on screen, and nothing on the page said the route existed at all.

**What it is not.** It does not report work, and there is deliberately no route by which the browser
could. A fingerprint is taken from rows by `agents/fingerprint.py` through
`worker.canonicalise_numbers`, and a second implementation of that in TypeScript would be a second
definition of what counts as a change — which breaks the first correctness rule in
[`CLAUDE.md`](../CLAUDE.md), that an identical re-run must mark nothing, in the one way no test would
notice until the two disagreed by a byte. The panel POSTs to the agents' own
`POST /api/tasks/register` rather than a route of its own, so a task typed into the form and a task
an MCP client registered are the same entity.

**Driven by hand against a real DataHub**, on `OBSEL_FLOW_ID=obsel_ui_check` so the run could not
touch the operator's page, serving the production build:

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
page with nothing on it, so the first registration flips that derivation to folded — and the
`chosen ?? expanded` idiom borrowed from `joining-panel.tsx` does not save it, because at the moment
the reader opened the panel it was already open. Their choice matched the derivation, so nothing was
recorded, and one poll later the panel closed under somebody who was about to register the second
half of their pipeline.

That is the same toggle rule from the other direction: the joining panel's version was written
against a panel that _refused to close_, and it is exactly right there. What it cannot express is
intent, and a form is a place where the reader has intent. The fix records the fold on a successful
registration, which is an action the reader took rather than a state obsel inferred; closing it by
hand still hands control back to the derivation. Pinned by
**"stays open after a registration, rather than shutting on the reader"** in `e2e/dashboard.spec.ts`,
which fails on the code as first written.

**The word ceiling moved, 160 to 168, and it was argued rather than raised.** The panel costs 7 words
always painted: 4 of heading and 3 inviting the click. Two cheaper shapes were rejected and one was
taken, all recorded at the assertion in `e2e/dashboard.spec.ts`. Nothing was excluded from the
bare-identifier or em-dash guards to make this fit: both passed unchanged, which was checked rather
than assumed.

Counts after this work, measured 2026-07-26: `pnpm verify` green with **394 unit tests across 18
files and 183 Python self-checks**; `pnpm e2e` green with **139 browser checks across two viewports
in 41 s**, one skipped by design. `pnpm test:live` was not re-run for this change and its 96 tests
are unaffected by it; no live test covers the form, and the run above is a single observation on one
machine rather than a suite.

**Still not built at the time of writing.** Reporting a file from the page, which is the other half
and the one that would let somebody watch a cascade on their own CSV without an agent. It needs one
definition of how a CSV becomes rows, shared with the agents rather than private to the UI, and that
is a decision about what obsel considers a table. Half of this is now built and the half that is not
is still the file: see **the bench**, below.

**A name that builds an unreadable URN is now refused at both doors**, landed the same day in a
separate worktree. The route checked names for being non-empty and nothing else, so `clean,orders` or
`a.b.c` created a real DataJob whose lineage pointed at a URN no reader could recover the name from:
`datasetUrn` interpolates the name, and `datasetName`, `shortName` in the page and
`dataset_short_name` in Python all split back on commas and dots. The page drew a box with a
truncated name and nothing downstream could tell. `NAME_PATTERN` in `urns.ts` is now applied by
`register-body.ts`, mirrored in `agents/mcp_core.py`, and `tests/register-body.test.ts` reads the
pattern out of the real Python module and asserts it identical, the way `tests/urns.test.ts` does for
the two URN builders.

The page's form keeps its own copy, because browser code here does not import server modules, and
`tests/dashboard-your-data.test.ts` holds the two together by comparing the form's verdict against
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
page could register one at a time, and every sentence that counts something had been written for the
plural.

Two of those were wrong at counts that needed no new feature to reach. The flagged headline and
`summaryLine` both keyed their **noun** to the marked count when it belongs to the finished count, so
**"1 of 3 finished agent is out of date" was reachable on the demo page** — the ratio's own
denominator contradicted by the word after it. The noun counts the finished work; only the verb and
the pronoun count the stale part. `agreeing` in `naming.ts` deliberately does not print the number,
because half these sentences put the count elsewhere in the clause than beside the noun it governs,
so a helper owning the number could serve only the easy half and the hard half is where the bug was.
Every stage that counts something is now checked at one rather than only the stage that broke, since
zero, four and forty all pass a sentence written for the plural, which is how it survived.

**A one-task pipeline is now rendered in a browser too**, which the merged work did not cover: its tests
are all unit-level over `guide()` and `summaryLine()`, and the state had no fixture. `justOne()` in
`e2e/fixtures/swarm.ts` gives the three states a count of one can be in, and "a swarm of one" in
`e2e/dashboard.spec.ts` asserts no sentence anywhere on the page says `1 agents` or `all 1`, or glues a
singular noun to a plural ratio. It reads the live region's `textContent` as well as the page's
`innerText`, because a visually-hidden sentence is the one most likely to be left plural: nothing but
a screen reader ever reads it. Mutation: restoring the counted form in `registered()` fails that test
on both viewports, checked rather than assumed.

Counts after both merges, measured 2026-07-26: `pnpm verify` green with **424 unit tests across 19
files and 183 Python self-checks**; `pnpm e2e` green with **145 browser checks across two
viewports**, one skipped by design. `pnpm test:live` was not re-run for any of this work; its 96
tests are unaffected, and no live test covers the form.

### Reporting a table from the page, and the two things driving it exposed (2026-07-27)

The bench: the other half of the panel above. A task you registered opens an editable table — the
columns are chips you can rename, drop or add, the rows are cells you type into — and one button
hands it to obsel. That is the whole loop, register through flag, without Codex and without a
terminal.

**Why this was the gap.** Every path to watching obsel do the thing obsel is for went through
something the reader might not have: four real Codex sessions and several minutes, or an MCP client
wired up from a terminal. Somebody with neither could read the page and never make it move.

**The browser still does not hash anything, and that constraint chose the design.** The button POSTs
to `POST /api/tasks/report`, which spawns `agents/report.py`, which calls the same
`mcp_core.completion_body` the MCP door calls, which canonicalises the numbers and hashes through
`agents/fingerprint.py`. One implementation, reached by one more road. A TypeScript port would agree
on the day it was written and drift on some later one, and the drift would be silent: the same table
reported from the bench and from an agent would disagree, and obsel would announce a change nobody
made. About 200 ms of process start is the price of there being one answer.

**The file question is still open and is still the right question.** Nothing here decides how a CSV
becomes rows, because nothing here reads a file: the reader types the rows, so there is no parsing
decision to get wrong. What is built is the reporting path; what is not built is the file.

**Why the columns are a control rather than a textarea.** The chips are the `columns` array that
`schema_fingerprint` sorts and hashes, so dropping a chip genuinely drops a column. The reader is not
pressing a button that pretends a change happened; they are editing the thing the hash is computed
over. A "simulate a change" button would have been a stand-in for the one event this repository is
about, in the one place a newcomer is looking.

**Driven by hand against a real DataHub**, on `OBSEL_FLOW_ID=obsel_bench_check` so the run could not
touch the operator's page:

- `clean_expenses` (reads `expenses_csv`, writes `clean_expenses`) and `expense_report` (reads
  `clean_expenses`, writes `expense_report`) registered through the form above.
- Both reported from the bench with three columns and three rows. Read back off `GET /api/swarm`:
  both `complete`, nothing flagged. The negative case, and the one that has to come first.
- `amount` renamed to `amount_usd` in the upstream chip and reported again. `expense_report` came
  back **`stale`**, `hops: 1`, reason `read clean expenses, and its columns changed after this
finished`, and `columns: {"added":["amount_usd"],"removed":["amount"]}`.
- The page followed: headline **"1 of 2 finished agents is out of date"**, subline naming the column
  that left and the one that arrived, the graph amber along the path, the trace panel reporting
  **6519 ms end to end**, and the joining panel's four-beat checklist at **4 of 4** — every beat
  driven from the bench rather than from a terminal.

**The first thing it exposed: a completion could not carry a shape without carrying a duration.** The
`run` object required `runner`, `ms` and `outputs` together, so a reporter with no stopwatch had to
omit all three. The bench has no stopwatch — a person typed the table, and there is no run to time —
and inventing a millisecond count is the one thing obsel is not allowed to do. But `outputs` is not
display material: `columnChange` in `engine.ts` diffs those column lists to say **which** columns
moved, so dropping them degraded "clean expenses lost amount" into "the columns in clean expenses
changed", quietly, on exactly the mark the whole page is built to make readable.

`runner` and `ms` are now independently nullable, end to end: the zod schema defaults them to null
rather than leaving them optional, `engine.ts` writes each property on its own rather than gating all
three on the object, `parseRun` in `client.ts` no longer discards the shape when the other two are
absent, and `activityNote` prints neither rather than printing `0 ms` — a figure nobody measured is
the thing obsel refuses everywhere else. The self-check in `agents/mcp_core.py` that asserted the old
all-or-nothing behaviour now asserts the shape survives and the unmeasured halves are null.

**The second thing it exposed: the guide offered buttons that act on tables not on the page.**
`swarmKind` in `guide.ts` has always documented that a swarm which is neither obsel's demo nor its
taxi pipeline "gets the actions that are safe anywhere and no pipeline-specific ones", and the code
never implemented it — an unrecognised swarm fell through to the demo's buttons. Before the bench
there was almost no way to reach a flagged pipeline made only of somebody else's tasks, so the gap went
unnoticed; the existing test recorded it as a fallback that was "honest only while its labels name
their own scope". They do not. **"Run the orders cleaner again" was on screen on a page with no
orders cleaner**, beside "Redo the work obsel flagged", which would have started the demo's agents
against the demo's tables while pointing at somebody else's flag.

`registered`, `settled` and `flagged` now withhold every pipeline-specific action on an unrecognised
swarm. `reset` survives, because `resetSwarm` puts every task on the flow back to registered whoever
registered it, so it means exactly what it says on any page. The settled line points at the bench
instead, which is the thing on that page that does what the withheld buttons would have done. Three
tests in `tests/dashboard-guide.test.ts` pin it, and the test that documented the old fallback now
asserts the new behaviour.

**The word ceiling did not move.** The bench renders inside the fold `mine.ts` already keeps closed
on every page the ceiling measures, so it costs nothing there; the per-task toggle that opens it
renders only when a task of yours exists, which is no page the ceiling measures either. `pnpm e2e`
passed unchanged, including the bare-identifier and em-dash guards, which was checked rather than
assumed.

Counts after this work, measured 2026-07-27: `pnpm verify` green with **454 unit tests across 20
files**; `pnpm e2e` green with **145 browser checks across two viewports**, one skipped by design.
`pnpm test:live` has **not** been re-run for this change, and the run above is a single observation
on one machine rather than a suite: there is no live test covering the bench, and that is the next
thing this section needs.

### The guide has a name and a position now, 2026-07-27

**The reported problem was not being able to find it.** The owner of this repository asked where the
interactive guide was. Nothing on the page was called a guide: the region's panel title
(`00 · guide — …`) had been removed for burying the headline, nothing replaced it, and the page gave
no sign that its stages are a sequence rather than a set of unrelated sentences. On several stages
the whole region is one sentence with nothing to click.

**The first answer was a rail of page states, and it did not work.** It drew five unlabelled ticks
with `guide 5/5` beside them, and put the stage names only in the rail's accessible description to
keep the page's measured word count flat. What that gave a reader was a position in an unnamed
sequence. The owner's response was that a judge would still be confused, which was correct twice
over: a position with no destination is a meter rather than a guide, and the rail also ran
**backwards**, because a repaired page goes from out of date back to settled, so the marker walked
back a step and the reader had to work out that going backwards was the good outcome. Both faults are
recorded at the top of `guide.ts` next to what replaced them.

> **Superseded on 2026-07-27.** The rail this section records was removed along with the two guides
> before it; the tour window described in the last dated section below replaced all three. What
> follows is the record of the attempt, kept because the reasoning it contains is why the next one
> was built the way it was.

**What was on screen after this work was the walk, act by act, named.** The rail above the headline
read
`guide  set up  run  same again  change  repair` — the demonstration `docs/demo-script.md` describes,
which is the one a judge is meant to see. Each act is something somebody presses, each proves one
claim obsel makes, and they only ever go forwards. The taxi swarm gets its own three (`set up`,
`run and change`, `repair`), because its run and its change are one step and forty agents make the
unchanged-re-run argument on screen in the same moment. A swarm that is neither pipeline gets no rail
at all: every act launches a step against obsel's own tables, and a walk drawn over somebody else's
page would describe work that is not on screen.

All mmux tokens and no new ones: the acts behind the page are `--mm-rose-muted` with quiet labels,
the current act carries a `--mm-rose-hot` cursor with the `--mm-glow-sm` glow and a cream label, and
the acts ahead are `--mm-cream-faint`. The last act while marks are standing is `--obsel-stale`
amber, the colour this page gives every stale mark, so the state the whole tool exists to report
never reads as the ordinary end of a run. The labels are 13px, not the 11px they started at, because
obsel's type floor exists for a compressed recording watched at half size and these are the most
load-bearing text in the region.

The region's accessible name is `guide` too, matching what is painted; it was "What just happened",
which named nothing a reader could see. Each act's claim — what pressing it demonstrates — is on the
rail's accessible description rather than painted, since five of those is a paragraph and the graph
underneath makes the same argument in a picture.

**The block is a composition rather than a stack, and that was the second complaint.** It was five
things flush left, each ending where its own content ran out: the rail at 46ch, the headline at
whatever the sentence measured, the line under it at 82ch, and a row of buttons each sized to its own
label. Four ragged right edges within 200px of each other, on a page where every other region is a
hairline rectangle. It is now two measured columns under one rail — what happened on the left at a
700px measure, what you can do about it on the right at 500px, the log under the sentence it belongs
to — with a hairline closing the block at the bottom, which it had never had. The buttons are a
column of equal controls instead of a row of unequal ones, and the width cap each one carried is
gone: the column does that job, and does it for one button as well as for three. Below 1100px the
grid becomes one column and the controls lay out in tracks, so a stage offering a single action never
renders it as a banner.

**The stages with nothing to press take the whole measure.** They are also the ones with the most to
say: `prepare` lists every prerequisite with the command that fixes it, and at the narrow measure the
`python3 -m venv agents/.venv && …` line wrapped across two while 800px sat empty beside it. The
section carries `data-actions`, and with no actions the sentence column widens to 1240px. Measured at
the recording viewport on the three-prerequisite page: every fix command on one line, and the block
40px shorter than before.

**Where the walk stands is derived on every poll, from two sources, and stored nowhere.** The page
answers most of it: tasks existing is `set up`, every task having finished is `run`, marks standing
is `change`. Two acts leave no trace on the page and only the step record can answer them, and both
gaps are honest rather than lazy — an identical re-run leaves the page exactly as it was, which is
the entire claim it makes, and a repair ends with a page that looks like one that was never changed.
So `src/server/runner/launcher.ts` now keeps an append-only, bounded record of finished steps, and
`journey()` reads the slice after the last successful reset. That slice is what makes the walk
**repeatable**: pressing reset really does put every task back to registered, and the rail agrees
with the page it is describing rather than staying complete forever after one run. A step that
exited non-zero ticks nothing, because a step that failed did not demonstrate its claim.

Two rules sit on top of first-undone, both because first-undone alone lies. Marks standing put the
walk at its last act whatever was skipped, since what to do about the marks is the only thing that
matters on that page. And a step that is running names its act outright, which is the strongest
evidence there is about where the walk has got to: it is happening. One limit is written down in the
code rather than papered over — a step driven from a terminal never reaches this server's launcher,
so `same again` will not tick from one. Every other act is carried by page state, which is visible
however it came about, and the demo script's own rule is that the judged demonstration is driven
entirely from these buttons.

**A completed walk says so and offers the way round again.** Settled with every act performed reads
"Every step has run. Reset to walk through it again." and puts the reset button first. Without it a completed
walk is indistinguishable from one that never started: the same settled pipeline, and a line underneath
telling the reader to try the things they have just finished trying.

**The animation is a library now, and that deleted more than it added.** `motion` (MIT, through
`LazyMotion` with `strict`) replaced three `@keyframes` blocks, a `calc()` stagger driven by an
inline `--i` custom property, a wrapper element whose only job was to mask the headline, and a
`prefers-reduced-motion` block restating every end state by hand. What it buys that the hand-rolled
version could not: the rail's cursor travels from one act's tick to the next by `layoutId`, which
means measuring both elements on every poll if written by hand. `AnimatePresence` gives the outgoing
sentence a real exit instead of a hard swap.

**The entrance runs on a change of act and at no other time**, and the test that proves it had to be
rewritten twice. The page is recomputed once a second, so an entrance driven by render would replay
once a second forever. `e2e/dashboard.spec.ts` samples `getAnimations()` under the guide every frame
through `requestAnimationFrame`, counting each distinct animation once: it asserts the entrance runs
on arrival, does not run again across three polls with the stage unchanged, and runs again when the
stage genuinely changes. The first two alone would pass for an entrance that never runs, which is why
the third is there. The earlier versions measured the wrong thing — `expect.poll` widened its
interval and missed a half-second entrance between samples, and an `animationstart` counter worked
only while the entrance was CSS keyframes and would have silently counted zero now that motion drives
it through the Web Animations API.

**Reduced motion renders the finished picture rather than a hurried animation.** motion's own
handling keeps opacity transitions, which is still an entrance; `useReducedMotion` decides whether
the animation props are passed at all, so under the preference the end state is the only state these
elements are ever given. The browser test asserts full opacity, no transform, no animation name, and
nothing in flight on the headline.

**The word ceiling moved, 168 to 176, and it was argued at the assertion.** The page measured 170
words of prose, up from 162: the word `guide`, which gave the region a name it had not had since its
panel title was deleted, and seven words naming the acts of the walk, less the `5/5` figure that came
off when named acts made counting unnecessary. That ceiling has since been removed; see the section
below.

Counts after this work, measured 2026-07-27: `pnpm verify` green with **470 unit tests across 20
files**; `pnpm e2e` green with **155 browser checks across two viewports**, one skipped by design.
Fourteen of the new unit tests are the walk's derivation, including the ones that would otherwise be
assumed: a step that failed, a page somebody else drove, the change pressed before the unchanged
re-run, and the reset boundary rewinding.

`pnpm test:live` has **not** been re-run, and there is one thing in this change it would cover that
nothing else does: the step record is written by the real launcher, and every test above supplies it
as a fixture. What the live suite would establish is that a real `agents.run` finishing appends what
`journey()` expects. The page's own halves are covered without it, since page state is read from
DataHub by the existing suites.

### The guide points at the page, and the page's word ceiling is gone (2026-07-27)

The complaint, in the owner's words: the guide "isnt interactive... this is literally just buttons
and a small rail on the top left". That was accurate. Pressing `change` turned three boxes amber on
the graph six inches below a sentence about the change, and nothing on the page connected the press
to the boxes. The guide could describe the page's state and never point at it.

> **Superseded on 2026-07-27.** The watch sentence and the rings this section records were removed
> the same day, along with the rail above; the tour window in the section below replaced all three.
> The measurement of _why_ they were too quiet is in that section, and it is the reason this one is
> kept.

**One derivation produced both halves.** `watchFor` in `src/features/dashboard/guide.ts` returned a
`Watch` carrying one sentence and the URNs of the boxes that sentence is about. The sentence is
painted in the guide's left column; the URNs go to `Lineage`, which rings exactly those boxes. They
come from one object, so the line and the rings cannot end up about different boxes. Same house rule
as everything else here: derived from the snapshot on every poll, no stored position, no diffing one
poll against the last, and a page somebody else drove to the same state gets the same line.

What each stage points at, and what it deliberately does not:

| page state                         | painted                                                              | ringed                                    |
| ---------------------------------- | -------------------------------------------------------------------- | ----------------------------------------- |
| registered                         | Each agent below is wired to the tables it reads and writes.         | nothing: the boxes appearing is the event |
| working                            | The ringed boxes below turn green as each agent finishes.            | the running agents                        |
| settled, after an unchanged re-run | Nothing below turned amber. Same table out, so obsel marked nothing. | nothing, and that is the claim            |
| flagged                            | The ringed boxes below are finished work built on that table.        | the changed table and every marked agent  |
| settled, after a repair            | The amber cleared below because the work was redone, not dismissed.  | nothing                                   |

Three properties are asserted rather than assumed. The origin comes from `currentChange`, the same
function `lineage.tsx` uses to decide which table gets the amber border, so a ring cannot land on a
different box from the one the graph calls the origin. The line never restates the subline above it,
which already names the columns that moved and counts the agents that never read the table. And an
unmarked agent on a flagged pipeline is never ringed: a ring is attention, and pointing at work obsel
did not mark, on the page that exists to show what it did mark, is the false positive the tool is
against.

**The rings are attention, never state.** `nodeTone` still decides what a box means and stays the
only thing that does; the ring's colour is handed in from that same tone, so an amber ring is amber
because the box is amber. A ring is `pointer-events: none` and sits 5px outside its box in the gap
dagre already leaves, so it cannot swallow the click that opens the details panel — a browser test
clicks a ringed box and checks the mark's reason opens.

**Motion drives the breathing, and reduced motion holds it still.** A second `LazyMotion` wraps the
graph, since the guide's does not reach React Flow's nodes; `domAnimation` there rather than the
guide's `domMax`, which is only needed for the rail cursor's layout projection. Under
`useReducedMotion` no animation props are passed and the ring renders at full strength. That is not
the same as a shorter animation: `globals.css` cuts every CSS duration to 0.01ms, so a keyframed ring
under the preference would land on whichever frame that is and could render nearly invisible.

Directly observed, at the recording viewport, on the flagged fixture: the four rings on `clean
orders`, `Daily revenue`, `Revenue report` and `Table docs`, with `Orders cleaner` unringed, and the
`watch` line under the headline in the same frame. On the live page at `localhost:3000` in its
registered state, the line reads `watch Each agent below is wired to the tables it reads and writes.`
with nothing ringed.

**The page's word ceiling was removed, at the owner's instruction.** It asserted `prose < 176` and
`prose + log < 269` on the flagged pipeline. It did real work once — the screen it was written against
was 604 words in two stacked panels of paragraphs — and what it became was a toll booth. Every
genuine improvement to the copy arrived as a failing build and a paragraph of argument written at the
assertion, and the ceiling moved anyway each time: 160, then 168, then 176. It measured the one
property of prose that has no relationship to whether the prose is any good. The five-act rail was
nearly shipped as unlabelled ticks to stay under it, which produced a position meter nobody could
read; the labels went on and the number moved. The owner's words: "i dont want word-salad in my UI,
but i dont think having a hard word-ceiling is helpful either."

What guards the same thing without a number to game, all still executed:

- **`more narration does not put more words on screen`** — the log panel is a fixed height, so a
  longer run cannot grow the page.
- **`scale.spec.ts`'s two-page comparison** — the forty-task pipeline and the four-task pipeline are
  measured in the same session at the same viewport, and their prose must stay within 25 words of
  each other. Density is a property of the page, not of the pipeline somebody points it at. The
  absolute `forty.prose < 160` beside it went with the ceiling; the comparison never needed it.
- **The per-node label cap** — a box label may not grow into a sentence. That is the actual
  word-salad failure, and it is a cap on one label rather than on the screen.
- **The em dash guard and the internal-name guard**, which are about how the page says things
  rather than how much. The internal-name guard is the one the ceiling could never have replaced:
  `venv: the agents' Python environment (agents/.venv) does not exist yet` is nine words and
  completely opaque, so a page full of identifiers scored _better_ on a word count than a longer
  one a stranger can read.

`e2e/fixtures/words.ts` stays, because the scale comparison still measures with it.

Counts after this work, measured 2026-07-27: `pnpm verify` green with **484 unit tests across 20
files**; `pnpm e2e` green with **159 browser checks across two viewports**, one skipped by design.
Fourteen of the new unit tests are the watch derivation, including the ones that would otherwise be
assumed: the unmarked agent left alone, a re-run that failed saying nothing, a repaired page reading
as repaired rather than as an unchanged re-run, and the reset boundary clearing the line.

`pnpm test:live` has **not** been re-run. Nothing in this change crosses a process boundary: the
watch is derived from the same snapshot and step record the guide already read, and both are covered
by the existing suites.

### A tour that walks you through it, and the three guides it replaced (2026-07-27)

Three attempts at a guide shipped and were rejected in turn, and the owner's verdicts are the record
of why: "isnt deliberate enough", then "if a judge saw this they would still be confused", then "this
is literally just buttons and a small rail", then "its too subtle, still". Each attempt was correct,
derived, tested, and none of them guided anybody.

**What was actually wrong, measured rather than argued.** On the live page, 97 of the 100 text
elements are between 11 and 14 px. The guide's act labels were 13 px at 52% opacity, its ticks were
3 px tall, and its "watch" sentence was 13 px at 56%: the thing meant to lead a stranger through the
screen was set at the weight of a legend caption and fainter than body text. Every fix up to that
point had added _information_ at footnote size. Two structural faults on top of it: the rail said
which act was current while three identically weighted buttons sat beside it with nothing saying
which one performed that act, and the node rings were 1 px on a graph built out of 1 px borders.

**What replaced them**, decided with the owner rather than guessed: a docked, draggable tour window,
opened from a button in the header, that teaches one thing at a time and lights the region of the
page it is talking about.

- **`src/features/dashboard/tour/steps.ts`** is the curriculum as data. Chapter one teaches the screen
  in four explanation steps, advanced by a next button. Chapter two walks the real demonstration in
  action steps, which **have no next button at all**: each quotes the real control by the label the
  guide is currently painting on it, and advances only when the page shows the thing happened. That
  absence is the honesty rule of the whole thing. A tour that could be paged past an action would
  sooner or later be describing a page that does not exist.
- **`tour/use-tour.ts`** stores two facts about the person and none about the page: whether they
  have met the tour, and which card they last had open. Where chapter two stands is derived on every
  render from the same snapshot the rest of the page is derived from.
- **`tour/tour-panel.tsx`** is the window. Drag by its bar through motion's `dragControls`, with
  constraints measured from the window's own height per step so it can never be put somewhere it
  cannot be got back from. Cards swap through `AnimatePresence` with `mode="wait"`; the window
  itself arrives on a spring, the one in obsel, because it is an object being put down rather than
  an instrument reading. The current step's region is lit imperatively with an `outline` and a
  glowing `::after`, chosen because `outline` draws outside the box so nothing on the page moves,
  and because it is the one visual property those inline-styled components do not set themselves.
- **The opener** is lit and breathing on a browser that has never met it, with "new here?" beside
  it, and quiet permanently after the first open or "not now".

**Two derivations came out of looking at real states, and both would have broken the demonstration
on camera.** A repaired page is clean and finished, which is exactly what a page that only ever
ran looks like — so "has anything been changed" reads false again the moment a repair lands. Taken
naively, a judge who had just finished the whole walk would be dragged back to "now change something
upstream", on a page where they already had, with no next button to escape with. Both the change
act and the repair act therefore consult the launcher's step record for the case the page has
forgotten, and the reconciliation takes the **last** action the page has done rather than the first
it has not. Known limit, the same one the rail before it recorded: a step driven from a terminal
never reaches this server's launcher, and `docs/demo-script.md` requires every step of the judged run
to be a button for exactly that reason.

**Directly observed**, at 1920x990 and on the live page at `localhost:3000`: the opener lit on a
cleared browser and quiet after a reload; chapter one walked end to end with the glow moving guide →
graph → trace → numbers; an action step showing `press this, glowing on the board` above the real
button label, `waiting for you`, and no next control, with the matching page button outlined; a
running step showing `The instruction change` and a live green dot; the window dragged 120 px left
and 200 px up and staying there.

**What came out**, all of it replaced rather than kept: the five-act rail and its travelling cursor,
the `watch` sentence, the node rings and the `watch` prop threaded through `lineage.tsx` and
`nodes.tsx`, and `journey()` in `guide.ts`. The guide block keeps what is genuinely the page's —
headline, subline, action buttons, prerequisite checks, live log — and the tour points at those
rather than duplicating them. `settled()` still needs to know whether the page has been all the way
round; it now asks `performedSteps` for a repair directly instead of asking the walk.

Counts after this work, measured 2026-07-27: `pnpm verify` green with **470 unit tests across 20
files**; `pnpm e2e` green with **163 browser checks across two viewports**, one skipped by design.

`pnpm test:live` has **not** been re-run. Nothing here crosses a process boundary: the tour reads the
same snapshot and step record the guide already read, and both are covered by the existing suites.
Chapter two has been exercised against fixtures at every point, and **not** against a live four-agent
run from end to end. That is the one gap: a real run would confirm the action steps advance off a
real launcher's record rather than off a fixture's, and it is several minutes of real Codex sessions.

### A launcher, and the contradiction a stopped server exposed (2026-07-27)

Setup before the page was four documents that disagreed in scope: three commands in the README,
eight steps in `setup.md`, four prerequisites in `agents/README.md`, nine preflight rows in
`demo-script.md`. Following any one of them left something out, and the first prerequisite of all,
the `datahub` CLI, had no install command written down anywhere except in passing in
`upstream-contributions.md`.

`scripts/start.sh` is those steps in one order, reached on macOS by double-clicking
`scripts/Start obsel.command`. The ordering is the part that is not a convenience: registering obsel's tag
and starting the app both only work once DataHub is answering, and a numbered list gives the reader
no way to know that the wait in step 1 is load-bearing.

**Measured on this machine, 2026-07-27.**

| run                                                                          | result                                                                                                                                                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fresh, with `.env.local` and `agents/.venv` deleted                          | **16 s** from start to obsel answering on `:3000`. Page loaded, all five prerequisites green.                                                                                         |
| re-run, everything in place and the server already up                        | **2.794 s**. Skipped DataHub, kept `.env.local`, kept the virtual environment, did not start a second server. `agents.run setup` re-ran and confirmed both entities readable in 3 ms. |
| `env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=$HOME`, the Finder condition | nvm loaded, Node v24.18.0 found, run continued. Without the `PATH` repair this machine reports Node missing while having it, which is the worst answer available.                     |
| the same with `HOME` pointed at an empty directory, so nvm cannot be found   | refused at step 2 against the real Node **v22.14.0** in `/usr/local/bin`, naming the version and the download. A genuinely wrong Node, not an arranged one.                           |
| `DOCKER_HOST` at a socket path that does not exist                           | refused at step 1, exit 1, created nothing. Automated in `tests/start-script.test.ts`.                                                                                                |
| the wrapper started from another directory                                   | reported the folder it lives in, not the working directory. Automated in the same file.                                                                                               |

Both `uvx --from 'acryl-datahub==1.6.0.15' datahub --version` and that command's
`docker quickstart --help` were run before the script was written around them: the CLI resolves and
the subcommand is real. This is what closes the missing-install-command gap, since it needs nothing
installed permanently.

**The contradiction.** Stopping the dev server to take the timing above put the page into the state
a judge meets whenever obsel is not running, and the owner read it off the screen. Two reads fail
together there, and each had its own reporter that did not know about the other: `guide-panel.tsx`
said "The page below is unaffected" and `dashboard.tsx` said "Everything below is from the last read
that worked, at 22:58:36, and may already be wrong", one paragraph apart. Both cannot be true, and
the first is the false one. It was written for the case where only the activity read fails, which is
real and where the sentence is correct and useful.

The condition is now "this read failed while the other one is working" rather than "this read
failed", so a stopped server is one fault with one report. A second duplicated sentence went with it:
the alert's "The measured numbers stay blank until obsel can read again" is the guide's own subline
two lines above in different words. Pinned by two complementary browser tests, one asserting the
sentence is absent when both reads fail and one asserting it is present when only the demo read
does, so neither deleting it nor always showing it passes both.

**There were three copies, not two.** The first fix was checked by stopping the server again and
reading the whole screen rather than the part that had been edited, and the trace panel was saying
"could not be read (Failed to fetch). Nothing else on this page is affected." three panels below the alert saying
the page may already be wrong. It is the same sentence for the same reason on a third read, and it
now takes the same condition. Reading only the region that was changed would have left it.

**And the guide's own headline had nothing asserting it.** The blank-looking guide block in that
same screenshot turned out to be an artifact of how the screenshot was taken, not a fault: in real
Chromium "This page lost its connection" is on screen. There was no way to tell those apart from the
repository, because no test covered it, so the browser test now asserts the headline is visible in
the state where the page has lost its connection.

**The checklist gained a fifth row**, `uvx`, which the launcher also checks. It is the quietest
prerequisite obsel has: without it the engine still reaches the right answer and finds every
affected task, and the tag that records any of it is the only thing that fails, so the page looks
correct and DataHub is never told. `tests/live/preflight.live.test.ts` proves the check against a
`PATH` that genuinely lacks the binary.

That test's first version passed while proving nothing, and it is worth writing down because the
mistake is reusable. It reset the module registry and re-imported `preflight.ts` to get an empty
cache, which is exactly what `preflight.ts` is built to survive: the cache hangs on `globalThis` so
that a dev-server module reload does not throw away verdicts. The freshly imported copy answered
from the previous test's cached `ok: true`, under a `PATH` with no `uvx` anywhere on it. It was
caught by running it, not by reading it, and the fix is to drop the cached verdicts the way
restarting the server would.

**Not executed, and named rather than implied.** DataHub was already running throughout, holding the
operator's own page, so the cold-start branch of step 6 and its 180 s wait have not been run; the
16 s above is a run that skipped them, with warm pnpm and pip caches. The Gatekeeper prompt was not
reproduced either: the real `com.apple.quarantine` attribute was set and the file still ran from a
shell both ways, because that block is enforced by Finder on a GUI launch, which is not drivable
here. What the README tells a judge to do about it is therefore documented macOS behavior, not a
tested instruction. No Linux machine has run the script.

### obsel has a mark, and the browser tab has an icon (2026-07-27)

Until now the product was set entirely in type: the header ran a `Wordmark`, and the tab carried
whatever glyph the browser puts on a page with no icon. The mark is a bold lowercase "o" whose
trailing edge breaks into squares that scatter and shrink.

It arrived as a raster image, traced to vectors in Inkscape by the owner. Three things were done to
the trace before it went in, each for a reason that would have shown on screen:

- **One filled layer of the two.** The trace emitted an outer grey (`#5d5d5d`) and an inner black
  (`#181818`) overlapping closely enough to read as one shape. Both are baked colours no token
  controls, and the page's background is `--mm-ink`, `#0b0a0e`. Dropped straight in, the mark
  would have been a near-black shape on a near-black panel. Only the inner contour set is kept, so
  the mark is one fill and takes `currentColor`.
- **Cropped to the drawing.** Inkscape wrote an A4 page, `210mm x 297mm`, with the mark sitting in a
  corner of it. The geometry is shifted to begin at 0,0 in a box of `105.84 x 100.11`.
- **Split into 43 contours.** Inkscape emitted all of them as one `d` attribute. They are now a bowl
  (outer contour plus its counter, which must stay together or the nonzero fill rule leaves no hole
  in the "o") and 41 separate fragments ordered left to right. A single path can only be animated as
  a single thing; separated and ordered, the fragments can be staggered outward from the letter.
  Nothing animates them today.

**The tab icon is `app/icon.svg`**, a Next.js file convention, so the `<link rel="icon">` is
generated rather than hand-written. Confirmed on the running dev server: the tag resolves to
`/icon.svg`, and the request returns **200, `image/svg+xml`, 10742 bytes**, matching the file.

**The red is there to be seen against a tab strip obsel does not control**, which is the one thing
this asset has to do beyond looking like the product. The tile is `--mm-red` `#ef476f` and the mark
on it is `--mm-ink` `#0b0a0e`, so both colours are the page's own. It is full bleed with no
corner radius, because a rounded tile shows the browser's own colour at the corners. Measured:
the mark on the tile is **5.45:1**, clearing WCAG AA; the tile against a white tab bar is
**3.62:1** and against Chrome's dark `#202124` is **4.45:1**.

**The mark was cream on a deeper red first, and the pairing moved together when that changed.** The
first version was `#f5eef0` on `#c1123f`, chosen because on that deep red a cream mark measures
5.36:1 while a black one measures **2.90:1**. The owner asked for a black mark. Black on the deep
red is the 2.90:1 case, and rendered at 16 px it is the failure the number predicts: the counter of
the "o" closes up and the fragments disappear into the background. Lightening the tile to `--mm-red`
is what makes a black mark legible, at 5.45:1. Three combinations were rendered at 16 px and
composited onto both a white and a dark tab strip before this one was kept.

Neither the deep red nor the brighter `#d81e3f` survived the change: black measures 2.90:1 and
3.53:1 on them. `#ef476f` is also the token the page uses for a failed state, which is a
collision in meaning and not in code, since the icon is a static file holding a literal and would
not follow the token if it were retuned.

**Honest limit: the fragments do not survive 16 px.** At tab size they blur into a soft edge on the
right of the letter. The "o" and the red tile still read, which is what a favicon has to do, but the
part of the mark that carries the meaning is legible only at the header's size and above. No
separate simplified small-size icon was drawn.

**The gap in the header lockup is measured against the fragments, not the letter.** At the 4 px it
started on, the fragments ran into the "o" of the wordmark and the two read as one collided shape;
this was visible in the browser and fixed to 12 px, then re-checked at the same magnification.

### The header shows the mark, and reveals the name on hover (2026-07-28)

The header carried the mark and the word "obsel" side by side, permanently, which says the same
thing twice in a bar whose other job is to report the pipeline and whether the page is live. The
resting header is now the mark alone at 26 px, and the name ghosts in under a pointer: opacity,
a 4 px blur clearing to none, and 6 px of travel, over 0.26 s. The fragments disperse at the same
time, each one further than the one before it, because `mark-geometry.ts` orders them by distance
from the letter. Built on `motion`, the package already in this repository, rather than on a second
animation library.

**Nothing else in the header moves, which is the requirement and not a nicety.** The name sits
immediately left of `orders_pipeline · prod`. It is in the layout at full width in every state and
is only ever made transparent; opacity, blur and `x` are non-layout properties or transforms, so
none of them can reflow the line. Measured in the browser across rest, hover and back: the flow
name's x, the tour button's x, the lockup's width and the header's height are identical to three
decimal places in all three states. Pinned by `e2e/dashboard.spec.ts` "revealing the name moves
nothing else in the header", which compares four bounding boxes at rest and on a settled reveal.

**The bar is 10 px taller**, 38 px to 48.3 px, from the larger mark and from padding above the row
as well as below it, which it did not have. Every pixel comes out of the graph, since `.cockpit` is
a fixed-height column where the graph is the only child that absorbs slack. Checked at 1280x800,
the laptop case: the page scrolls by 21 px where it already scrolled by 11 px before this change,
and the whole graph still ends at y=374 in an 800 px viewport, far above the fold.

**Three things were got wrong here, and two of them looked like bugs that were not.**

- **A mount entrance was written and then removed.** The fragments were to fly out of a `gathered`
  state on load. In the only browser available here the mark rendered at `gathered`, opacity 0, and
  stayed there, which reads as a logo that is permanently invisible. The cause was not the code:
  that browser reports `visibilityState: "hidden"` and serves **0 animation frames in 500 ms**, and
  motion is driven by `requestAnimationFrame`, so any animation renders its first values and stops.
  The entrance is gone for want of evidence rather than because it failed, and `mark.tsx` still
  defines the state it would use.
- **`whileHover` was replaced with React state, then put back.** It was diagnosed as not firing on
  the same frozen-frame evidence, and the diagnosis was wrong: the element was in the document's
  `:hover` chain the whole time and the animation simply could not advance. `whileHover` is what
  ships. An empty `variants` map added to the parent on the same false theory was also removed after
  testing that propagation works without it.
- **`useReducedMotion` was the one real defect, and `memo` is what exposed it.** The hook returns
  `null` until it has detected and reports the answer on a LATER render. `guide-panel.tsx` and
  `tour-panel.tsx` never see this because they re-render on every poll. This lockup is memoised on
  purpose, so 43 motion components do not reconcile once a second, and therefore renders once and
  held that first `null` for the life of the page: with the preference set at the browser context
  the media query reported `reduce` and the animated lockup rendered anyway, for a reader who had
  asked for no animation. Both preferences are now read from `matchMedia` directly, which is also
  reactive where the hook is not.

**Pinned by three browser tests over two viewports, six checks.** They are in the browser suite
rather than in `tests/` for a reason the frozen-frame problem makes concrete: these assertions are
about where an animation ARRIVES, and only a real browser runs the frames that get it there. They
cover the name hidden at rest and opaque on hover and hidden again when the pointer leaves, the four
bounding boxes above, and reduced motion rendering the finished lockup with zero animations in
flight. The reduced-motion case must set the preference through `contextOptions`, not
`page.emulateMedia`, which arrives after the page exists.

**One existing test failed and the failure was in its selector.** "the alert takes its own row
rather than covering the page" located the graph as `main svg`, whichever `<svg>` came first in the
document, which was the graph only while the graph was the only drawing on the page. A mark in the
header made it resolve to the logo, so the test compared the alert against something above it and
reported the page covered. It names `.react-flow` now. The layout was never wrong.

**Pinned by `tests/dashboard-mark.test.ts`, seven tests.** The icon and the geometry module hold
duplicate copies of the same 43 contours, because a static file convention cannot import a module,
and a wrong favicon is silent: 16 pixels wide, cached hard, in a strip nobody watches. The tests
assert the icon's paths equal the module's exactly and in order, that it has no path the module does
not define, that the bowl keeps both its contours, that the background is un-rounded and fills the
viewBox, and that the mark clears 4.5:1 against it. Each was confirmed to fail on the mutation it
exists to catch: an altered fragment, an appended path, an added `rx`, and a low-contrast fill.

### The cold start, and three things a restart exposed (2026-07-28)

**The launcher started DataHub from nothing, which it had never done.** Every earlier run of it found
DataHub already up, so the branch a judge's first run depends on was unexecuted. With the stack
backed up (`datahub docker quickstart --backup`, 12 MB) and stopped, and port 8080 confirmed dead:

| measured                                                  |                                                  |
| --------------------------------------------------------- | ------------------------------------------------ |
| launcher start to obsel answering on `:3000`              | **450 s (7 m 30 s)**, including every image pull |
| DataHub version before and after                          | `v1.5.0.6` both times, unchanged                 |
| `orders_pipeline` / `obsel_scale_v2` / `obsel_join_check` | 5 / 40 / 2 tasks, all intact                     |

The upgrade risk that made the backup necessary did not materialise, and the reason is worth
recording rather than being relieved about: with no version asked for, the 1.6.0.15 CLI planned
`composefile_git_ref='v1.5.0.6' docker_tag='v1.5.0.6'`, because its version map's `default` key
points there. `stable` points at `v1.6.0`. So "latest stable" was never what an unpinned quickstart
installs.

**The launcher now asks for that version by name.** Not because the float caused harm here, but
because the map is fetched over the network at run time, so the same command installs different
stacks on different days and obsel would be running against a DataHub nobody has checked it on. That
is the failure shape `MCP_SERVER_DATAHUB_VERSION` is already pinned for. Two traps, both found by
running the command rather than reading its help: `--version v1.5.0.6` alone exits with "requires
confirmation in a non-interactive environment", because the map has no `v1.5.0` key, and a
double-clicked launcher is never interactive; `--accept-version-default` is what permits it, and the
flag does not do what its name says, it accepts the exact unlisted version given. Verified by the
plan line it printed and the compose file it then fetched, both naming `v1.5.0.6`.

**Reset vanished on restart, and that is the whole of "it always comes back the same".** Reported by
the owner in those words. The page is DataHub's and survives a restart; the launcher's record of
which steps ran is this server's and `runner/types.ts` says plainly that it does not. `walked` asked
only that record, so quitting obsel and starting it again took "Reset and start over" off a page
that had genuinely been all the way round, with nothing about the page having changed.

It is page-derived now: an output whose recorded previous fingerprint differs from its current one.
Checked against real pages rather than argued — the live demo page, which has only ever run,
carries it on zero of five tasks, and `e2e/fixtures/captures/scale-settled.json`, a recording of a
real repaired forty-task pipeline, carries it on exactly three (`daily_trips`, `docs_marts`,
`report_city`). It reads false again after a reset only because `resetSwarm` nulls the property,
which makes that one line in the reset list load-bearing for a button three files away; the comment
in `fingerprints.ts` says so. The launcher's record stays as a second route, since it is the stronger
evidence where it exists. `tour/steps.ts` had the same bug in two steps and got the same fix.

**Both fixes read off a live page, 2026-07-28.** The demo page could not be used for it, and why is
worth writing down: `orders_pipeline` carries a fifth DataJob, `clean_trips`, that a launcher bug
registered on 2026-07-24 and that nothing has removed, so `finished` never equals `tasks.length` and
that page cannot reach the settled stage at all. It sits on "4 of 5 agents finished" whatever is
done to it. Deleting that entity is the owner's, and until it happens the reset button is unreachable
on the demo page for a reason that has nothing to do with this fix.

So the state was built on an isolated flow instead, `obsel_walk_check`, on a second server started
with `OBSEL_FLOW_ID`, using the report route rather than Codex: two tasks registered, both reported,
then the upstream reported again with a renamed column, which flagged the downstream, then the
downstream reported again, which cleared it. A genuine walk with real fingerprints, real marks and a
real clear.

That server's launcher history is `[]`, which is exactly what a restarted server has, and the page
offered **Reset and start over**, accented, above the two unaccented experiments. Before this change
the same page offered the two experiments and no way back. The header read `obsel_walk_check · prod`,
which is also the first time the page has said which page it is.

The full demo was still walked end to end on `orders_pipeline` first, with real Codex sessions, and it
turned up two things worth recording. A backgrounded step was killed mid-run and left `build_revenue`
announced; `POST /api/tasks/abandon` handed it back, which is the path `docs/coverage.md` already
claims and this exercised again. And one redo failed on the tag write with
`MCP error -32001: Request timed out`, minutes after the stack came up from cold. The run stopped
rather than continuing, said which task was still announced and where its state file was, and the
re-run resumed and finished with "every flag is off, and every one came off through a redo".

**A soft delete DataHub accepted and obsel ignored (2026-07-28).** The rogue `clean_trips` above was
soft-deleted with `datahub delete --soft`, which succeeded: `status: {removed: true}` landed on the
entity and DataHub hid it in its own UI. The page went on drawing it and counting it, so it still
read "4 of 5 agents finished" and still could not settle.

The reason is that a soft delete writes one aspect and nothing else. The `IsPartOf` edge stays, so
`GET /relationships` still lists the task, `batchGet` still returns it, and nothing about the swarm
read fails. obsel was reporting a swarm DataHub no longer agreed it had, which is the same class of
wrong answer as the search container that stayed green: not an error, a confident wrong picture.

`readSnapshot` now drops entities marked removed, and the filter sits after the existing check that
raises when the graph lists a task the aspect store did not return. Order is load-bearing both ways:
a soft-deleted entity IS returned, so filtering earlier would make that guard report a disagreement
about an entity the two stores agree on perfectly, and that guard must keep meaning only "a task is
genuinely missing". One filter covers three callers, so a removed task stops being drawn, stops being
traversed for staleness, and stops being reset, together; reporting a completion for one now fails
with "not in the swarm". `removed` is compared to `true` rather than read for presence, because
DataHub also writes `removed: false` and a presence check would call a restored task deleted forever.

`tests/live/removed.live.test.ts` covers it against the real DataHub, writing the same `status` aspect
the CLI writes and undoing it afterwards, so the suite leaves its flow as it found it. It also measures
the two facts that made this invisible: with the task removed, the flow's edge still lists it and
`batchGet` still returns it.

**The demo page settles for the first time.** With that one entity removed, `orders_pipeline` reads
four tasks, all complete, three carrying a recorded change, on a server whose launcher history is
empty. The page shows "all 4 finished, nothing out of date", "Every step has run. Reset to walk it
again.", and three buttons with the reset accented and the two experiments quiet. Both of the day's
page fixes, on the operator's own page, with no fixture involved.

**What the signal is loose about, observed rather than predicted.** Running the four demo agents on
2026-07-28 over a page that had last run on 2026-07-24, without a reset in between, left
`write_docs` and `write_report` carrying a recorded change and `clean_orders` and `build_revenue` not.
That is correct and it is not a walk: those two agents write prose, and a live Codex session does not
produce the same paragraph twice, so their outputs genuinely moved while the two deterministic
transforms did not. The page therefore offers "start over" after a second plain run.

That is the accepted looseness of asking the page rather than the launcher, and it is one-directional:
the offer is to reset a page where something did move, which is a legitimate thing to be offered,
rather than a claim that work is sound. The judged run is unaffected, because `docs/demo-script.md`
resets before the take, and a first completion after a reset records no previous version at all.

While fixing it, a docstring on the same derivation in `joining.ts` was found asserting the opposite
of the code: that `previousFingerprints` is written "including a re-run that produced exactly the same
bytes". `engine.ts` guards that write on `compareFingerprints(current, next) !== null`, which is null
for an identical re-run, and its own comment explains why. The docstring was wrong, not the code, and
a unit test now pins the distinction the wrong reading would have lost.

**The dataset choice was reachable exactly once.** `Set up the forty-agent taxi run instead` is offered only on
an empty page, and obsel deletes no task, so after the first registration it was unreachable
forever. The owner chose one pipeline per page, made visible, over mixing both onto one: the header
name is now a disclosure saying that the page is one DataFlow named by `OBSEL_FLOW_ID`, that a new
page opens empty, and that nothing here is deleted. No control switches pages, and the sentence does
not imply one: obsel reads the flow once at startup and the demo agents read the same variable
independently, so a button would move the page and leave the agents pointed at the old one.
`agents/scale.py`'s header claimed "Reset, then register the other, to switch", which is false for the
same reason, and now says what actually happens.

**Every button in a stage looked identical.** One `.action` class, 13px, so on a flagged pipeline "Redo
the work obsel flagged" and "Reset and start over" were the same object with different text. The
bench's own rule, written in `table-form.module.css`, is applied to the guide: at most one accented action
per stage, the one the stage's sentence is asking for, and a stage whose sentence points at the bench
accents nothing. Spent on colour and elevation, never on size — both labels stay 13px and both details
12px, because `docs/verification.md` already records three guides that failed by adding what mattered
at footnote size, and the secondary form gets more contrast than it had, its label moving from
`--mm-rose` to `--mm-cream`. On the settled demo page the change now leads and takes the accent,
ahead of the identical re-run, because the settled taxi pipeline offers exactly one experiment and it is
its change; leading on the re-run made one stage teach two different lessons.

`pnpm test:live` was not re-run for the page work and does not need to be: nothing in it crosses a
process boundary. The derivation reads a field `client.ts` already parses and the live suite already
covers, and the four existing `previousFingerprints` cases in `tests/dashboard-joining.test.ts` passing
unchanged is the regression guard on moving it into `fingerprints.ts`.

### The page became a canvas, and the feed stopped being a residual (2026-07-28)

**What was wrong.** The page was a column of stacked regions: a header, the guide, a graph panel
fixed at 320 px, a strip beneath it, two fold-out panels and the stat ribbon. Only the strip
absorbed slack, so after every content-sized region took its share of a 990 px column the strip
landed on its 172 px floor with a 105 px scroller inside it. Measured on the taxi pipeline: three of
eighty-six steps visible, the top one cut through its own text. Nothing about that was tunable,
because the strip was the residual of a stack. A forty-task pipeline escaped by growing the graph panel
and letting the whole page scroll, which put the two measured numbers below the fold.

**What it is now.** The lineage canvas is the page. One dock beside it holds the guide, a tab strip
(activity, your agent, your data, erasure) and the two measured numbers pinned at its foot. The dock
can be carried to either edge, resized by its inner edge, or collapsed to a rail; all three are
remembered in `localStorage` under `obsel.dock.v1`. Neither viewport scrolls, in either direction,
and `overflow: hidden` on the stage states that rather than hoping for it.

**Measured, at 1920 x 990 and 1280 x 800, with the fixtures the browser suite serves:**

|                                                | before                | after             |
| ---------------------------------------------- | --------------------- | ----------------- |
| activity feed panel, taxi pipeline, 1280 x 800 | 172 px                | 299 px            |
| its scroller                                   | 105 px                | 294 px            |
| page scroll height, taxi pipeline              | taller than the frame | exactly the frame |

`e2e/scale.spec.ts` asserts the scroller is at least 280 px and at least as tall on the taxi pipeline
as on the demo page, which is the property that was inverted before: the page with more to say
got less room to say it.

**What was checked and how.** 229 browser tests pass at both viewports (`pnpm e2e`), including three
new files: `e2e/dock.spec.ts` (seven tests: default side, snap preview during a drag, landing side,
persistence across a reload, resize, collapse, keyboard move; every one of them re-asserts that no
node is clipped and neither axis scrolls), `e2e/erasure.spec.ts` (thirteen), and the new assertions
in `e2e/dashboard.spec.ts` for the ripple's hop ordering and the count-up. `pnpm verify` is green.

**The animation, and what is deliberately not animated.** The cascade ripple is a flare drawn in its
own element over each marked box, delayed by the hop count obsel recorded, plus a one-shot draw-in on
each lit edge with the same stagger. The colour underneath is unchanged: `nodeTone` paints it from
the record on its own, so a dropped frame cannot alter what the page claims, which is the rule
`tone.ts` keeps. `tone.ts`'s allowance sentence was widened to name the flare, and the widening is
written next to it. The detection number counts up over 600 ms, keyed on which change is being
timed rather than on the value, so a page re-read once a second does not restart it; the last frame
renders the measured integer exactly. Reduced motion follows the repo pattern everywhere: the
animation props are not passed at all, so the first frame is the finished picture.

**Erasure is on the page for the first time.** A tab reads `GET /api/erasure/{id}` for a request id
a reader pastes in, at five seconds. There is no list endpoint and the tab does not pretend there is
one: `documents.ts` derives every URN and never searches, so obsel cannot enumerate its requests, and
the empty state says so and hands over the command that opens one. A toggle recolours the dataset
nodes by coverage state. `tests/dashboard-erasure-view.test.ts` (25 assertions) pins the vocabulary,
and `e2e/erasure.spec.ts` re-checks it against the rendered page: no "proven clean", "proof",
"complete" or percentage anywhere, no enum spelling in any sentence, no control whose label reads as
a way to close a gap, and no amber on the erasure view at all.

**Not measured.** Frame rate during the ripple on the 82-node page has not been instrumented, so no
number is claimed for it. The page was watched at both viewports and nothing dropped visibly, which
is an observation and not a measurement.

**Two bugs the rebuild introduced, found by driving the tour and fixed the same day.**

The first: the tour marked no region. Its highlight was an `outline` at a 4px offset plus a glow at
`inset: -5px`, both drawn outside the target's box, which was correct while the page was a column
of panels with gaps between them. Every region a step points at now sits flush inside a container
that clips its overflow, so all of it was cut away. Walking the tour on the rebuilt page and
measuring each step: five of the six highlights a reader passes were clipped, and four rendered
nothing at all. The tour spent four consecutive steps telling somebody to look at a region while
marking no region. Fixed by drawing the ring as an inset shadow inside the target's own box, which
an ancestor cannot clip and which still moves nothing on the page, since `box-shadow` never affects
layout.

The second: the tour window opened on top of the dock. Its home corner was the bottom right
unconditionally, a free corner on the old page and a panel on this one, so it covered the two
measured numbers pinned at the dock's foot. It now opens against whichever edge the dock is not on
and follows the dock when a reader moves it; the drag limits are worked out from where it actually
rests rather than assuming it starts on the right.

Both are pinned by new tests in `e2e/dashboard.spec.ts`: one asserts that nothing is painted outside
the lit region's box, that the ring is inset, and that no part of the region falls outside what
clips it, across all four chapter-one steps; the other asserts the window's box does not intersect
the dock's, with the dock on either side. Neither bug was caught by the existing suite, which
checked only which region was lit and never whether the mark was visible.

**Not re-captured.** The four images and two GIFs in the README, and the reference video lock, all
show the previous layout. Every number in them is still what its run produced; the arrangement
around those numbers is not the arrangement a judge will see. Re-shooting them is the owner's, needs
a live DataHub and a live Codex CLI, and has not been done.

### The details panel became a surface with three depths, and a table got a shape (2026-07-28)

**What was wrong.** Everything obsel holds about a node was behind a click on that node, and nothing
on the page said a click would do anything. The owner, who commissioned the panel, believed it
opened by clicking an edge: the affordance was invisible even to someone who knew it existed. What
it opened then stated its subject three times before any of its content, as a section title
(`details · raw orders`), a meta line naming the kind (`a table, as last reported`), and its own
heading (`raw orders`). And a table's panel listed its columns as a comma-joined string, which is
the least legible form of the one thing obsel can truthfully say about a table's contents.

**What it is now.** One surface in the canvas's bottom-right corner, at three depths.

- **Idle** — one line: `hover a box to preview it, click to pin`. Permanent while the page has
  nodes. The legend's own `click any box for details` was deleted in the same change; that
  duplication is the thing this rewrite is against.
- **Hover** — the box under the pointer, in human names, with no URN and no hash anywhere. Entering
  the card holds the preview so it can be read.
- **Pinned** — a click, and the full record, until Esc or close. Clicking the preview pins it too.

`useHoverIntent` waits 80 ms before previewing and 140 ms before clearing. Both are design
constants, not measurements: the forty-task pipeline is dense enough that reaching one box sweeps the
pointer across several, and reacting to each would churn the surface through six previews on the way
to the seventh.

**Hovering while pinned does not rewrite what is pinned.** The page's edges follow the pointer, so
a reader sees what a click would open; the panel does not move, because a panel that rewrote itself
while the pointer crossed the page toward it could not be read. Pinned by
`e2e/dashboard.spec.ts` → "pointing elsewhere does not rewrite what is pinned".

**The table sketch, and what it is incapable of showing.** A table's panel now draws its reported
column names over uniform blank blocks, one row of blocks per reported row up to six, with the exact
counts stated in words beneath: `a sketch of 4 columns and 39 rows, from what the writer last
reported. obsel never reads the table itself.` The blocks are uniform on purpose — varying their
widths would imply they were measured from something. `Schematic` receives a column list and a row
count and nothing else, so no code path can render a cell value; the browser test asserts every
block is empty rather than trusting the construction. Column names come from
`producer.run.outputs[dataset].columns`; the added/removed highlight comes from the `ColumnChange`
on the mark that names this table, never from comparing fingerprints, because a hash cannot name a
column. No reported shape means no sketch and the existing honest fallback line instead.

**The flow highlight, and the rule that keeps it from lying.** Pointing at a box dots its incident
edges in rose and marches them at 900 ms. It says what `reads` and `writes` already say. It is
distinguished from the cascade in three ways at once — colour (rose against amber), pattern (2/6
dots against 6/4 dashes), tempo — and, decisively, **an edge the cascade has lit never receives it**:
the skip is in `flowEdgeIds`' single caller, not in CSS specificity. `flowEdgeIds` walks one hop
only; multi-hop reach is the cascade's claim and is read off marks, for the reason `cascade.ts`'
header documents. Hover does not enter `graphSignature`, so pointing at a box never rebuilds the
graph, and unchanged edges keep object identity, so a hover on the eighty-two-edge taxi pipeline
re-renders the two to nine edges that changed.

**Motion is decorative, and the position is stated.** The reveals write `clip-path`, `opacity` and
`transform`; the sweep is a separate `aria-hidden` element with no text and `pointer-events: none`,
the same construction as the flare. Every field is complete and true in the DOM on the first frame,
so an interrupted run leaves a readable panel rather than a partial claim. A text-scramble "decode"
effect was considered for the headings and rejected: it renders characters that are false while it
runs, which would make the animation the mechanism by which untrue text appears. `globals.css`'s
claim that the pulse dot was "the one looping animation obsel permits" was corrected in the same
change — it was already untrue when written, since `obsel-dash` loops.

**What was checked and how.** `pnpm verify` green: 526 unit tests, the Python self-checks, and the
build. `pnpm e2e` green at both viewports: **267 tests, up from 233**. Sixteen are new unit tests
(`tests/dashboard-flow.test.ts`, `tests/schematic.test.ts`), including the id-spelling agreement
between `flowEdgeIds` and `layoutPositions` that the cascade has for the same reason — a drifted
spelling lights nothing and throws nothing.

Fourteen new browser tests in `e2e/dashboard.spec.ts` → "the details surface": the idle hint present on
a populated page and absent on an empty one; the preview appearing on hover and carrying no
`urn:li:`; the hint returning on leave; hovering moving no node and changing no graph dimension;
click-to-pin and Esc-to-unpin; the preview pinning itself; hover-while-pinned; the panel naming its
subject exactly once; the sketch drawing real column names, the `+`/`-` markers agreeing with the
mark on the same page, and no text in any block; the plain fallback when a writer has reported
nothing; three flow tests (writer and every reader lit, never an edge the cascade lit, and an edge
the cascade did not reach); and reduced motion, which asserts field opacity 1 with `animation-name:
none` on both a sketch block and a flow edge.

Two new tests in `e2e/erasure.spec.ts` cover a bug found while writing them: the coverage state was
computed once for the pinned table and handed to the surface, which also renders hovered tables, so
it would have printed an erasure verdict about one asset underneath another. It is now looked up per
table shown, and gated on the page actually being coloured by coverage.

**The copy sweep's details exclusion was dead, and is now live.** `e2e/dashboard.spec.ts`'s
"no internal identifier reaches the page" excludes `[aria-label="Details"]`, and nothing rendered
that label — `Panel` maps `label` to `aria-label` and neither inspector passed one. No state in that
loop opened the panel either, so the exclusion had never once been exercised on a panel built almost
entirely from full URNs and 64-hex hashes. Both inspectors now pass `label="Details"`, and the sweep
runs two additional states with a node pinned open.

**Fixtures changed, and why they had to.** `e2e/fixtures/swarm.ts` carried `run: null` on every task,
so no browser test could reach the sketch at all. Each finished task now reports an output shape. The
column names are the ones `agents/pipeline.py` declares as `output_columns`, so the fixture describes
the real pipeline's structure; the row counts are invented, like everything else in that file, and
its header still says so. `cascaded()`'s `clean_orders` reports the renamed column, because a fixture
whose reported columns still said `order_total` would draw a table missing the column the same
fixture says arrived.

**Not measured.** Frame rate during the flow animation on the eighty-two-edge page has not been
instrumented, so no number is claimed for it. Touch input and keyboard focus of graph nodes are not
covered: the surface is driven by pointer enter/leave and a click, and a device with no hover state
reaches the pinned depth by tapping but never sees a preview. That is a gap, not a decision.

### Claude Code as a second runner, and the flag two runs found (2026-07-28)

The demo agents ran on Codex only. `agents/codex_runner.py` hardcoded the string `codex` in three
places, with no environment variable, no configuration and no registry. Nothing about obsel required
that: the coordinator makes no model calls, and `run.runner` is free text an agent supplies. The
consequence was an adoption wall in front of exactly the person the page's joining panel addresses.
With Claude Code installed and Codex absent, DataHub came up, the tag registered, the page loaded,
and every demo button was dead, with a checklist row that offered no fix.

The page also contradicted itself. The joining panel served `claude mcp add obsel …` while the
checklist a few inches away demanded the Codex CLI.

**What was measured, by running the CLI rather than reading about it.** All on 2026-07-28.

| Flag                            | What was observed                                                                                                                                                                                                                                                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-p`                            | a two-row doubling job ran non-interactively and exited 0                                                                                                                                                                                                                                                                  |
| `--permission-mode acceptEdits` | the agent wrote `output.json`, a file that did not exist, without stopping to ask                                                                                                                                                                                                                                          |
| `--safe-mode`                   | **required**, see below                                                                                                                                                                                                                                                                                                    |
| no git-repo flag                | a session in `.obsel/work/_flagprobe`, gitignored and inside this repository, ran without complaint. Codex needs `--skip-git-repo-check` here; Claude Code does not                                                                                                                                                        |
| `cwd=` on the subprocess        | Claude Code has no `--cd`, and the output landed in the working directory given                                                                                                                                                                                                                                            |
| `stdin=DEVNULL`                 | without it the CLI prints `no stdin data received in 3s, proceeding without it` into captured stderr. The warning is gone with it. **The timing effect was not separately measured**: two single runs came out at 11.2 s and 10.5 s, which is inside the run-to-run variation of the model itself, so no saving is claimed |
| `claude auth status`            | exits 0 signed in, 1 signed out (printing `{"loggedIn": false, …}`), ENOENT when absent. The same three-way split `codex login status` gives, which is what the setup checklist needs                                                                                                                                      |

**`--safe-mode` is the finding, and it was not predicted.** Claude Code discovers CLAUDE.md, skills,
plugins, hooks and MCP servers by walking up from its working directory, and the agent's working
directory is `.obsel/work/<task>/`, inside this repository. Two runs of one prompt in one directory,
differing only by that flag:

- **Without it**, the agent obeyed a CLAUDE.md placed in a parent directory and wrote
  `{"sentinel": "claude-md-was-loaded", "columns": [...], "rows": [...]}`. A key the prompt never
  asked for, put there by an instruction file the agent was never meant to read.
- **With it**, the same prompt in the same directory wrote `{"columns": [...], "rows": [...]}`.

That is not cosmetic. A demo agent doing a two-column rename must not be reading obsel's own
instructions, and an output that depends on where the repository sits on disk is not reproducible.
`tests/live/runners.live.test.ts` now asserts the written file has exactly `columns` and `rows` and
nothing else, because `validate` accepts undeclared keys inside a row on purpose and a leak of that
shape would otherwise pass quietly.

**Two bugs the work found in itself.** Both were wording, and both would have shipped.

- A single label per runner produced `Each demo agent is a real The Codex CLI session` and
  `Four real the Codex CLI sessions`. The two products capitalise and read differently, so
  `preflight.ts` and `guide.ts` each keep two forms: the thing you install, and the word that goes
  in "a real ___ session".
- `scripts/start.sh` printed the invalid-`OBSEL_RUNNER` message and then the no-CLI-installed
  message, on a machine with both installed. Two contradictory sentences. The three outcomes are now
  distinct states rather than one empty string.

**What was verified, and how.**

- `pnpm verify`: 531 tests, 200 Python self-checks across eight modules, build clean.
- `pnpm e2e`: 271 browser checks, one skipped by design.
- The checklist row **looked at** in all three states at 1280 x 800, screenshotted from the real
  page: Codex signed out offers `codex login`; Claude Code signed out offers `claude auth login`;
  neither installed names both products, offers no command, and wraps without overflowing. Grammar
  correct in all three.
- `scripts/start.sh` step 8 exercised across all seven of its branches with stubbed helpers.
- Seven real Claude Code sessions over a two-row doubling task, five of them timed: 11.0 s, 13.3 s,
  11.2 s, 10.5 s and 10.3 s. **This is not the demo's timing, and must not be read as one.** It is
  a two-row toy over one file; the demo's four agents work over a 50-row seed and took 206.0 s on
  Codex on 2026-07-23. Nothing comparable has been run on Claude Code.
- `claude_runner.run_agent` itself, called directly rather than through its argv, on a real scratch
  directory: returned `2.1.216 (Claude Code)` as the version obsel records, 10.3 s measured, the
  exact three-column contract, the arithmetic right (20 and 64), and a written file whose top-level
  keys are exactly `columns` and `rows`. That last assertion is the `--safe-mode` one, made through
  the function the demo actually calls rather than through a hand-built command line.

**The four-task demo, end to end on Claude Code.** Run on 2026-07-28 on its own DataFlow
(`OBSEL_FLOW_ID=obsel_claude_take`, server on port 3101), so the operator's page was never touched.
All four steps exited 0.

| Step         | Measured                                                                            |
| ------------ | ----------------------------------------------------------------------------------- |
| `run`        | four agents in **132.6 s**; 56.0 s, 29.2 s, 23.7 s, 23.5 s each                     |
| `rerun-same` | output **byte-identical**, 0 changed outputs, 0 marks                               |
| `change`     | called `schema`, marked exactly 3: 1 hop, 2 hops, 2 hops; 3 of 3 tagged in DataHub  |
| `repair`     | 1 redone identical in 32.1 s, and obsel cleared the other 2 without re-running them |

Every task recorded `2.1.216 (Claude Code)` as its runner, which is the CLI's own version string
passed through unchanged.

Three things worth naming separately, because they are the properties that are hard rather than the
ones that are visible:

- **`clean_orders` came out byte-identical across two live Claude Code sessions**, content hash
  `539b509722e8` both times, so obsel stayed silent. That is the quiet case working against a live
  model, and it is the same content hash the Codex runs produced, because the hash is taken over a
  canonicalised table built from a fixed seed.
- **The rename was called `schema` and not `both`.** The content hash was `539b509722e8` before and
  after; only the column name moved.
- **The repair cleared two tasks that never re-ran.** `build_revenue` redid `daily_revenue`
  identically, so obsel derived that `write_docs` and `write_report` were flagged for ground that
  never moved, and took their flags off with a reason on each. Nothing requested that; it is
  `restoredBy` in `staleness.ts`, and this is the first time it has been exercised on this runner.

**One number in that run was not obsel's, and it is recorded in `environment-findings.md` §14.** The
`change` step first reported its cascade as **162.8 s end to end** for a decision obsel made in
105 ms. That was `mcp-server-datahub` blocking on unreachable telemetry, not obsel: with
`DATAHUB_TELEMETRY_ENABLED=false`, which `mcp.ts` now sets, the `repair` step's coordination reported
**1.9 s**. The 162.8 s figure is kept here because it is what the page actually said, and deleting a
measurement because it was unflattering is the habit this document exists to prevent.

**What has not been done.**

- `pnpm test:live` **passes clean**: 112 of 112 tests across 11 of 11 files in **433.8 s** on
  2026-07-28, exit 0, including one real agent session per installed CLI.

  The run before it was 111 of 112 in 513.5 s. The single failure was a stale string in a test
  written earlier the same day, asserting a word the label pass had changed underneath it; it is
  recorded rather than dropped because it is the kind of failure that says something -- two edits to
  one sentence, hours apart, and only the live suite caught the disagreement. Three attempts before
  that were abandoned and none was a suite failure: two had concurrent builds against the same
  `.next/`, one hit `MCP error -32001: Request timed out` because the Claude Code demo was driving
  DataHub at the same time. All three predate the telemetry fix in §14, which is what made the suite
  finish at all -- before it, fifteen minutes had not completed a single file.

  The suite's closing line now names the runners it did **not** exercise. On this machine it read
  `Agent runners: both Codex and Claude Code ran a real session.`, so this run is evidence about
  both. On a machine with one CLI it would name the other and say the run is evidence about one.

- The four-task demo has been run on Claude Code but the timings are **not comparable** to the Codex
  figures: different day, different machine load, and the 206.0 s Codex figure was taken on
  2026-07-23. Neither runner has been measured against the other under controlled conditions, and no
  claim that either is faster is supported.
- The forty-task taxi swarm has not been run on Claude Code.
- **The TypeScript runner check's not-installed branch has no test.** `preflight.live.test.ts`
  covers `datahub` and `uvx`, and it proves the `uvx` case against a PATH that genuinely lacks it,
  which is exactly the shape the runner check needs and does not have. The Python side of the same
  question is covered against a real emptied PATH in `runners.live.test.ts`, and the rendered page
  is covered from a fixture, but nothing yet observes `checkRunner` deciding "not installed" from a
  real absent binary. Until it does, that branch is reasoning rather than evidence.
- Claude Code's terms under a consumer subscription have not been researched to the depth the Codex
  question was. See [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

### The screen stopped calling itself a page (2026-07-28)

The owner asked what "page" meant, and was right to. It is a metaphor for a page, and two rules in
this repository already forbid it: CLAUDE.md says name things what they are and do not use metaphor,
and the page's own house rule in `guide.ts` says a sentence on screen has to be readable by
somebody who has never opened the README. The word had survived both because it is the repository's
own habit -- it is in CLAUDE.md, in eight commit subjects, and in `skills/obsel-collaboration/`.

**What was measured first.** The word appears 1,227 times across the repository, but only ~30 of
those are strings a user actually reads. The rest are code identifiers and prose in `docs/`. So the
change was scoped to what renders, where the confusion actually happens.

| Was               | Is                       | Why                                                                        |
| ----------------- | ------------------------ | -------------------------------------------------------------------------- |
| the page          | this page, or the graph  | whichever it actually was at that point; two different things had one name |
| this page         | this page                | the reader has nowhere to look up "page"                                   |
| the swarm         | the agents               | plain, and it is what they are                                             |
| the taxi swarm    | the forty-agent taxi run | says the count and the subject instead of a collective noun                |
| Every act has run | Every step has run       | "act" is this repository's word for a stage of the tour                    |

Thirty strings across eighteen files, including five in `src/server` that reach the setup checklist,
which the first pass missed by only scanning `src/features`.

**Verified.** `pnpm verify` green with 531 tests; `pnpm e2e` green with 271 browser checks, which is
what proves it, since twenty of those assert on rendered text. Documentation that _quoted_ a changed
string was updated with it; documentation that merely uses the word "page" in prose was not, and
that is a decision still open rather than an oversight.

**The identifiers followed, later the same day.** `src/features/cockpit/` is now
`src/features/dashboard/`; `dock/` is `panel/`; `hud.tsx` is `stats.tsx`; `mine.ts` and
`mine-panel.tsx` are `your-data.ts` and `your-data-panel.tsx`; `bench.ts` and `bench-panel.tsx` are
`table-form.ts` and `table-form-panel.tsx`. The exported symbols moved with them, and `Docker`
survived untouched because whole-word matching does not see it inside `Dock`. Fourteen unit test
files and the browser spec were renamed to match, with `git mv` so the history follows.

Three names were left, each for a reason rather than by omission. `mmux.tsx` names a real external
design system, and renaming it would hide where those components came from. `passes.ts` and `tone.ts`
are vague, but they were not in the set that was asked about, and widening a rename unasked is how it
stops being reviewable.

`obsel.dock.v1` in local storage became `obsel.panel.v1`, which discards a saved panel position once.
That is a storage key rather than a label anybody reads, so the cost is recorded here rather than
avoided.

**Two things this pass broke and had to fix.** A blanket lowercase replacement rewrote prose inside
comments as camelCase, so `progress.ts` came to read "the dashboard tableForm reports a table";
identifier renaming and comment prose are now separate passes. And the stylesheet inventory test,
plus `.dockLeft`-style class names that a word boundary does not catch, were only found by asking
which `styles.x` no longer resolved to a class that exists.

**One test failed and it was not the rename.** `offers no hint on a page with nothing to point at`
asserted on the bare text "No agents yet", which matches both the graph's empty line and the guide's
headline. It passed alone and failed under the full suite, decided by which had rendered first. The
assertion now names the graph's own sentence. Checked against `HEAD` first: the line is character for
character what it was before this work started.

**Verified.** `pnpm verify` green with 531 tests. `pnpm e2e` green with 271 browser checks, which is
what actually proves a rename this size, because it renders the real CSS modules and clicks the real
test ids.

## Not done

- **The cold start ran the `datahub` CLI branch, not the `uvx` one.** This machine has that CLI
  installed, so the 450 s run took the branch that uses it. The `uvx` branch, which is what a judge
  without the CLI gets, was then run on its own against a PATH built from a temporary directory that
  genuinely lacked `datahub`: it planned the pinned version, fetched that tag's compose file and
  brought DataHub up. What has still not happened is the two together, a cold stack started through
  `uvx` in one launcher run, and that run printed one thing a full PATH would not have: "Error while
  pulling images. Going to attempt to move on to docker compose up", because the stripped PATH was
  missing what Docker needs to pull. It proceeded and succeeded, on images already local.
- **The Gatekeeper block was not reproduced**, only the attribute that causes it. It is enforced by
  Finder at GUI launch, and no GUI session was available. The right-click-Open instruction in the
  README is documented macOS behavior rather than something observed here. The `bash scripts/start.sh`
  fallback was run against a genuinely quarantined file and works.
- **The launcher has only run on one macOS machine.** Linux is claimed on the strength of the script
  avoiding macOS-only constructs, not on a run. Windows is out of scope and the README says so.
- **Every scale figure above is one observation.** One registered page, one concurrent run, one
  mid-run cascade, one parallel repair, on one machine. That is a demonstration, not a pass rate,
  and the demo-stability bar the four-task demo was held to, repeated clean sequences across days,
  has not begun for the forty-task one.
- **The forty-task pipeline is browser-tested against recordings, not against a live read.** See the
  entry above for what the browser suite now covers. What it still does not do is drive the real
  `/api/swarm`: the two fixtures are recordings of one, replayed. A scale button has been clicked
  in the browser and the launch call asserted, but the step it launches is intercepted, so no
  forty-agent run has yet been started from the page end to end.
- **The window between a committed decision and its tag is real, and a crash inside it leaves a
  tag behind.** Observed once on 2026-07-24, under the dead-session bug described above: two
  completions committed their clears, the tag removal failed with the session already dead, and
  two complete tasks kept the tag. The page named the state honestly ("tags left over from
  before"), and the residue laundered itself through the next ordinary cycle: the reverse change
  re-marked both tasks, the repair's redos cleared them properly, and the page ended with zero
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
  `canonicalise_numbers` in `agents/tables.py`, which fixes the serialised form per column before
  anything is hashed), and averaging precision, found by the first live `repair` on 2026-07-24 and
  pinned in the instruction the same day. All three were caught by the demo's own assertions rather
  than seen on camera, which is the property worth keeping. obsel itself called every one of those
  runs correctly.
- **An outside agent joining the demo's own page has not been watched visually.** The join path is
  real and proven, since the MCP live suite registers, works and cascades through it against the
  integration flow and the layout suite proves a fifth joined task lays out on the demo's shape,
  but nobody has yet watched a fifth box appear on the demo page from a real outside agent. The
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
- **Nothing checks whether the page says the _right_ things, only that it does not say more than
  it used to.** The page once carried a hard ceiling on its total word count. It was removed on
  2026-07-27 because it had become a toll booth: it was raised three times, each time by the change
  that was improving the copy, so it never actually refused anything, and it measured the one
  property of prose unrelated to whether the prose is any good. What replaced it is comparative and
  per-element, and none of it can tell whether what remains is the right copy. No test can.
- **The graph is laid out for two pipeline shapes now, not one.** The unit suite exercises a
  six-task fan-out and a cycle, and the browser suite covers the four-task demo and the forty-task
  taxi pipeline in both states at both viewports. Nothing has been checked between or beyond those:
  a swarm much wider than the taxi pipeline, or one deeper than three hops, has never been drawn.
- The submission video is not voiced or uploaded. A reference picture lock exists (157.9 s,
  ffprobe, from a clean one-shot take), and the shoot, the voiceover, the cut approval and
  the upload are the owner's.
- **That lock is of a layout that no longer exists.** It was taken while the page was a scrolling
  column, before the joining and bring-your-own-data panels went in under the graph, and the whole
  arrangement was replaced on 2026-07-28: the graph is the page, the panels are tabs of a dock, and
  the two measured numbers are pinned in frame rather than reached by scrolling. Every wide shot in
  the lock is therefore wrong, and one instruction it was built around is now obsolete rather than
  merely longer, since there is no page scroll to perform. `scripts/video.mjs` drives buttons rather than
  pixels so it needs no change, but the take does: the reference has to be shot again from the top
  before anything is cut from it. Nothing has been re-recorded yet.
- **The README's images and GIFs are of that same previous layout**, and are flagged as such in the
  README itself rather than quietly left to misdescribe the page.
