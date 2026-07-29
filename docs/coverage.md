# What obsel has been tested against

A judge deciding whether to trust obsel should not have to take "it works" on faith, and should
not have to read seven test files to check. This is the executed matrix: the pipeline shapes, the
kinds of change, and the data edge cases obsel has actually been run against, each row naming the
test or the recorded run that proves it.

Two rules, the same ones [`verification.md`](verification.md) follows. **Every row here was
executed**; a case nobody has run is in [Not covered](#not-covered) rather than quietly missing.
And a row names its evidence precisely enough to re-run it or look it up.

## How to read the evidence column

| kind    | what it means                                                          | re-run with        |
| ------- | ---------------------------------------------------------------------- | ------------------ |
| unit    | deterministic test over the pure decision logic, no processes stood up | `pnpm test`        |
| python  | a module's own self-check, real files and real temporary directories   | `pnpm test:python` |
| live    | integration test against a real DataHub, real MCP server, real obsel   | `pnpm test:live`   |
| browser | Playwright against the built app                                       | `pnpm e2e`         |
| run     | a dated, measured run recorded in [`verification.md`](verification.md) | see its entry      |

Counts measured on 2026-07-28 after the files were split along their seams: **531 unit tests across
28 files, 202 python self-checks across 9 modules, 272 browser checks across two viewports with one
skipped**, and 104 live tests across 11 files. No test was added or removed in that split — the unit
and browser totals are the same runs redistributed, and the python total gained the nine checks
`agents/mcp_erasure.py` took with it out of `agents/mcp_core.py`. The live figure is from 2026-07-26
plus the two added to `preflight.live.test.ts` on 2026-07-27 and the six in `removed.live.test.ts` on
2026-07-28; those two files are the only live ones re-run since, and nothing in the split crosses a
process boundary, so none of it needed re-running. Live runs are single observations unless their
entry says otherwise.

Nothing in the unit or python columns uses a stand-in for a system boundary; that rule and its
origin are in [`CLAUDE.md`](../CLAUDE.md). The browser suite replays recorded or invented
snapshots and says which is which in each fixture's header.

## Pipeline shapes

| shape                                                      | proven by                                                                                                                                                                                                    | kind         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| chain, three hops deep                                     | `report_riders` marked at 3 hops through two intermediate tables, live runs of 2026-07-24                                                                                                                    | run, live    |
| diamond (two paths, one target)                            | "reports a task reachable two ways once, at its shortest distance", `tests/staleness.test.ts`                                                                                                                | unit         |
| fan-out                                                    | five borough marts off one table in `agents/scale.py`, walked by its own self-check against the derived descendant map                                                                                       | python, run  |
| fan-in                                                     | the six-way city summary in `agents/scale.py`, same self-check; "handles several tables changing at once", `tests/staleness.test.ts`                                                                         | python, unit |
| cycle                                                      | "terminates on a cycle instead of looping forever" and "terminates on a cycle of tasks that keep each other flagged", `tests/staleness.test.ts`; the layout's cycle case in `tests/dashboard-layout.test.ts` | unit         |
| the four-task demo                                         | every file in `tests/live/`, plus seven recorded full sequences 2026-07-22 to 2026-07-24                                                                                                                     | live, run    |
| forty tasks, concurrent                                    | the 2026-07-24 scale runs: 41 real Codex sessions, peak 8 at once, mid-run change, parallel repair. Not repeated on Claude Code                                                                              | run          |
| an outside agent joining                                   | `tests/live/obsel-mcp.live.test.ts` registers, works and cascades through the MCP door; a joined fifth task lays out on the demo's shape in `tests/dashboard-layout.test.ts`                                 | live, unit   |
| a two-task chain registered from the page, not by an agent | the run of 2026-07-26 below: `clean_expenses` then `monthly_totals` typed into the form against a real DataHub on an isolated flow, both read back off `/api/swarm` with their lineage, and drawn            | run, browser |

## Kinds of change

| change                                           | proven by                                                                                                                                                                                        | kind                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| column rename (schema moves, values do not)      | "distinguishes a column rename from new rows", `tests/staleness.test.ts`; "rename moves schema only", `agents/fingerprint.py`; the demo's own change, live and recorded                          | unit, python, live, run |
| the same rename in the other direction           | the reverse rename marked the same nine tasks at the same hops, 2026-07-24, measured 6391 ms and again at 3184 ms                                                                                | run                     |
| value edit (content moves, schema does not)      | "edited value moves content only", `agents/fingerprint.py`; "calls a content-only change content, and records no columns for it", `tests/live/engine.live.test.ts`                               | python, live            |
| added column (both move)                         | "added column moves both", `agents/fingerprint.py`; "handles additions and removals on their own", `tests/staleness.test.ts`                                                                     | python, unit            |
| a column registered as volatile                  | `agents/fingerprint.py` self-check: its value does not move content, a real change beside it still does, its NAME still moves the schema, an absent column is a no-op, excluding every column is refused; `agents/mcp_core.py` self-check on the per-dataset lookup and the two-writer conflict; `tests/register-body.test.ts` on the declaration's shape; `tests/staleness.test.ts` on the sentence naming what was ignored; `tests/live/volatile.live.test.ts` registers one against real DataHub, reads the property back, refuses a changed list, marks nothing on a timestamp-only re-run, and still marks a real change | python, unit, live |
| identical re-run marks nothing                   | unit, the engine live suite, the MCP live suite, and at forty tasks: a byte-identical re-run of the changed task marked zero of 40, 2026-07-24                                                   | unit, live, run         |
| identical redo of flagged work clears downstream | `restoredBy` block in `tests/staleness.test.ts`; "clears the two-hop task without a re-run", `tests/live/obsel-mcp.live.test.ts`; repairs of 2026-07-24 cleared 1, 2 and 3 tasks without re-runs | unit, live, run         |
| changed redo cascades instead of clearing        | "clears nothing when the redo changed its output", `tests/staleness.test.ts`; `docs_marts` redo landing different in the 2026-07-24 repair                                                       | unit, run               |
| unreported edit (nothing announced it)           | "a change noticed by a reader, not reported by a writer" block, `tests/staleness.test.ts`; "a change nothing reported is caught by the next honest read", `tests/live/engine.live.test.ts`       | unit, live              |
| a change landing mid-swarm                       | the 2026-07-24 scale run: 8 of 40 marked in a measured 13,349 ms while 9 agents were in flight and untouched                                                                                     | run                     |
| a reader straddling a re-report                  | `classifyObservation` and `supersededMark` blocks, `tests/staleness.test.ts`; three deterministic live tests in `tests/live/engine.live.test.ts`                                                 | unit, live              |
| a change to work in flight                       | "does not mark a task that is still running" and "stops walking at a running task", `tests/staleness.test.ts`                                                                                    | unit                    |

## Data edge cases

| case                                                 | proven by                                                                                                                                                                                                                                                               | kind        |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| the same number written two ways                     | "217 and 217.0 reach the same fingerprint", `agents/worker.py` self-check, from a live incident                                                                                                                                                                         | python      |
| integer ids staying integers                         | "an integer id column stays an integer", `agents/worker.py`                                                                                                                                                                                                             | python      |
| row order                                            | "row order ignored: reversed rows hash identically", `agents/fingerprint.py`                                                                                                                                                                                            | python      |
| dict key order                                       | "dict insertion order ignored", `agents/fingerprint.py`                                                                                                                                                                                                                 | python      |
| a table with columns and no rows                     | accepted as a real result, `agents/mcp_core.py`; the no-rows-at-all guard refused a genuinely empty Staten Island mart live, which reshaped the taxi pipeline (see `agents/scale.py`)                                                                                   | python, run |
| a table that is not a table                          | "a file that is not a table is rejected rather than half-read", `agents/worker.py`; same by shape at the MCP door, `agents/mcp_core.py`                                                                                                                                 | python      |
| an undeclared output                                 | refused, naming what was declared, `agents/mcp_core.py`                                                                                                                                                                                                                 | python      |
| a missing input file                                 | "an agent that cannot read its input never tells obsel it began", `tests/live/run-task.live.test.ts`                                                                                                                                                                    | live        |
| real public data at scale                            | one week of NYC yellow-taxi trips, 2,100 rows pinned by sha256, provenance in `agents/seeds/PROVENANCE.md`                                                                                                                                                              | run         |
| stability across processes                           | "stable across processes, PYTHONHASHSEED=12345", `agents/fingerprint.py`                                                                                                                                                                                                | python      |
| a name that would build a URN nobody could read back | `clean,orders` and `a.b.c` refused at both doors: `tests/register-body.test.ts`, which reads the pattern out of `agents/mcp_core.py` and asserts it identical, and the browser form's own copy held against `datasetNameProblem` in `tests/dashboard-your-data.test.ts` | unit        |

## The operational cases

These are not shapes or data. They are the ways a live swarm goes wrong, each exercised for real.

| case                                      | proven by                                                                                                                                                                                                                                                                                                                                                | kind               |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| an agent dies after announcing            | the hand-back path in `tests/live/worker.live.test.ts` and `run-task.live.test.ts`; real Codex timeouts on 2026-07-24 left nothing wedged and the re-runs resumed                                                                                                                                                                                        | live, run          |
| a client timeout on a landed completion   | observed live 2026-07-24: the cascade coordinated server-side while a 60 s client gave up; the marks were correct and the mutation ceiling is now 300 s (`MUTATION_TIMEOUT`, `agents/obsel_client.py`)                                                                                                                                                   | run                |
| obsel unreachable                         | a port nothing listens on, `tests/live/` preflights and `agents/worker.py` error paths                                                                                                                                                                                                                                                                   | live               |
| the agent CLI missing                     | a PATH that genuinely lacks it, `tests/live/runners.live.test.ts`, once per installed runner; the message names the CLI that is gone and offers the other one                                                                                                                                                                                            | live               |
| an agent CLI named that is not there      | an explicit `OBSEL_RUNNER` for an uninstalled CLI is reported as that CLI missing, never swapped for the other, `agents/runner_select.py` self-check and `scripts/start.sh` step 8                                                                                                                                                                       | python             |
| no agent CLI at all                       | the setup checklist names both and offers no command, `tests/dashboard-guide.test.ts` and `e2e/dashboard.spec.ts`; looked at on 2026-07-28                                                                                                                                                                                                               | unit, browser      |
| Claude Code reading obsel's own CLAUDE.md | two runs of one prompt in one directory on 2026-07-28, differing only by `--safe-mode`: without it the agent obeyed a parent CLAUDE.md and added a key the prompt never asked for. Asserted in `tests/live/runners.live.test.ts`                                                                                                                         | run, live          |
| a failed read on the page                 | every measured number withheld, `e2e/dashboard-honesty.spec.ts` honesty block                                                                                                                                                                                                                                                                            | browser            |
| the tour, at every point in it            | `tests/dashboard-guide.test.ts` "the tour": a page somebody else drove, a step that failed, a reset walking it back, a repaired page reading as repaired rather than as one that only ran, the taxi swarm; `e2e/dashboard.spec.ts` walks chapter one region by region and checks an action step offers no way past itself until the page has done it     | unit, browser      |
| the tour window itself                    | `e2e/dashboard.spec.ts`: the opener is emphasised on a first visit and quiet after one, across a reload; dragging by the bar moves it; Escape closes it and unlights the page; under reduced motion it arrives finished and still drags                                                                                                                  | browser            |
| the guide pointing at the page            | `tests/dashboard-guide.test.ts` "where the guide points": the sentence and the ringed URNs per stage, the unmarked agent left alone on a flagged pipeline, a repaired page reading as repaired, a failed re-run saying nothing; `e2e/dashboard.spec.ts` rings four boxes and not the clean one, and a ring does not swallow the click that opens its box | unit, browser      |
| the repair scheduler's hard cases         | producers before consumers, exactly the flagged set, no-op on a clean page, cancel of a completed redo refused: `agents/run.py` and `agents/swarm.py` self-checks                                                                                                                                                                                        | python             |
| work broken by more than one change       | `tests/staleness.test.ts`: two origins reaching one task recorded as two causes with their own distances, two paths from one origin still one cause, `mergeMark` accumulating across cascades and updating a repeat rather than listing it twice, a pre-causes mark read as carrying its own; `restoredBy` refusing to clear while a second recorded cause stands; `tests/live/engine.live.test.ts` reads both causes back off the real DataHub property after two cascades, and finds them gone after the task's own redo | unit, live         |
| the repair ORDER obsel derives            | `tests/rerun-plan.test.ts`: waves, a reader behind every writer of a shared table, unflagged work excluded, a cycle reported rather than ordered, a self-edge that is not a cycle, and a wave-0 task withheld while an unflagged producer runs; `tests/live/engine.live.test.ts` reads the same plan off a real cascaded board, and gets none from a clean one; `agents/mcp_core.py` self-check covers the agent's projection | unit, live, python |
| DataHub half down, traversal gone         | the real search container stopped 2026-07-24, `docs/verification.md`; the prerequisite check goes red and the page offers the fix                                                                                                                                                                                                                        | run                |
| pointed at DataHub's frontend port        | `:9002` answering 200 to both probes, `tests/live/preflight.live.test.ts`                                                                                                                                                                                                                                                                                | live               |
| somebody's own agent part way through     | the four joining steps over seeded pages, `tests/dashboard-joining.test.ts`; painted and folded, `e2e/dashboard-joining.spec.ts` "bring your own agent"; a real MCP session ticking all four, 2026-07-24                                                                                                                                                 | unit, browser, run |
| a person reporting a table by hand        | the table that leaves the browser, `tests/dashboard-table-form.test.ts`; a real register-report-rename-report loop against DataHub flagging one hop with its columns named, 2026-07-27 in `verification.md`                                                                                                                                              | unit, run          |
| a swarm that is neither obsel pipeline    | no pipeline-specific button offered when registered, settled or flagged, `tests/dashboard-guide.test.ts`; the same page reached for real at the bench, 2026-07-27                                                                                                                                                                                        | unit, run          |
| uv missing, the quietest prerequisite     | a PATH that genuinely lacks the binary, `tests/live/preflight.live.test.ts`; the page held on the checklist rather than let through, `tests/dashboard-guide.test.ts`                                                                                                                                                                                     | live, unit         |
| the server stopped, both reads failing    | one fault and one report rather than two sentences that disagree, `e2e/dashboard-honesty.spec.ts`; the demo read failing alone still says the page is current, same file; found on a real stopped server 2026-07-27 in `verification.md`                                                                                                                 | browser, run       |
| obsel restarted on a walked page          | reset still offered with an empty launcher history and with no activity read at all, and still withheld from a page that only ran, `tests/dashboard-guide.test.ts`; the same two pages in `e2e/dashboard-honesty.spec.ts`; the signal checked against the recorded repaired forty-task pipeline, which carries it on 3 of 40                             | unit, browser, run |
| an identical re-run after a walk          | the key present with equal hashes does not read as a change, `tests/dashboard-guide.test.ts`; the four `previousFingerprints` cases in `tests/dashboard-joining.test.ts` unchanged across the move                                                                                                                                                       | unit               |
| a task DataHub was told is gone           | the real `status` aspect written to the real GMS and undone again, `tests/live/removed.live.test.ts`, which also measures that the flow's edge still lists it and `batchGet` still returns it; the rogue `clean_trips` removed from the demo page this way on 2026-07-28                                                                                 | live, run          |
| which page is on screen                   | the header names the flow, and its disclosure names `OBSEL_FLOW_ID` as the way to open a different one, `e2e/dashboard-honesty.spec.ts`                                                                                                                                                                                                                  | browser            |
| one action asked for, several offered     | at most one accent per stage across every stage, `tests/dashboard-guide.test.ts`; every action label the same computed size with exactly one colour occurring once, `e2e/dashboard-honesty.spec.ts`                                                                                                                                                      | unit, browser      |

## The page a reader arranges

Added 2026-07-28, when the graph became the page and everything else became one dock beside it.
Every row ran at both viewports, `recording-1920x990` and `laptop-1280x800`.

| condition                                       | proven by                                                                                                                                                                             | kind          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| neither axis of the page ever scrolls           | `e2e/dashboard-layout.spec.ts` "fit" at both viewports; `e2e/scale.spec.ts` on the 82-node page; re-asserted after every rearrangement in `e2e/dock.spec.ts`                          | browser       |
| the activity feed gets a real height            | `e2e/scale.spec.ts`: the taxi pipeline's scroller is at least 280 px and at least as tall as the demo page's, which is the comparison that was inverted before                        | browser       |
| the dock lands on the edge it was carried to    | `e2e/dock.spec.ts`: a real pointer drag by the grip, an outline showing the landing zone before release, and the side surviving a reload                                              | browser       |
| its width is a reader's choice, and is kept     | `e2e/dock.spec.ts`: dragging the inner edge narrows it, the graph takes the difference, and the width survives a reload                                                               | browser       |
| collapsed, it still reports what is out of date | `e2e/dock.spec.ts`: the rail carries the stale count, the graph takes the room, and the panel comes back                                                                              | browser       |
| a tabbed panel is reachable without a mouse     | `e2e/dock.spec.ts` moves the dock by its named buttons; `dock/tabs.tsx` is a real `tablist` with roving focus and arrow keys                                                          | browser       |
| the change spreads outward one hop at a time    | `e2e/dashboard-layout.spec.ts`: each lit edge's animation delay is ordered by the hop count obsel recorded, and hop 2 starts after hop 1                                              | browser       |
| the ripple never replaces the mark it covers    | `e2e/dashboard-layout.spec.ts`: the three marked tasks are amber from `nodeTone` alone, each carries a flare, and no unmarked task carries one                                        | browser       |
| the measured number arrives once and holds      | `tests/dashboard-count-up.test.ts` pins the ends of the curve; `e2e/dashboard-layout.spec.ts` samples the cell twelve times over three seconds and it never leaves the measured value | unit, browser |
| reduced motion shows the finished picture       | `e2e/dashboard-layout.spec.ts`: the lit path stays drawn with no animations attached, and the detection figure is the measured one on the first frame                                 | browser       |
| the tour marks the region it is talking about   | `e2e/dashboard.spec.ts`: across all four chapter-one steps, nothing is painted outside the lit region's box, the ring is inset, and no part of the region falls outside what clips it | browser       |
| the tour window opens clear of the dock         | `e2e/dashboard.spec.ts`: the window's box does not intersect the dock's, with the dock on either side                                                                                 | browser       |

## What a reader can find out about one box

Added 2026-07-28, when the details panel became a surface with three depths. Every row ran at both
viewports. The rows about the table sketch are the ones that matter most: obsel never reads a table,
and the sketch has to be visibly a sketch.

| condition                                         | proven by                                                                                                                                                                                       | kind          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| the page says the boxes respond, before any do    | `e2e/dashboard-graph.spec.ts` "the details surface": the hint is present on a populated page and absent on an empty one, where there is nothing to point at                                     | browser       |
| pointing at a box previews it                     | `e2e/dashboard-graph.spec.ts`: the preview appears on hover, carries the writer and readers, and contains no `urn:li:` anywhere                                                                 | browser       |
| pointing moves nothing in the graph               | `e2e/dashboard-graph.spec.ts`: every node top, the graph's height and the page scroll height are unchanged while a preview is up                                                                | browser       |
| a click pins, Esc unpins, the preview pins itself | `e2e/dashboard-graph.spec.ts`: three tests, one per path into and out of the pinned depth                                                                                                       | browser       |
| what is pinned survives pointing elsewhere        | `e2e/dashboard-graph.spec.ts`: with one node pinned, hovering another leaves the panel naming the pinned one                                                                                    | browser       |
| the panel names its subject exactly once          | `e2e/dashboard-graph.spec.ts`: counts elements whose whole text is the heading, inside the panel. It was three before: title, kind line, heading                                                | browser       |
| a table is sketched from its reported shape       | `e2e/dashboard-graph.spec.ts`: real column names render, `+ order_total_usd` and `- order_total` agree with the mark on the same page, and the caption states the counts and the derivation     | browser       |
| the sketch cannot show a value                    | `e2e/dashboard-graph.spec.ts`: every placeholder block is empty. `Schematic` is passed a column list and a row count, so there is no path by which one could be filled                          | browser       |
| a writer that reported nothing says so            | `e2e/dashboard-graph.spec.ts` on the registered-task fixture: the plain sentence, and no sketch at all                                                                                          | browser       |
| how many rows and columns, drawn versus stated    | `tests/schematic.test.ts`: the drawing caps at six rows; the caption carries the real count, so the cap costs no information                                                                    | unit          |
| the flow highlight lights exactly what it touches | `tests/dashboard-flow.test.ts` (writer, every reader, one hop only, unknown urn empty, id spelling agrees with `layoutPositions`); `e2e/dashboard-graph.spec.ts` counts three on a real page    | unit, browser |
| the cascade is never overdrawn by the highlight   | `e2e/dashboard-graph.spec.ts`: on the cascaded page every edge touching the table is the cascade's, so none is flowing, and the amber is untouched by the click                                 | browser       |
| reduced motion shows the finished panel           | `e2e/dashboard-graph.spec.ts`: field opacity 1, and `animation-name: none` on both a sketch block and a flow edge                                                                               | browser       |
| a table on the coverage page reports its coverage | `e2e/erasure.spec.ts`: the field appears when the graph is coloured by a report, and is absent when the same report has only been read for the tab                                              | browser       |
| the copy sweep's details exclusion is real        | `e2e/dashboard-graph.spec.ts` now runs two of its states with a node pinned open. The exclusion existed for months against a panel that rendered no such label and a sweep that never opened it | browser       |

## Erasure coverage on the page

Added 2026-07-28. The kernel's own rules are covered by `tests/erasure.test.ts`; these are about
what a reader sees, and most of them are about what the page is not allowed to say.

| condition                                    | proven by                                                                                                                                                                 | kind          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| no request named                             | `e2e/erasure.spec.ts`: the tab says so and offers the command that opens one, rather than rendering an empty coverage list                                                | browser       |
| an id obsel does not hold                    | `e2e/erasure.spec.ts`: obsel's own 404 sentence, and no coverage list                                                                                                     | browser       |
| the ledger unreadable                        | `e2e/erasure.spec.ts`: the report is withheld rather than held over, the same rule the page's numbers keep                                                                | browser       |
| a report with every state in it              | `e2e/erasure.spec.ts` over `e2e/fixtures/erasure.ts`: six assets, the summary line, each kernel explanation verbatim, and the residue reasons past the first              | browser       |
| a day-one request                            | `e2e/erasure.spec.ts`: every asset unattested, which is the default the kernel computes as a least fixpoint                                                               | browser       |
| an attestation dropped for a compromised key | `e2e/erasure.spec.ts`: reported at the top of the list, since it is the only way coverage is lost without anybody touching data                                           | browser       |
| the forbidden vocabulary                     | `tests/dashboard-erasure-view.test.ts` over every state and all ten residue kinds; `e2e/erasure.spec.ts` re-checks the rendered page for the words and the enum spellings | unit, browser |
| no way to mark an asset covered              | `e2e/erasure.spec.ts` reads every control in the tab and refuses a label that reads as closing a gap; there is no route either                                            | browser       |
| the graph coloured by coverage               | `e2e/erasure.spec.ts`: tables carry their state, agents carry none, an unreached table says so, and no amber appears anywhere on that page                                | browser       |
| switching it off                             | `e2e/erasure.spec.ts`: the staleness view returns, origin outline and lit edges included                                                                                  | browser       |
| the report states its own limits             | `tests/erasure-limits.test.ts`: the sentences exist, name the lineage scope and the no-credentials fact, and use none of the forbidden words; `tests/live/erasure.live.test.ts` re-checks both on the real route's response | unit, live    |

## The launcher

`scripts/start.sh`, and the `scripts/Start obsel.command` a judge double-clicks. Each row is an executed
condition; the two rows nobody has produced are in `verification.md` under Not done, not here.

| case                                         | proven by                                                                                                                                                             | kind |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| a full setup from nothing but the repository | fresh run 2026-07-27, `.env.local` and `agents/.venv` deleted: 16 s to the page, five prerequisites green                                                             | run  |
| running it twice                             | re-run 2026-07-27: 2.794 s, DataHub skipped, settings kept, environment kept, no second server                                                                        | run  |
| Docker installed but not running             | a real `docker` binary at a socket path that does not exist, `tests/start-script.test.ts`; refused at step 1 naming the daemon, not the binary                        | unit |
| it stops before writing anything             | the same refusal in a scratch copy, asserting `.env.local` and `agents/.venv` were not created, `tests/start-script.test.ts`                                          | unit |
| Finder's bare PATH, which has no nvm         | `env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin`, 2026-07-27: nvm loaded and Node 24 found, where an unrepaired PATH reports Node missing on a machine that has it         | run  |
| a genuinely wrong Node                       | the same with nvm unreachable, against the real Node v22.14.0 in `/usr/local/bin`, 2026-07-27: refused naming the version                                             | run  |
| started from the wrong directory             | the wrapper run from another cwd, reporting the folder it lives in, `tests/start-script.test.ts`                                                                      | unit |
| the shell macOS will actually use            | both files parsed by this machine's `/bin/bash`, which is 3.2, `tests/start-script.test.ts`                                                                           | unit |
| a quarantined download                       | the real `com.apple.quarantine` attribute set, 2026-07-27: `bash scripts/start.sh` runs unaffected. The Finder block itself was not reproduced, see `verification.md` | run  |
| DataHub started from nothing                 | 2026-07-28, backed up and stopped with port 8080 confirmed dead: 450 s to the page, every image pulled, all five flows intact, version unchanged                      | run  |
| the DataHub version a judge gets             | 2026-07-28: `--version v1.5.0.6` alone is refused non-interactively, `--accept-version-default` pins it, and the printed plan and fetched compose file both name it   | run  |

## The erasure cases

Every row in the specification's counterexample table, plus what the attestation layer refuses.
The specification is [`erasure-coverage.md`](erasure-coverage.md) and it was written before the
code, because two earlier drafts of the rule were unsound.

| case                                            | proven by                                                                                                                                      | kind       |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| MERGE or incremental over the prior version     | `tests/erasure.test.ts`, residue `not-total`                                                                                                   | unit       |
| partition overwrite, 3 of 730                   | `tests/erasure.test.ts`, residue `partitions-uncovered`                                                                                        | unit       |
| SCD2 snapshot, out of scope and named           | `tests/erasure.test.ts`                                                                                                                        | unit       |
| an asset with no producing job                  | `tests/erasure.test.ts`; bound to recorded dataset edges rather than a job, which is what Phase 0b measurement forced                          | unit       |
| cyclic lineage A→B→A                            | `tests/erasure.test.ts`; least fixpoint, so neither is promoted on the other's word                                                            | unit       |
| two writers, one clean run                      | `tests/erasure.test.ts`, residue `not-sole-producer`                                                                                           | unit       |
| a write with an identical fingerprint reopens   | `tests/erasure.test.ts`; attestations bind to a version, never a content hash                                                                  | unit       |
| a rebuild declaring less than the catalog knows | `tests/erasure.test.ts`, residue `closure-mismatch`                                                                                            | unit       |
| an attestation saying the subject is present    | `tests/erasure.test.ts`, `CONTRADICTED`                                                                                                        | unit       |
| an unsigned rebuild claim                       | `tests/erasure.test.ts`; found by a surviving mutation, not by design                                                                          | unit       |
| tampering: payload edited, byte flipped         | `tests/attestation.test.ts` over real Ed25519 keys                                                                                             | unit       |
| a re-serialised payload that parses the same    | `tests/attestation.test.ts`; verified over arriving bytes, never a re-encode                                                                   | unit       |
| a challenge replayed, expired, or mismatched    | `tests/attestation.test.ts`; and two concurrent HTTP submissions of one nonce, `tests/live/erasure.live.test.ts`                               | unit, live |
| a key retired, and a key reported compromised   | `tests/attestation.test.ts`; live, coverage reverts with no data touched, `tests/live/erasure.live.test.ts`                                    | unit, live |
| a malformed payload that would crash a check    | `tests/attestation.test.ts`; found by curling `{}` at the real route, which returned a 500                                                     | unit, run  |
| a signed record missing its variant's fields    | `tests/attestation.test.ts`; found by hand-driving the running dashboard — it was accepted and explained nothing, `verification.md` 2026-07-26 | unit, run  |
| an unconfigured obsel asked to write            | `tests/http-auth.test.ts`; and 503 from the running server with no token set, `verification.md` 2026-07-26                                     | unit, run  |
| no route or tool that marks an asset covered    | `tests/live/erasure.live.test.ts` and `tests/live/obsel-mcp.live.test.ts` assert the absence by name                                           | live       |
| a real multi-platform walk from a PII table     | 23 assets over five platforms from `showcase-ecommerce`, one flipped to `ATTESTED` by a real signature, `verification.md` 2026-07-26           | run        |
| column-level lineage riding the same edge       | `tests/live/lineage.live.test.ts`; 109 raw edges, 12 datasets and 97 `schemaField` URNs                                                        | live       |
| a write aimed at a foreign entity               | `tests/live/lineage.live.test.ts`; refused before existence is checked, aspects asserted unchanged                                             | live       |

## Not covered

Held to the same standard as everything above: these are the cases nobody has executed, written
down so the table cannot imply them.

- **The launcher starting DataHub from cold.** Every run of it found DataHub already up, so the
  branch that runs the quickstart and waits for the API is unexecuted, and the 16 s figure in the
  table above is a run that skipped it. What is proven is that the `uvx --from acryl-datahub` form
  resolves and carries a real `docker quickstart` subcommand, which is not the same thing.
- **The Gatekeeper prompt itself.** The real quarantine attribute was set and the documented
  `bash scripts/start.sh` fallback runs against it. The block a judge would actually see is enforced
  by Finder on a GUI launch, which nothing here can drive, so the right-click-Open instruction in
  the README is documented macOS behavior rather than an observed one.
- **The launcher on Linux or Windows.** One macOS machine has run it.
- **A dropped column, live.** The fingerprint arithmetic covers it (a removal moves the schema
  hash) and `columnChange` names removals, but no live run has dropped a column; every executed
  live change is a rename or a value edit.
- **Unicode content.** The taxi zone names are plain ASCII and no test feeds a non-ASCII table
  through the fingerprint path. Nothing is known to break; nothing is proven either.
- **Null values inside rows.** "added column moves both" adds nulls to every row, so nulls pass
  through the hash path there, but no case exercises null handling on its own.
- **Wide tables.** The widest executed table is seven columns.
- **A recorded page with somebody's own agent on it.** The joining panel's browser tests run
  against an invented fixture, `visiting()` in `e2e/fixtures/swarm.ts`, which says so in its own
  header. The shape it invents was checked against a real MCP session on 2026-07-24, and that
  session found a defect the earlier fixture had hidden, so the fixture is now shaped like what the
  door genuinely emits. What is still missing is a capture: no visiting agent's `/api/swarm` has
  been recorded to disk the way the forty-task pipeline's two fixtures were. The 2026-07-26 form run
  narrows this without closing it: two visiting tasks were registered against a real DataHub and
  read back with their lineage, so the shape `visiting()` invents has now been produced by a real
  server as well as by a real MCP session. It still was not written to disk as a fixture.
- **A registration reaching DataHub, from a browser test.** `openDashboard` intercepts
  `/api/tasks/register`, because unstubbed it would create real entities in whatever DataHub the
  machine is pointed at. So no row in the browser column proves a registration lands; the run of
  2026-07-26 in [`verification.md`](verification.md) is the evidence for that, and it is one
  observation by hand rather than a test.
- **Reporting your own file from the page.** Not built. The fingerprint is taken from rows in
  `agents/fingerprint.py`, and a second implementation in the browser would be a second definition
  of a change, so there is deliberately no route for it yet.
- **Two swarms changing at once.** Every concurrent run is one swarm on one flow.
- **Any machine other than one laptop, any DataHub other than quickstart `v1.5.0.6`.**

The demo scripts and the video will draw only on executed rows.
