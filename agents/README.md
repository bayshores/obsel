# The demo agents

Four AI agents build a small orders pipeline. Each one reads what the previous one
produced. All four finish. Then the first agent re-runs and renames a column, which
is the moment obsel is built for: it should mark every downstream task that was
silently invalidated, including two that never read the changed table at all.

```
clean_orders   reads raw_orders     writes clean_orders
build_revenue  reads clean_orders   writes daily_revenue
write_report   reads daily_revenue  writes revenue_report
write_docs     reads daily_revenue  writes pipeline_docs
```

These are real agents. Each one calls `gpt-5.6` to decide how to do its job, and
deterministic code applies that decision to every row. There is no offline mode
and no synthetic fallback: without `OPENAI_API_KEY` the workers stop and say so,
because a demo that quietly fakes the model would make every number on screen
meaningless.

## What has actually been observed

The lineage traversal has been run against a live DataHub: a change to an upstream
table returned every transitively affected task, full walk measured at 92 ms. The
fingerprint properties have a self-check that passes (`python3 agents/fingerprint.py`).

**The end-to-end demo below has not been run yet**, because it needs a `gpt-5.6`
call and none has been made from this repository. Everything on this page about
row counts, fingerprints and which tasks get marked is therefore what the commands
_expect and check_, not a transcript of a run. Each command states its expectation,
compares it against what obsel returned, and prints an `UNEXPECTED:` line and exits
non-zero if the two differ — so if any of it is wrong, the command says so rather
than printing the story anyway.

## What is in here

| File             | What it is                                                                                                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `graph.py`       | Walks the lineage graph to find what a change breaks. Also holds the Python reference implementation of task registration, which the demo does not use — `run.py register` goes through obsel's HTTP API instead. |
| `fingerprint.py` | Reduces a produced table to a schema hash and a content hash. Has a self-check.                                                                                                                                   |
| `seed_data.py`   | The synthetic `raw_orders` table the swarm starts from, from a fixed seed.                                                                                                                                        |
| `pipeline.py`    | The four agents, their instructions, and the shape they form. Data only.                                                                                                                                          |
| `worker.py`      | One agent: load inputs, ask the model for a plan, apply it, fingerprint, report to obsel.                                                                                                                         |
| `setup.py`       | One-time DataHub setup: creates obsel's tag and the demo DataFlow.                                                                                                                                                |
| `run.py`         | The command line that drives the demo.                                                                                                                                                                            |

## Before you start

You need four things running or set:

1. **DataHub.** `datahub docker quickstart`. Its API (GMS) must answer on
   `http://localhost:8080` — port 9002 is the frontend, not the API.
2. **obsel.** `pnpm dev` in the repository root, serving `http://localhost:3000`.
3. **A Python environment** with the pinned dependencies:

   ```bash
   cd /path/to/obsel
   python3 -m venv agents/.venv
   agents/.venv/bin/python -m pip install -r agents/requirements.txt
   ```

4. **`OPENAI_API_KEY`**, exported or in `.env.local` at the repository root.

Every command below is run from the repository root, so that `agents` imports as
a package:

```bash
agents/.venv/bin/python -m agents.run <command>
```

## The demo, in order

### 1. `setup`

```bash
agents/.venv/bin/python -m agents.run setup
```

Creates `urn:li:tag:obsel-stale` and the `orders_pipeline` DataFlow in DataHub,
confirms each one is readable, and writes the seed table.

This step is not optional and not cosmetic. obsel cannot create a tag at run time
— open-source DataHub has `add_tags` but no `create_tag`, and applying a tag URN
that is not already an entity is rejected. Without this step obsel would detect
staleness correctly and then silently fail to record any of it. That is why setup
fails loudly rather than warning.

Safe to re-run. It refreshes the descriptions and leaves everything else alone.

### 2. `register`

```bash
agents/.venv/bin/python -m agents.run register
```

Tells obsel about the four tasks. obsel writes each one into DataHub as a
`DataJob` with `Consumes` and `Produces` edges to the tables it reads and writes,
so the swarm's structure is visible in DataHub's own lineage view before any work
happens. The command checks that the URN obsel returns matches the one the agents
expect, and stops if they disagree — a URN mismatch would make the traversal miss
the task without any error.

### 3. `run`

```bash
agents/.venv/bin/python -m agents.run run
```

Runs all four agents in dependency order. For each one it prints how long the
model took to decide the plan, what the plan says in the agent's own words, the
table that came out, its fingerprint, and what obsel made of it.

On the first `run` after a `reset` there is no previous version of any table, so
obsel has nothing to compare against and marks nothing. Run it again after `change`
and it will not be silent: `build_revenue` produces a different table, which
invalidates the two tasks below it before they re-run themselves. The command
prints whatever obsel marked along the way.

The closing line — "every task is complete and every task is built on something
still true" — is a claim about the swarm, so it is read back from `GET /api/swarm`
after the four agents finish rather than assumed from the fact that they returned.
If any task is not `complete`, or any task still carries a stale mark, the command
prints `UNEXPECTED:` with the names and exits 1.

### 4. `rerun-same` — the part that proves there are no false alarms

```bash
agents/.venv/bin/python -m agents.run rerun-same
```

`clean_orders` runs again with the same job and the same input. The same plan
should apply and the same rows should come out, and obsel should mark nothing —
because it compares the fingerprint of the output, not the fact that a write
happened.

The command checks all of that instead of asserting it. It fails with
`UNEXPECTED:` and exits 1 if the table is not byte-identical to the previous one,
if obsel reports any changed output, if obsel marks anything — or if obsel held no
previous fingerprint for the table in the first place, because "nothing was marked"
proves nothing when there was nothing to compare against.

Worth showing before the next step. A tool that flags everything downstream every
time a scheduled job re-runs is a tool people mute, and the flag in step 5 only
means something once you have seen this one stay quiet.

### 5. `change` — the money moment

```bash
agents/.venv/bin/python -m agents.run change
```

`clean_orders` runs again with one requirement changed: the money column is now
`order_total_usd`. That is an ordinary upstream decision and nobody downstream is
told about it.

A rename moves the schema fingerprint and leaves the content fingerprint alone —
the values did not change, only the name — so obsel should report `schema` rather
than `both`, which is what turns the message into "its columns changed" instead of
the useless "something changed". `fingerprint.py`'s self-check proves that property
of the hashes on its own; `change` checks that obsel actually said it.

Then obsel walks DataHub's lineage graph. `change` requires exactly this set, and
nothing else:

- `build_revenue` at 1 hop — it read `clean_orders` directly
- `write_report` at 2 hops — through `daily_revenue`
- `write_docs` at 2 hops — through `daily_revenue`

The last two never read `clean_orders`. They are reached transitively, which is the
thing that is hard to do without a lineage graph and the reason obsel is built on
one — so the command compares the whole map rather than checking that something was
marked. If only `build_revenue` came back, the transitive half would be broken and
"one task was marked" would still look like a pass; here it exits 1.

### `reset`

```bash
agents/.venv/bin/python -m agents.run reset
```

Puts the demo back to its pre-run state, for a second take.

obsel's half goes first: `POST /api/demo/reset` puts every task back to
`registered`, drops the recorded fingerprints, and removes the `obsel-stale` tag
from DataHub (a different aspect from the properties, so it does not come off with
them). The command prints which tasks came back and which tags were cleared. Only
then does it clear `.obsel/data`, `.obsel/plans` and `.obsel/state` and rewrite the
seed table.

If obsel's half fails, nothing local is touched and the command exits 1. Clearing
the local tables while DataHub still holds their fingerprints would leave the next
run comparing against a baseline this machine no longer has.

## Useful flags

- `--no-cache` forces a fresh model call even when a plan for these exact inputs
  was already decided.
- `--obsel-url` points the agents at obsel somewhere other than
  `http://localhost:3000`.

## How the agents use the model

Each agent asks `gpt-5.6` for a **plan** in a strict JSON schema — which columns
to produce and how to derive them, how to group and aggregate, what the report
should say — and then deterministic code applies that plan to every row.

Two reasons, and the second one is load-bearing:

1. It is how this is actually done. Nobody streams fifty thousand rows through a
   model to clean them; the model decides the rule and code runs it.
2. The output becomes a function of the plan. An unchanged plan gives a
   byte-identical table, which is what makes "an identical re-run marks nothing"
   a testable claim rather than a hope.

Plans are cached on disk under a key covering the model, the exact instruction,
and the fingerprints of every input. Same job, same inputs, same decision. Every
line the CLI prints says which of the two happened — `gpt-5.6 decided the plan in
N ms`, or `reused the plan gpt-5.6 decided for these exact inputs earlier` — so
it is always visible whether a call was made.

Table contents go to the model as data, never as instruction. The system prompt
says so explicitly: if a value in the data reads like a command, it is treated as
a value.

## Checking the pieces on their own

```bash
# Prove the fingerprints are stable and that a rename moves the schema half only.
python3 agents/fingerprint.py

# The four agents and the order they may run in.
agents/.venv/bin/python -m agents.pipeline

# The seed table.
agents/.venv/bin/python -m agents.seed_data
```
