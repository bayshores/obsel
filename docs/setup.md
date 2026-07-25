# Setup, step by step

[`README.md`](../README.md) has the three command version. This is the same setup written out in
full, for when something fails or you would rather use the terminal.

Each step has a way to tell whether it actually worked, because several of them fail quietly.

The demo agents in `agents/` need their own Python environment. `pnpm install` does not create it,
and it is the step people skip.

---

## What you need

- Node 24.x and pnpm 11
- Docker, for the local DataHub stack
- Python 3, for the demo agents. They get their own virtual environment in step 4 below; the
  `datahub` CLI used to start the stack is a separate, global install of `acryl-datahub`
- `uv`, for running the DataHub MCP server
- **The Codex CLI, signed in.** `codex login status` should say so. Each demo agent is a real Codex
  session that reads the data and decides for itself what its own table should contain. There is no
  API-key path and no offline mode, so if Codex is missing or signed out the run fails and says so.
  See [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) for the terms question this raises.

## The short version

Three commands, and the app guides you through the rest:

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

Once it does, the whole demo is buttons: set up the demo agents, put them to work, re-run one
identically, change a requirement upstream, reset. Each button runs the same `agents.run` command
listed in step 8 below, verbatim, and streams that step's own output onto the board.

## Every step

The same setup as eight explicit steps, for when something fails or you prefer the terminal. Each
one has a way to tell whether it worked, because several of them fail quietly. The demo agents in
`agents/` need their own Python environment, which `pnpm install` does not create.

**1. Start DataHub.** The first run pulls several images and takes a few minutes.

```bash
datahub docker quickstart
curl -s http://localhost:8080/config      # should print JSON with a version
```

DataHub's UI is then at `http://localhost:9002`. Its API (GMS) is at `http://localhost:8080`. These
are different ports and are not interchangeable, so point clients at 8080.

**2. Configure the environment.**

```bash
cp .env.example .env.local
```

`.env.example` documents every variable. The demo agents need no key here, because they authenticate
through the Codex CLI. One variable, `MCP_SERVER_DATAHUB_VERSION`, is pinned deliberately. Read its
comment before changing it, because resolving it to `@latest` silently disables every write while
still reporting success.

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

**8. Run the demo**, either from the guide's buttons or as the same commands:

```bash
agents/.venv/bin/python -m agents.run register      # four tasks into DataHub, each with its job
agents/.venv/bin/python -m agents.run run           # four agents finish, nothing stale
agents/.venv/bin/python -m agents.run rerun-same    # re-run produces the same table, marks nothing
agents/.venv/bin/python -m agents.run change        # renames a column, three tasks go stale
agents/.venv/bin/python -m agents.run reset         # back to the starting state
```

[`agents/README.md`](../agents/README.md) explains what each command should print. The board follows
either path identically, because the guide derives everything from what DataHub holds.

## Bring your own data

The MCP door works for your own files, and this walkthrough was executed for real on 2026-07-24;
every reply quoted below is from that run, against a dedicated flow, over the real
`agents.mcp_server` on stdio. Times are that run's, on one machine, and will vary.

The story: your finance system exports `expenses.csv`. One task reads the export into a tidy
table, another totals it per category. The export renames a column. obsel flags the totals, and
the flag comes off through the redone work.

**1. Connect your agent** (Claude Code shown; any MCP client works):

```bash
claude mcp add obsel -- "$PWD/agents/.venv/bin/python" -m agents.mcp_server
```

Point `OBSEL_URL` at your obsel if it is not on `http://localhost:3000`.

**2. Register the two tasks, once.** Short names in, URNs out; the names become real DataJob
entities wired with lineage:

```json
register_task {"name": "clean_expenses", "reads": ["expenses_csv"], "writes": ["clean_expenses"],
               "title": "Expense cleaner"}
register_task {"name": "monthly_totals", "reads": ["clean_expenses"], "writes": ["monthly_totals"],
               "title": "Monthly totals"}
```

**3. Do the work and report it.** Your agent reads the CSV itself and hands obsel the rows and
columns (or a path to a JSON table file; obsel hashes either itself). For each task:
`announce_start`, then `report_complete` with the output table. Observed replies:

```
clean_expenses:  no outputs changed; nothing was marked stale (39 ms)
monthly_totals:  no outputs changed; nothing was marked stale (49 ms)
```

**4. The file changes.** The export renames `amount` to `amount_usd`. Same rows, same values. The
cleaner re-runs and reports the new table. Observed reply:

```
changed clean_expenses (schema)
marked 1 finished task(s) stale in 3934 ms
monthly_totals (1 hop): read clean expenses, and its columns changed after this finished
```

Nothing told the totals task. obsel walked the lineage from the changed table and flagged the
finished work built on it, with the reason stored on the mark.

**5. The flag clears only through redone work.** The totals task re-runs on the new table and
reports. Here the totals came out identical, because a renamed input column does not move category
sums, and the flag came off through that redo. A totals task whose output moved would have
cascaded onward instead. There is no tool that clears a flag, on purpose.

Everything above is the same six tools the [Bring your own agent](../README.md#bring-your-own-agent)
section lists, and the order is the one `skills/obsel-collaboration/SKILL.md` teaches. What obsel
has been run against beyond this, shape by shape and change by change, is
[`docs/coverage.md`](coverage.md).
