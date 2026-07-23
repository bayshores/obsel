# Sample outputs

These files let you judge what obsel produces without standing up DataHub, Docker, or the
dashboard. Read them in the order below.

## These came off a real run

Captured on **2026-07-23** from `agents/.venv/bin/python -m agents.run change --capture`, against a
live DataHub (GMS `v1.5.0.6`, quickstart) with a signed-in Codex CLI. The run that produced them was
`reset` → `register` → `run` → `change`, which completed and exited 0 with every step's own
assertions passing.

Re-captured that day because the wording of `reason` changed at the source: it now names tables and
tasks in words (`clean orders`, `Daily revenue`) rather than in warehouse identifiers. The previous
capture was a faithful record of a sentence the code no longer produces, and keeping it would have
made the claim below — that these sentences are exactly what `staleness.ts` builds — quietly false.
These files also carry the `title` and `description` each agent registers, which the earlier capture
predated.

A browser-driven `change` the same day marked the same three tasks in 3424 ms, but that was a
separate run and no number from it is quoted here as though it belonged to this one.

**All five files come from that one `change`.** They are written together or not at all, because a
set assembled from separate runs would look coherent and not be — the fingerprints in
`swarm-before.json` would belong to a table other than the one `coordination-result.json` reports
on, which is the exact kind of quiet disagreement obsel exists to catch.

Claim by claim, so you can check rather than trust:

| Claim                                                                                              | Status                                                                                              |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Every file conforms to the current TypeScript contracts, field by field                            | Verified — see [Checking the shapes](#checking-the-shapes-against-the-types)                        |
| Every digest is genuine sha256 output of `agents/fingerprint.py` **over the rows it was taken on** | Verified — one command, see [Reproducing the fingerprints](#reproducing-the-fingerprints)           |
| The tables those digests were taken over are what four live Codex agents wrote                     | Captured, in `tables/` — not hand-written                                                           |
| The `reason` sentences are exactly what `staleness.ts` builds for these hops and this change kind  | Verified against `reasonFor()` as it stands in this commit                                          |
| The `title` and `description` on each task are what the agent registered, read back out of DataHub | Verified — they round-trip through `obsel.title` and the DataJob description                        |
| The order of `affected` is the traversal's own order                                               | Verified against `affectedBy()` — hop 1 first, then hop 2 sorted by URN                             |
| The timestamps                                                                                     | Real, from the run                                                                                  |
| `elapsedMs` and `detectedMs`                                                                       | **Measured.** 745 ms, the coordinator's own figure for this completion.                             |
| That another run would produce these same tables                                                   | **No.** Column names and number formats are held to a contract; rows and prose are the agents' own. |

## The scenario

Four agent tasks build a small pipeline. Arrows are data, not messages.

```
raw_orders --> [clean_orders] --> clean_orders --> [build_revenue] --> daily_revenue
                                                                            |
                                                    +-----------------------+-----------------------+
                                                    |                                               |
                                             [write_report]                                   [write_docs]
                                                    |                                               |
                                             revenue_report                                  pipeline_docs
```

All four finish. Then `clean_orders` runs again and renames one column, `order_total` to
`order_total_usd`. Nothing else about the data changes: same rows, same values.

What the agents actually produced, from `tables/before.json`:

| Table            | Rows | Columns                                                       |
| ---------------- | ---- | ------------------------------------------------------------- |
| `raw_orders`     | 50   | `order_id, customer, order_total, order_date`                 |
| `clean_orders`   | 39   | `order_id, customer, order_total, order_date`                 |
| `daily_revenue`  | 5    | `order_date, total_revenue, order_count, average_order_value` |
| `revenue_report` | 4    | `section, heading, text`                                      |
| `pipeline_docs`  | 5    | `section, heading, text`                                      |

`clean_orders` dropped 11 of the 50 seed rows — cancellations and refunds — which is the agent's
own judgement, not a rule in the code.

## The files

### `swarm-before.json` — everything finished, everything true

The response shape of `GET /api/swarm`: a `SwarmSnapshot` plus the two derived lists the dashboard
needs (`ready`, `blocked`). Both are empty here because no task is waiting to start.

Look for:

- Four tasks, all `"status": "complete"`, all with `"stale": null`.
- `name`, `title` and `description` on each task, which are three different things and all three are
  read back out of DataHub rather than mapped in the dashboard. `name` is the identifier the URN is
  built from (`clean_orders`); `title` is the human name the agent registered as the `obsel.title`
  custom property (`Orders cleaner`); `description` is its one-sentence job, stored as the DataJob's
  own description (`cleans the raw orders export into a tidy four-column table`). A task registered
  without a title still reads as words — the fallback de-underscores `name` — so an unknown pipeline
  is legible without anything being hard-coded for this one.
- `reads` and `writes` hold dataset URNs. These are not a description of the dependency — they are
  the actual `Consumes` and `Produces` lineage edges in DataHub. The graph is the coordination.
- Each task carries a `fingerprints` entry per dataset it wrote, recorded at the moment it
  finished. That record is what everything later gets judged against.
- `startedAt` and `run` on each task. `run` is what the agent reported about itself — which runner,
  how long, how many rows, which columns — and it is display material only. obsel decides nothing
  on it, and a completion that omits it gets an identical staleness answer.
- `revenue_report` and `pipeline_docs` carry the **same `schema` digest** and different `content`
  digests. Both write tasks are held to the columns `["section", "heading", "text"]`, so any run at
  all must produce two tables of identical shape holding different documents.

### `swarm-after.json` — the same swarm, 129 seconds later

Look for:

- `clean_orders` is still `complete`, with a newer `finishedAt` and a **changed `schema` digest**:
  `8c258e10…` became `f7b62a66…`. Its `content` digest is character-for-character the same,
  `539b5097…` in both files. That is what a pure rename looks like, and it is why obsel reports
  `"changeKind": "schema"` rather than "something changed".
- The other three are `"status": "stale"`, each carrying a `stale` mark.
- `build_revenue` is at `"hops": 1`. It read the renamed table itself.
- **`write_report` and `write_docs` are at `"hops": 2`.** Neither has `clean_orders` anywhere in
  its `reads`. They read `daily_revenue`. They are flagged because the thing they were built on is
  itself now built on something that moved. This is the part worth checking carefully — a tool that
  only flagged direct dependents would leave these two sitting there looking finished.
- All three marks name the same `causedBy`: the `clean_orders` dataset, the table that actually
  moved, not the intermediate one the leaves happen to touch. `causedByTask` names the task that
  wrote it, so the trail leads back to a responsible actor rather than to a table.
- The two-hop `reason` names `Daily revenue` — the task in between, by the human name it registered
  as `obsel.title`. The one-hop `reason` names the table. They are deliberately different sentences,
  because the useful explanation is different. Both spell their subject in words rather than in
  warehouse identifiers, which is decided in `reasonFor()` rather than at render time, so the
  sentence stored on the mark and the sentence on the dashboard are the same string. The exact
  identifiers are on `causedBy` and `causedByTask` beside them.
- `finishedAt` on the stale tasks is unchanged, and so are their fingerprints. They have not re-run.
  Only the verdict changed.
- Each mark carries `detectedMs: 745` — the coordinator's own measurement of how long the whole
  job took, from the completion report arriving to every mark being written and confirmed in
  DataHub.

### `coordination-result.json` — the answer to one completion report

What `POST /api/tasks/complete` returned when `clean_orders` reported the re-run. This is the whole
loop in one object.

Look for:

- `changedOutputs` has exactly one entry. obsel compares fingerprints; it never treats "a write
  happened" as "something changed". An identical re-run produces an empty `changedOutputs` and an
  empty `affected`, which is what the `rerun-same` step demonstrates.
- `affected` is in traversal order: hop 1 first, then hop 2 sorted by URN. It is deterministic —
  the same graph gives the same order no matter what order the tasks were registered in. Here that
  puts `write_docs` before `write_report`, which is URN order, not importance.
- Each `affected[].task` still says `"status": "complete"` with `"stale": null`. That is not a
  mistake. `AffectedTask` is the coordinator's decision _before_ the mark is written back, so it
  carries each record as it was found. The `mark` beside it is byte-identical to the one that ends
  up on the same task in `swarm-after.json`.
- Every mark's `detectedMs` equals the result's `elapsedMs`. That is what `engine.ts` does: it
  measures the call once and stamps that one figure onto every mark from it.

**`elapsedMs: 745` is a measurement, not a placeholder.** It covers the whole call: reading the
graph, comparing fingerprints, deciding, and writing every mark back including the DataHub tag,
each confirmed by bounded polling. It is one observation on one machine against the quickstart
stack, not a benchmark — the same step measured 3424 ms when driven from the browser earlier the
same day, and 2591 ms and 3796 ms on runs the day before. The spread is dominated by how long
DataHub takes to confirm the writes, not by the deciding.

### `tables/before.json` and `tables/after.json`

The five tables as they were on disk either side of the change, keyed by short name. These are what
make every digest above checkable rather than something to take on trust: `reproduce_fingerprints.py`
recomputes each one from these rows.

`clean_orders` is the only table that differs between the two files, because it is the only task
that ran again.

## Reproducing the fingerprints

`OutputFingerprint` splits a fingerprint in two so a rename can be told apart from a refresh:
`schema` moves when the columns move, `content` moves when the values move. The rule lives in
[`agents/fingerprint.py`](../agents/fingerprint.py) — it is the demo workers' code, not the
coordinator's. obsel's engine never looks at data; it compares two strings an agent handed it.

One command recomputes **every** digest in these three files, from the captured rows, and checks
each one against what is stored:

```
python3 examples/reproduce_fingerprints.py
```

Exit code 0 means every digest here is genuine sha256 output of `agents/fingerprint.py` over the
table it prints. Change any digit in any JSON file, or any row in `tables/`, and it fails. It also
asserts five properties that must hold for any run at all:

- the rename moves `schema` and leaves `content` identical
- the renamed column is the only column that differs
- both write tasks share a `schema` digest
- the two write tasks differ in `content`
- the three tables that did not re-run have identical digests on both sides — they were stale
  because of what they were built on, not because they changed

### What another run would and would not reproduce

Codex is a live agent, so this capture is one run rather than the run.

**Held to a contract, so any run gives these:** the column names, which
[`agents/pipeline.py`](../agents/pipeline.py) names explicitly and the worker enforces; the three
`["section", "heading", "text"]` columns on both write tasks; and the serialised form of every
number, which `worker.canonicalise_numbers` fixes per column. That last one exists because it went
wrong — one run wrote a money value `217` where another wrote `217.0`, which is the same number,
different bytes, and a moved content digest for a table nobody changed.

**The agents' own work, so another run may differ:** which rows `clean_orders` judges to be
cancellations, the aggregate values that follow from that, and every sentence in `revenue_report`
and `pipeline_docs`.

### Checking one digest by hand

If you would rather not run the script:

```python
import json, sys; sys.path.insert(0, "agents")
from fingerprint import fingerprint

tables = json.load(open("examples/tables/before.json"))
clean = tables["clean_orders"]
print(fingerprint(clean["rows"], clean["columns"]))
# schema  8c258e109bf37ce25d415f5285bc8a36bc9630e48b56cdbe134f2e3ee4dd1e88
# content 539b509722e80da31975ad2bb984ac6e3aaccbedb7750514fa2008fe2de2bfaf
```

Swap `before.json` for `after.json` and the schema digest becomes
`f7b62a6671ac038d27b492bb8842def34ef451c455fa7314222a0e0ad0203c1b` while the content digest does
not move at all. That single property is the reason the mark in `swarm-after.json` can say "its
columns changed" instead of "something changed".

`python3 agents/fingerprint.py` runs the fingerprint module's own self-check, which asserts the
rename property along with row-order independence and stability across processes.
`agents/.venv/bin/python -m agents.worker` runs the output contract's self-check.

## Checking the shapes against the types

Every file here should assign cleanly to the interfaces in
[`src/server/coordinator/types.ts`](../src/server/coordinator/types.ts). To check that yourself,
put this in a `.ts` file anywhere in the repository and run `npx tsc --noEmit` on it:

```ts
import before from "./examples/swarm-before.json";
import after from "./examples/swarm-after.json";
import coordination from "./examples/coordination-result.json";
import type { CoordinationResult, SwarmSnapshot, TaskRecord } from "./src/server/coordinator/types";

interface SwarmResponse {
  snapshot: SwarmSnapshot;
  ready: TaskRecord[];
  blocked: { task: TaskRecord; waitingOn: string[] }[];
}

// `resolveJsonModule` widens every string in an imported JSON file to `string`, so the
// literal unions and the `Record` index signature need this one relaxation and nothing else.
type JsonShape<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends null
        ? null
        : T extends readonly (infer E)[]
          ? JsonShape<E>[]
          : T extends object
            ? string extends keyof T
              ? { [K in keyof T]: JsonShape<T[K]> | undefined }
              : { [K in keyof T]: JsonShape<T[K]> }
            : T;

const a: JsonShape<SwarmResponse> = before;
const b: JsonShape<SwarmResponse> = after;
const c: JsonShape<CoordinationResult> = coordination;
```

Be aware of what that does and does not prove. It proves every required field is present, correctly
nested, and of the right kind, including the nullability of `stale`, `finishedAt`, `startedAt`,
`run`, `causedByTask` and `detectedMs` — delete any one of those fields and it stops compiling. It
does **not** prove the literal strings are members of their unions (`"status": "complet"` would
still type-check), because TypeScript cannot see JSON string literals through `resolveJsonModule`.
Those values were checked separately by walking the files and comparing against the unions in
`types.ts`.

## What is not in here

- **The DataHub side.** These are obsel's HTTP responses. What lands in DataHub is a `DataJob` per
  task, `Consumes`/`Produces` edges, the `urn:li:tag:obsel-stale` tag, and the `obsel.*` custom
  properties listed in [`docs/architecture.md`](../docs/architecture.md).
- **Failure shapes.** The API's error responses are not sampled here.
- **The quiet case.** An identical re-run returns a `CoordinationResult` with empty `changedOutputs`
  and empty `affected`, which is the behaviour the whole design rests on. It has been observed
  live — `rerun-same` reported 0 changed outputs and 0 marks on a separate run the same day — but
  this capture did not include that step, so there is no sample of it here.
- **The coordinator's trace.** `GET /api/trace` narrates the steps obsel took to reach this answer
  — the read, each fingerprint comparison, the lineage walk, each mark. It is deliberately not
  captured here: it is in-memory narration of one process, not a record, and the record is these
  files and the marks in DataHub.
