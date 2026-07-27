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

Counts on 2026-07-26: 375 unit tests across 17 files, 183 python self-checks across 7 modules,
96 live tests across 10 files, 121 browser checks across two viewports. Live runs are single
observations unless their entry says otherwise.

Nothing in the unit or python columns uses a stand-in for a system boundary; that rule and its
origin are in [`CLAUDE.md`](../CLAUDE.md). The browser suite replays recorded or invented
snapshots and says which is which in each fixture's header.

## Pipeline shapes

| shape                           | proven by                                                                                                                                                                                                  | kind         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| chain, three hops deep          | `report_riders` marked at 3 hops through two intermediate tables, live runs of 2026-07-24                                                                                                                  | run, live    |
| diamond (two paths, one target) | "reports a task reachable two ways once, at its shortest distance", `tests/staleness.test.ts`                                                                                                              | unit         |
| fan-out                         | five borough marts off one table in `agents/scale.py`, walked by its own self-check against the derived descendant map                                                                                     | python, run  |
| fan-in                          | the six-way city summary in `agents/scale.py`, same self-check; "handles several tables changing at once", `tests/staleness.test.ts`                                                                       | python, unit |
| cycle                           | "terminates on a cycle instead of looping forever" and "terminates on a cycle of tasks that keep each other flagged", `tests/staleness.test.ts`; the layout's cycle case in `tests/cockpit-layout.test.ts` | unit         |
| the four-task demo              | every file in `tests/live/`, plus seven recorded full sequences 2026-07-22 to 2026-07-24                                                                                                                   | live, run    |
| forty tasks, concurrent         | the 2026-07-24 scale runs: 41 real Codex sessions, peak 8 at once, mid-run change, parallel repair                                                                                                         | run          |
| an outside agent joining        | `tests/live/obsel-mcp.live.test.ts` registers, works and cascades through the MCP door; a joined fifth task lays out on the demo's shape in `tests/cockpit-layout.test.ts`                                 | live, unit   |

## Kinds of change

| change                                           | proven by                                                                                                                                                                                        | kind                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| column rename (schema moves, values do not)      | "distinguishes a column rename from new rows", `tests/staleness.test.ts`; "rename moves schema only", `agents/fingerprint.py`; the demo's own change, live and recorded                          | unit, python, live, run |
| the same rename in the other direction           | the reverse rename marked the same nine tasks at the same hops, 2026-07-24, measured 6391 ms and again at 3184 ms                                                                                | run                     |
| value edit (content moves, schema does not)      | "edited value moves content only", `agents/fingerprint.py`; "calls a content-only change content, and records no columns for it", `tests/live/engine.live.test.ts`                               | python, live            |
| added column (both move)                         | "added column moves both", `agents/fingerprint.py`; "handles additions and removals on their own", `tests/staleness.test.ts`                                                                     | python, unit            |
| identical re-run marks nothing                   | unit, the engine live suite, the MCP live suite, and at forty tasks: a byte-identical re-run of the changed task marked zero of 40, 2026-07-24                                                   | unit, live, run         |
| identical redo of flagged work clears downstream | `restoredBy` block in `tests/staleness.test.ts`; "clears the two-hop task without a re-run", `tests/live/obsel-mcp.live.test.ts`; repairs of 2026-07-24 cleared 1, 2 and 3 tasks without re-runs | unit, live, run         |
| changed redo cascades instead of clearing        | "clears nothing when the redo changed its output", `tests/staleness.test.ts`; `docs_marts` redo landing different in the 2026-07-24 repair                                                       | unit, run               |
| unreported edit (nothing announced it)           | "a change noticed by a reader, not reported by a writer" block, `tests/staleness.test.ts`; "a change nothing reported is caught by the next honest read", `tests/live/engine.live.test.ts`       | unit, live              |
| a change landing mid-swarm                       | the 2026-07-24 scale run: 8 of 40 marked in a measured 13,349 ms while 9 agents were in flight and untouched                                                                                     | run                     |
| a reader straddling a re-report                  | `classifyObservation` and `supersededMark` blocks, `tests/staleness.test.ts`; three deterministic live tests in `tests/live/engine.live.test.ts`                                                 | unit, live              |
| a change to work in flight                       | "does not mark a task that is still running" and "stops walking at a running task", `tests/staleness.test.ts`                                                                                    | unit                    |

## Data edge cases

| case                             | proven by                                                                                                                                                                             | kind        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| the same number written two ways | "217 and 217.0 reach the same fingerprint", `agents/worker.py` self-check, from a live incident                                                                                       | python      |
| integer ids staying integers     | "an integer id column stays an integer", `agents/worker.py`                                                                                                                           | python      |
| row order                        | "row order ignored: reversed rows hash identically", `agents/fingerprint.py`                                                                                                          | python      |
| dict key order                   | "dict insertion order ignored", `agents/fingerprint.py`                                                                                                                               | python      |
| a table with columns and no rows | accepted as a real result, `agents/mcp_core.py`; the no-rows-at-all guard refused a genuinely empty Staten Island mart live, which reshaped the taxi pipeline (see `agents/scale.py`) | python, run |
| a table that is not a table      | "a file that is not a table is rejected rather than half-read", `agents/worker.py`; same by shape at the MCP door, `agents/mcp_core.py`                                               | python      |
| an undeclared output             | refused, naming what was declared, `agents/mcp_core.py`                                                                                                                               | python      |
| a missing input file             | "an agent that cannot read its input never tells obsel it began", `tests/live/run-task.live.test.ts`                                                                                  | live        |
| real public data at scale        | one week of NYC yellow-taxi trips, 2,100 rows pinned by sha256, provenance in `agents/seeds/PROVENANCE.md`                                                                            | run         |
| stability across processes       | "stable across processes, PYTHONHASHSEED=12345", `agents/fingerprint.py`                                                                                                              | python      |

## The operational cases

These are not shapes or data. They are the ways a live swarm goes wrong, each exercised for real.

| case                                    | proven by                                                                                                                                                                                        | kind               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| an agent dies after announcing          | the hand-back path in `tests/live/worker.live.test.ts` and `run-task.live.test.ts`; real Codex timeouts on 2026-07-24 left nothing wedged and the re-runs resumed                                | live, run          |
| a client timeout on a landed completion | observed live 2026-07-24: the cascade coordinated server-side while a 60 s client gave up; the marks were correct and the mutation ceiling is now 300 s (`MUTATION_TIMEOUT`, `agents/worker.py`) | run                |
| obsel unreachable                       | a port nothing listens on, `tests/live/` preflights and `agents/worker.py` error paths                                                                                                           | live               |
| the Codex CLI missing                   | a PATH that genuinely lacks it, `tests/live/codex.live.test.ts`                                                                                                                                  | live               |
| a failed read on the board              | every measured number withheld, `e2e/cockpit.spec.ts` honesty block                                                                                                                              | browser            |
| the repair scheduler's hard cases       | producers before consumers, exactly the flagged set, no-op on a clean board, cancel of a completed redo refused: `agents/run.py` and `agents/swarm.py` self-checks                               | python             |
| DataHub half down, traversal gone       | the real search container stopped 2026-07-24, `docs/verification.md`; the prerequisite check goes red and the board offers the fix                                                               | run                |
| pointed at DataHub's frontend port      | `:9002` answering 200 to both probes, `tests/live/preflight.live.test.ts`                                                                                                                        | live               |
| somebody's own agent part way through   | the four joining steps over seeded boards, `tests/cockpit-joining.test.ts`; painted and folded, `e2e/cockpit.spec.ts` "bring your own agent"; a real MCP session ticking all four, 2026-07-24    | unit, browser, run |

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

- **A dropped column, live.** The fingerprint arithmetic covers it (a removal moves the schema
  hash) and `columnChange` names removals, but no live run has dropped a column; every executed
  live change is a rename or a value edit.
- **Unicode content.** The taxi zone names are plain ASCII and no test feeds a non-ASCII table
  through the fingerprint path. Nothing is known to break; nothing is proven either.
- **Null values inside rows.** "added column moves both" adds nulls to every row, so nulls pass
  through the hash path there, but no case exercises null handling on its own.
- **Wide tables.** The widest executed table is seven columns.
- **A recorded board with somebody's own agent on it.** The joining panel's browser tests run
  against an invented fixture, `visiting()` in `e2e/fixtures/swarm.ts`, which says so in its own
  header. The shape it invents was checked against a real MCP session on 2026-07-24, and that
  session found a defect the earlier fixture had hidden, so the fixture is now shaped like what the
  door genuinely emits. What is still missing is a capture: no visiting agent's `/api/swarm` has
  been recorded to disk the way the forty-task board's two fixtures were.
- **Two swarms changing at once.** Every concurrent run is one swarm on one flow.
- **Any machine other than one laptop, any DataHub other than quickstart `v1.5.0.6`.**

The demo scripts and the video will draw only on executed rows.
