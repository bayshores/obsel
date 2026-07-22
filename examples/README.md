# Sample outputs

These files let you judge what obsel produces without standing up DataHub, Docker, or the
dashboard. Read them in the order below.

## These are illustrative samples of the shapes, not a captured run

**obsel has not yet been run end to end against a real model.** Nothing in this directory came off
a live run. These files were written by hand on 2026-07-21 to match the contracts in
[`src/server/coordinator/types.ts`](../src/server/coordinator/types.ts), so you can see the shape of
every response and the exact wording of a stale mark. When a real run is captured, this section is
the first thing that should change.

Claim by claim, so you can check rather than trust:

| Claim                                                                                             | Status                                                                                                                   |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Every file conforms to the current TypeScript contracts, field by field                           | Verified — see [Checking the shapes](#checking-the-shapes-against-the-types)                                             |
| The `reason` sentences are exactly what `staleness.ts` builds for these hops and this change kind | Verified against `reasonFor()` — the strings are quoted below                                                            |
| The order of `affected` is the traversal's own order                                              | Verified against `affectedBy()` — hop 1 first, then hop 2 sorted by URN                                                  |
| Every digest is genuine sha256 output of `agents/fingerprint.py`                                  | Verified — one command, see [Reproducing the fingerprints](#reproducing-the-fingerprints)                                |
| The **tables** those digests are taken over are what a run would produce                          | **Not verified for all four.** Two column sets are fixed by code; two are chosen by the model at run time. Detail below. |
| The timestamps                                                                                    | Invented                                                                                                                 |
| `elapsedMs` and `detectedMs`                                                                      | **Placeholders, not measurements.** See the note under `coordination-result.json`.                                       |

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

## The files

### `swarm-before.json` — everything finished, everything true

The response shape of `GET /api/swarm`: a `SwarmSnapshot` plus the two derived lists the dashboard
needs (`ready`, `blocked`). Both are empty here because no task is waiting to start.

Look for:

- Four tasks, all `"status": "complete"`, all with `"stale": null`.
- `reads` and `writes` hold dataset URNs. These are not a description of the dependency — they are
  the actual `Consumes` and `Produces` lineage edges in DataHub. The graph is the coordination.
- Each task carries a `fingerprints` entry per dataset it wrote, recorded at the moment it
  finished. That record is what everything later gets judged against.
- `revenue_report` and `pipeline_docs` carry the **same `schema` digest** and different `content`
  digests. That is not a copy-paste slip. `worker.apply_write` hardcodes the columns
  `["section", "heading", "text"]` for both write tasks, so any run at all must produce two tables
  of identical shape holding different documents.

### `swarm-after.json` — the same swarm, a few minutes later by the invented clock

Look for:

- `clean_orders` is still `complete`, with a newer `finishedAt` and a **changed `schema` digest**.
  Its `content` digest is character-for-character the same as in `swarm-before.json`. That is what
  a pure rename looks like, and it is why obsel reports `"changeKind": "schema"` rather than
  "something changed".
- The other three are `"status": "stale"`, each carrying a `stale` mark.
- `build_revenue` is at `"hops": 1`. It read the renamed table itself.
- **`write_report` and `write_docs` are at `"hops": 2`.** Neither has `clean_orders` anywhere in
  its `reads`. They read `daily_revenue`. They are flagged because the thing they were built on is
  itself now built on something that moved. This is the part worth checking carefully — a tool that
  only flagged direct dependents would leave these two sitting there looking finished.
- All three marks name the same `causedBy`: the `clean_orders` dataset, the table that actually
  moved, not the intermediate one the leaves happen to touch. `causedByTask` names the task that
  wrote it, so the trail leads back to a responsible actor rather than to a table.
- The two-hop `reason` names `build_revenue`, the task in between. The one-hop `reason` names the
  table. They are deliberately different sentences, because the useful explanation is different.
- `finishedAt` on the stale tasks is unchanged, and so are their fingerprints. They have not re-run.
  Only the verdict changed.
- Each mark carries `detectedMs`. On a real run that is the coordinator's own measurement of how
  long the whole job took, from the completion report arriving to every mark being written and
  confirmed in DataHub. The number in these files is a placeholder — see below.

### `coordination-result.json` — the answer to one completion report

What `POST /api/tasks/complete` returns when `clean_orders` reports the re-run. This is the whole
loop in one object.

Look for:

- `changedOutputs` has exactly one entry. obsel compares fingerprints; it never treats "a write
  happened" as "something changed". An identical re-run produces an empty `changedOutputs` and an
  empty `affected`, and that quiet case is what makes the loud case believable.
- `affected` is in traversal order: hop 1 first, then hop 2 sorted by URN. It is deterministic —
  the same graph gives the same order no matter what order the tasks were registered in. Here that
  puts `write_docs` before `write_report`, which is URN order, not importance.
- Each `affected[].task` still says `"status": "complete"` with `"stale": null`. That is not a
  mistake. `AffectedTask` is the coordinator's decision _before_ the mark is written back, so it
  carries each record as it was found. The `mark` beside it is byte-identical to the one that ends
  up on the same task in `swarm-after.json`.
- Every mark's `detectedMs` equals the result's `elapsedMs`. That is what `engine.ts` does: it
  measures the call once and stamps that one figure onto every mark from it.

**`elapsedMs: 118` and the matching `detectedMs: 118` are stand-ins, not measurements.** They are
here so the files are internally consistent and so you can see where a real measurement lands. The
one measured timing in this repository is the 92 ms full cascade walk in
[`docs/environment-findings.md`](../docs/environment-findings.md) section 7, and that measures the
graph traversal alone against a live DataHub — not this end-to-end path, which also writes marks
back and confirms them. Any number quoted anywhere about obsel has to come off a real run.

## Reproducing the fingerprints

`OutputFingerprint` splits a fingerprint in two so a rename can be told apart from a refresh:
`schema` moves when the columns move, `content` moves when the values move. The rule lives in
[`agents/fingerprint.py`](../agents/fingerprint.py) — it is the demo workers' code, not the
coordinator's. obsel's engine never looks at data; it compares two strings an agent handed it.

One command recomputes **every** digest in these three files and checks each one against what is
stored:

```
python3 examples/reproduce_fingerprints.py
```

It prints each digest, then compares it to the JSON. Exit code 0 means every digest here is genuine
sha256 output of `agents/fingerprint.py` over the table it prints. Change any digit in any of these
files, or any value in the script's tables, and it fails.

### How much of this a run would reproduce

The script holds the five tables the digests are taken over. Those tables are hand-written, and the
column sets are not equally trustworthy:

| Table                           | Columns                                                 | How fixed are they                                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clean_orders`                  | `order_id, customer, order_total, order_date`           | The instruction in [`agents/pipeline.py`](../agents/pipeline.py) names all four: "keeps four columns named exactly order_id, customer, order_total and order_date". A plan that obeys it gives these.    |
| `clean_orders` after the change | `order_total` becomes `order_total_usd`                 | Same instruction plus `CHANGE_INSTRUCTION`, which names the new column too.                                                                                                                              |
| `daily_revenue`                 | `order_date, revenue, order_count, average_order_value` | **Weakest.** The instruction pins only the day column ("Name the day column order_date"). The other three names are the model's choice, so this schema digest is one plausible outcome, not a fixed one. |
| `revenue_report`                | `section, heading, text`                                | Fixed in code. `worker.apply_write` hardcodes exactly these three.                                                                                                                                       |
| `pipeline_docs`                 | `section, heading, text`                                | Fixed in code, the same three, which is why it shares a schema digest with `revenue_report`.                                                                                                             |

Row values are invented throughout, so every `content` digest depends on a table nobody ran. The
`daily_revenue` rows are at least arithmetically consistent with the `clean_orders` rows above them,
under the sum, count and mean that `worker.apply_aggregate` implements.

### Checking one digest by hand

If you would rather not run the script, this is the shortest path to the `clean_orders` pair:

```python
import sys; sys.path.insert(0, "agents")
from fingerprint import fingerprint

columns = ["order_id", "customer", "order_total", "order_date"]
rows = [
    {"order_id": 7001, "customer": "Ada Okafor", "order_total": 42.5,  "order_date": "2026-07-20"},
    {"order_id": 7002, "customer": "Ben Ruiz",   "order_total": 18.0,  "order_date": "2026-07-20"},
    {"order_id": 7003, "customer": "Cai Zhou",   "order_total": 99.99, "order_date": "2026-07-21"},
]
print(fingerprint(rows, columns))
# schema  8c258e109bf37ce25d415f5285bc8a36bc9630e48b56cdbe134f2e3ee4dd1e88
# content f521e9ddbd60addc828e8ec983051309a44248529c7705354c51ebc568d03cbd
```

Rename `order_total` to `order_total_usd` in both lists and the schema digest becomes
`f7b62a6671ac038d27b492bb8842def34ef451c455fa7314222a0e0ad0203c1b` while the content digest does
not move at all. That single property is the reason the mark in `swarm-after.json` can say "its
columns changed" instead of "something changed".

The tables behind the other three digests are longer, so they live in
`examples/reproduce_fingerprints.py` rather than being pasted here. Run the script, or read the
tables at the top of it and pass them to `fingerprint()` the same way.

`python3 agents/fingerprint.py` runs the fingerprint module's own self-check, which asserts the
rename property along with row-order independence and stability across processes.

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
nested, and of the right kind, including the nullability of `stale`, `finishedAt`, `causedByTask`
and `detectedMs` — delete any one of those fields and it stops compiling. It does **not** prove the
literal strings are members of their unions (`"status": "complet"` would still type-check), because
TypeScript cannot see JSON string literals through `resolveJsonModule`. Those values were checked
separately by walking the files and comparing against the unions in `types.ts`.

## What is not in here

- **The DataHub side.** These are obsel's HTTP responses. What lands in DataHub is a `DataJob` per
  task, `Consumes`/`Produces` edges, the `urn:li:tag:obsel-stale` tag, and the `obsel.*` custom
  properties listed in [`docs/architecture.md`](../docs/architecture.md).
- **A captured run.** See the note at the top. Nothing here has been through a model or a DataHub.
- **Failure shapes.** The API's error responses are not sampled here.
- **The quiet case.** An identical re-run returns a `CoordinationResult` with empty `changedOutputs`
  and empty `affected`, which is the behaviour the whole design rests on, and there is no sample of
  it here.
