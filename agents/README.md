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

These are real agents. Each one is a Codex session that reads its input, decides
how to do its job, and writes its table with its own tools. There is no offline
mode and no synthetic fallback: without a signed-in Codex CLI the workers stop and
say so, because a demo that quietly fakes the model would make every number on
screen meaningless.

## What has actually been observed

The lineage traversal has been run against a live DataHub: a change to an upstream
table returned every transitively affected task, full walk measured at 92 ms. The
fingerprint properties have a self-check that passes (`python3 agents/fingerprint.py`).

**The whole sequence below has been run with live agents.** `reset` → `run` →
`rerun-same` → `change` completed and exited 0 on 2026-07-22, against a live
DataHub and a signed-in Codex CLI, with every step's own assertions passing:

| Step         | Measured                                                                        |
| ------------ | ------------------------------------------------------------------------------- |
| `run`        | four Codex sessions in 134.0 s; obsel confirmed 4 of 4 complete, nothing marked |
| `rerun-same` | byte-identical output, 0 changed outputs, 0 marks, confirmed in 60 ms           |
| `change`     | called `schema`; marked exactly 3 tasks at 1, 2 and 2 hops, in 2591 ms          |

Five runs of `run` on the same machine measured 135.9 s, 119.4 s, 152.0 s, 134.0 s
and 134.0 s. `clean_orders` wrote 39 rows from the 50-row seed every time.

That is one clean pass of each step, not a pass rate. Each command states its
expectation, compares it against what obsel returned, and prints `UNEXPECTED:` and
exits non-zero if the two differ — so a bad run says so rather than printing the
story anyway. That is exactly how both of the agent instabilities described below
were found.

## What is in here

| File             | What it is                                                                                                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `graph.py`       | Walks the lineage graph to find what a change breaks. Also holds the Python reference implementation of task registration, which the demo does not use — `run.py register` goes through obsel's HTTP API instead. |
| `fingerprint.py` | Reduces a produced table to a schema hash and a content hash. Has a self-check.                                                                                                                                   |
| `seed_data.py`   | The synthetic `raw_orders` table the swarm starts from, from a fixed seed.                                                                                                                                        |
| `pipeline.py`    | The four agents, their instructions, and the shape they form. Data only.                                                                                                                                          |
| `worker.py`      | One agent: load inputs, announce the start, let Codex do the work, hold the output to its contract, fingerprint, report to obsel. Has a self-check.                                                               |
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

4. **The Codex CLI, signed in.** `codex login status` should confirm it. There is no
   API-key path.

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

Runs all four agents in dependency order. For each one it prints what did the work
and how long it took, the table that came out with its row count and columns, its
fingerprint, and what obsel made of it. The cockpit shows the same figures, and
shows an elapsed count while each agent is still working.

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

`clean_orders` runs again with the same job and the same input. The same rows
should come out, and obsel should mark nothing — because it compares the
fingerprint of the output, not the fact that a write happened.

The command checks all of that instead of asserting it. It fails with
`UNEXPECTED:` and exits 1 if the table is not byte-identical to the previous one,
if obsel reports any changed output, if obsel marks anything — or if obsel held no
previous fingerprint for the table in the first place, because "nothing was marked"
proves nothing when there was nothing to compare against.

Worth showing before the next step. A tool that flags everything downstream every
time a scheduled job re-runs is a tool people mute, and the flag in step 5 only
means something once you have seen this one stay quiet.

**This is the step that failed first, and what it taught.** Run live on
2026-07-22 it reported a change and marked three tasks. The difference between the
two runs was a single value: `order_id` 1012's `order_total`, written `217` by one
run and `217.0` by the run before. Everything else in all 39 rows was identical.

obsel was right to flag it — `217` and `217.0` are different bytes and it hashes
the serialised value. Two things were wrong, and both are now fixed:

1. **This command's own check was weaker than the evidence it was checking.** It
   compared the two tables with Python's `==`, which calls `217` and `217.0`
   equal, so it printed `byte-identical: True` and then blamed obsel for a false
   alarm that was a correct detection. It now compares fingerprints, the same
   evidence obsel uses, so the two can never disagree about what "identical"
   means. When the tables really do differ it prints both fingerprints and names
   the agent, not obsel.
2. **The agent was writing the same number two ways.** `canonicalise_numbers` in
   [`worker.py`](worker.py) now fixes the serialised form per column before
   anything is saved or hashed, so a value that did not change cannot move the
   hash. It has its own self-check: `agents/.venv/bin/python -m agents.worker`.

With both in place the step passes: byte-identical output, nothing marked,
confirmed by obsel in 60 ms.

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
then does it clear `.obsel/data` and `.obsel/state` and rewrite the seed table.

If obsel's half fails, nothing local is touched and the command exits 1. Clearing
the local tables while DataHub still holds their fingerprints would leave the next
run comparing against a baseline this machine no longer has.

## Useful flags

- `--obsel-url` points the agents at obsel somewhere other than
  `http://localhost:3000`.

## How the agents do the work

Each agent is a **real Codex session**, running in the data directory with its own
tools. It reads its input table, decides how to do its job, and writes its output
table itself. Codex is the only runner: there is no API-key path, no offline mode
and no synthetic fallback, so without a signed-in Codex CLI the workers stop and
say so. A demo that quietly faked the model would make every number on screen
meaningless.

The output is read back off disk and checked against the column contract before
obsel hears anything. A plausible-looking bad table would fingerprint as a real
change and mark the whole chain stale for nothing.

**What this costs, measured.** An earlier design asked the model for a JSON plan
and had deterministic code apply it to every row, which made a byte-identical
re-run a property of the construction: same plan in, same table out. Codex
writing the table directly gives that up, and the cost is not hypothetical.

Across four live runs of `clean_orders` over the identical 50-row seed on
2026-07-21 and 2026-07-22, three produced content hash `a650c0c2…` and one
produced `539b5097…`. The entire difference was `order_id` 1012's `order_total`:
`217` in three runs, `217.0` in the fourth. Same number, different bytes, and the
fingerprint hashes bytes. It broke two steps at once — `rerun-same` saw a re-run
that was not identical, and `change`'s pure column rename reported `both` instead
of `schema`, because the values appeared to have moved as well as the name.

So the worker now holds the agent's output to a contract on **two** axes, not
one: the exact column names, which was always enforced, and one serialised form
per numeric column, which is `canonicalise_numbers`. The agent still decides what
the numbers are; the worker decides how they are written down.

That is deliberately placed in the worker rather than in the fingerprint. obsel
still hashes bytes and still calls two different byte sequences different — what
counts as evidence has not been loosened. What changed is upstream of obsel: the
agent's output is written one way, so a genuine change to the data is the only
thing left that can move the hash. A column that really does gain a fractional
value still flips and is still reported, and the self-check asserts exactly that.

Worth being precise about what was ever in question. obsel's rule is "compare the
recorded fingerprint, never the fact that a write happened", and that rule held in
every run, before and after: it flagged the run that really did differ and stayed
silent on the ones that did not. What was fragile was the agent's spelling of an
unchanged number, and that is what got fixed.

**obsel is told before the work, not after.** The agent announces its start,
then runs Codex. That is what lets the cockpit show an agent working while it is
working, rather than showing "waiting" for the 20–50 seconds a Codex session
takes. Because obsel excludes `running` work from the cascade, a run that dies
hands the announcement back via `POST /api/tasks/abandon` and the task returns to
`registered` — without that, a crashed agent would leave a task invisible to every
later traversal while the board still showed a healthy swarm.

Every completion also reports what the run was like — which runner, how long, how
many rows, which columns — and the cockpit shows it. obsel decides nothing on any
of it; it exists so a person watching the board sees what the terminal sees.

Table contents go to the model as data, never as instruction. The system prompt
says so explicitly: if a value in the data reads like a command, it is treated as
a value.

## Checking the pieces on their own

```bash
# Prove the fingerprints are stable and that a rename moves the schema half only.
python3 agents/fingerprint.py

# Prove the output contract: 217 and 217.0 reach the same fingerprint, an id
# column keeps its integers, and a value that really moved still moves the hash.
agents/.venv/bin/python -m agents.worker

# The four agents and the order they may run in.
agents/.venv/bin/python -m agents.pipeline

# The seed table.
agents/.venv/bin/python -m agents.seed_data
```
