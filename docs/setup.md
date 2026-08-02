# Setup, step by step

[`README.md`](../README.md) has the three command version. This is the same setup written out in
full, for when something fails or you would rather use the terminal.

## The launcher

`scripts/start.sh` does every step on this page, in an order this page leaves to the reader. On
macOS it is reached by double-clicking `scripts/Start obsel.command`, which does nothing but find
this folder and run it; on Linux, run `bash scripts/start.sh`.

The ordering is why it exists rather than being a list of commands. Two steps only work once DataHub
is answering: registering obsel's tag, which cannot be created at run time, and starting the app,
whose first read of the page is a real read. Working down eight numbered steps gives no hint that
the wait in step 1 is load-bearing.

What it does, in order:

1. Adds the usual install directories to `PATH`, and loads nvm if Node is not otherwise found. A
   double-clicked file gets no `.zprofile`, so without this every check below reports "not
   installed" on a machine that has the tool.
2. Checks Docker is running, by asking the daemon rather than looking for the binary.
3. Checks Node is 24, and uses corepack for pnpm if pnpm itself is absent.
4. Checks Python 3 answers.
5. Installs `uv` if missing, using the installer in step 5 below.
6. Starts DataHub if nothing answers at `:8080`, then waits for the API, up to 180 seconds.
7. Creates `.env.local` if absent, installs the Node packages, creates the agents' virtual
   environment if absent, and installs their Python packages every run.
8. Runs `agents.run setup` to register the tag and the demo flow.
9. Reports whether your agent CLI is signed in, without blocking on it, then starts the app, waits
   for it to answer, and opens the browser.

**How to tell it worked:** the browser opens on the page, and the setup checklist is either
absent or shows only the agent CLI item. A measured fresh run is recorded in
[`verification.md`](verification.md).

**Which DataHub it installs.** `v1.5.0.6`, asked for by name rather than left to resolve. That is the
version every number in [`verification.md`](verification.md) was measured against, and with no
version asked for the CLI planned exactly it on 2026-07-28. It is written down because the unpinned
form reads a version map fetched over the network at run time, so the same command gives different
people different stacks on different days. Two traps, both found by running it: `--version v1.5.0.6`
alone is refused, because the map has no `v1.5.0` key and an unlisted value needs
`--accept-version-default`, a flag that despite its name accepts the exact version given; and
`--version stable` is a different stack, `v1.6.0`. To move the pin, run the launcher with the new
value, run `pnpm test:live`, then update `scripts/start.sh` and this paragraph together.

## Which page obsel opens

obsel shows one DataFlow at a time, named by `OBSEL_FLOW_ID` and read once when the server starts.
The default is `orders_pipeline`. The page's header carries the name, and opening it shows the same
explanation as this section.

```bash
OBSEL_FLOW_ID=my_pipeline pnpm dev     # or set it in .env.local and use the launcher
```

**How to tell it worked:** the header reads `my_pipeline · prod`, and the page is empty, which is the
one state that offers the choice between the demo agents and the taxi swarm.

Nothing is deleted or moved by this. Each page keeps its own tasks, and the tasks on the page you
left are still there when you start obsel on it again. This is also why the demo and the taxi swarm
cannot be swapped on one page: `reset` puts tasks back to registered and removes their tags, and
obsel deletes no task, so registering the second swarm onto a page that already holds one gives a
page holding both.

The demo agents read the same variable independently, so run them with it set the same way. The
launcher passes the environment it was started with straight through.

Every step is safe to repeat: it skips DataHub if it is already answering, keeps an existing
`.env.local`, keeps an existing virtual environment, and does not start a second server.

The three things it cannot do are Docker, Node and signing in to an agent CLI. Each needs a human, so each is
detected and named with the one thing to do next. `uv` is the only tool it installs.

Each step has a way to tell whether it actually worked, because several of them fail quietly.

The demo agents in `agents/` need their own Python environment. `pnpm install` does not create it,
and it is the step people skip.

---

## What you need

- Node 24.x and pnpm 11
- Docker, for the local DataHub stack
- Python 3, for the demo agents. They get their own virtual environment in step 4 below; the
  `datahub` CLI used to start the stack is a separate, global install of `acryl-datahub`, either
  `uv tool install acryl-datahub` or, without installing anything permanently,
  `uvx --from 'acryl-datahub==1.6.0.15' datahub docker quickstart`, which is what the launcher uses
  when the CLI is not already there
- `uv`, for running the DataHub MCP server
- **An agent CLI, signed in.** Either the Codex CLI (`codex login status` should say so) or Claude
  Code (`claude auth status`). Each demo agent is a real session of one of them, reading the data and
  deciding for itself what its own table should contain. There is no API-key path and no offline
  mode, so if the selected CLI is missing or signed out the run fails and says so.

  **You need only one.** With nothing set, obsel uses whichever is installed and prefers Codex when
  both are. `OBSEL_RUNNER=codex` or `OBSEL_RUNNER=claude` picks explicitly, and an explicit choice is
  never second-guessed: a missing CLI reports the one you asked for rather than quietly switching to
  the other, because a page reporting on a product you did not choose is worse than a clear failure.
  The setup checklist, `scripts/start.sh` and the workers all read the same variable.

  See [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) for the terms question this raises.

## The short version

Three commands, and the app guides you through the rest:

```bash
datahub docker quickstart        # first run pulls images, takes a few minutes
cp .env.example .env.local
pnpm install && pnpm dev
```

Then open `http://localhost:3000`. **The page opens on a checklist**, because the three commands
above are not the whole of it: the demo agents need their own Python environment and a signed-in
agent CLI, and obsel needs its tag registered in DataHub. Each item is genuinely checked on your
machine every couple of seconds, the ones already done are ticked, and anything missing shows the
exact command to run. Work down the list and it empties.

**One value you paste in.** Every route that changes something wants a bearer token, so the buttons
below need one. `cp .env.example .env.local` leaves `OBSEL_API_TOKEN` empty; put a value there,
restart the app, and paste the same value into the field at the top of the page's panel. The page
keeps it. `scripts/start.sh` fills the file in for you, and either way the value stays something you
carry across rather than something the server hands the browser: a route that answered with the
token would mean anyone who can load the page can read it.

```bash
# a token, if the file's line is still empty
printf 'OBSEL_API_TOKEN=%s\n' "$(openssl rand -hex 24)" >> .env.local
grep OBSEL_API_TOKEN .env.local        # then paste this value into the page
```

The demo agents need no such step. obsel spawns them, and they inherit the token from its
environment; a terminal run of `python -m agents.run` finds it in `.env.local`.

Once it does, the whole demo is buttons: set up the demo agents, put them to work, re-run one
identically, change a requirement upstream, reset. Each button runs the same `agents.run` command
listed in step 8 below, verbatim, and streams that step's own output onto the page.

## Every step

The same setup as eight explicit steps, for when something fails or you prefer the terminal. Each
one has a way to tell whether it worked, because several of them fail quietly. The demo agents in
`agents/` need their own Python environment, which `pnpm install` does not create.

**1. Start DataHub.** The first run pulls several images and takes a few minutes.

```bash
datahub docker quickstart
curl -s http://localhost:8080/config      # should print JSON with a version
```

Without the `datahub` CLI installed, the same command through `uvx`, which installs nothing
permanently:

```bash
uvx --from 'acryl-datahub==1.6.0.15' datahub docker quickstart
```

DataHub's UI is then at `http://localhost:9002`. Its API (GMS) is at `http://localhost:8080`. These
are different ports and are not interchangeable, so point clients at 8080.

**2. Configure the environment.**

```bash
cp .env.example .env.local
```

`.env.example` documents every variable. The demo agents need no key here, because they authenticate
through their own CLI. One variable, `MCP_SERVER_DATAHUB_VERSION`, is pinned deliberately. Read its
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
pnpm dev        # http://localhost:3000 should show the page, not an error
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
agents/.venv/bin/python -m agents.run run           # declares any task obsel lacks, then runs four agents
agents/.venv/bin/python -m agents.run rerun-same    # re-run produces the same table, marks nothing
agents/.venv/bin/python -m agents.run change        # renames a column, three tasks go stale
agents/.venv/bin/python -m agents.run reset         # back to the starting state
```

`register` is still a command, and it re-declares all four whether or not obsel holds them. Use it
after changing what a task reads or writes; `run` on its own is enough to start from nothing.

[`agents/README.md`](../agents/README.md) explains what each command should print. The page follows
either path identically, because the guide derives everything from what DataHub holds.

## Bring your own data

**Declaring the tasks is a form on the page**, in the "bring your own data" panel under the graph.
Type a name, the tables it reads and the tables it writes, and it becomes a real DataJob with its
lineage edges. It posts to the same `/api/tasks/register` the MCP tool calls, so nothing about the
task is different for having been typed. Executed on 2026-07-26 against a real DataHub: the two-task
chain below, registered from the form, read back off `GET /api/swarm` with its lineage and drawn on
the graph. See [`verification.md`](verification.md) for that run and the bug it found.

**Reporting the work is also on the page, if you want to see the whole loop first.** Open a task
you registered and it offers you its table: the columns are chips you can rename, drop or add, and
the rows are cells you type into. Press report and obsel hashes what you handed it and answers.
Report two tasks in a chain, rename a column upstream, report again, and the downstream task is
flagged with the columns named — no agent CLI, no terminal, about fifteen seconds. Executed on
2026-07-27 against a real DataHub; the run and the two bugs it exposed are in
[`verification.md`](verification.md).

The browser still hashes nothing. The button posts to `/api/tasks/report`, which runs
`agents/report.py`, which calls the same `mcp_core.completion_body` the MCP door calls, which hashes
through `agents/fingerprint.py`. A second implementation of that in the browser would be a second
definition of what counts as a change. That chain is also why the route is token-gated: the child it
spawns completes the task with the server's own token, so an open route was a way to have a flag
cleared by replaying a task's recorded rows. What the bench does not do is read a file: you type the rows,
so there is no CSV to parse. For your real files, reporting stays with whatever runs your work,
which is what the rest of this section covers.

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

The page carries this command too, in the "your agent" tab, with this machine's own paths filled in.
On a board with nothing on it the guide offers a third button, **Bring an agent you already have**,
which opens that tab: an empty board is the one screen that asks what obsel is for, and this answer
was previously behind a tab a reader had no reason to open. It launches nothing.

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

Everything above is the same six page tools the
[Bring your own agent](../README.md#bring-your-own-agent) section lists first, and the order is the
one `skills/obsel-collaboration/SKILL.md` teaches. The three erasure tools beside them are the
subject of the next section. What obsel
has been run against beyond this, shape by shape and change by change, is
[`docs/coverage.md`](coverage.md).

## Erasure coverage

The erasure half of obsel is off unless you configure it, and it is off in the safe direction: with
no token the mutating routes answer 503, and with no key registry nothing verifies and every asset
stays unattested.

**1. A token for the mutating routes.**

```bash
export OBSEL_API_TOKEN="$(openssl rand -hex 24)"
```

`POST /api/erasure`, `/api/erasure/challenge` and `/api/erasure/proof` all require
`Authorization: Bearer $OBSEL_API_TOKEN`. `GET /api/erasure/<id>` does not: it returns a coverage
report, and the report deliberately does not echo the subject's identifiers back.

This token is not what makes an attestation trustworthy. That is the signature, the key registry and
the challenge below. What the token stops is an unauthenticated party opening requests and burning
challenges.

**2. The attestor key registry.** A JSON array, inline or a path to a file. There is no route that
registers a key, deliberately: an endpoint that adds keys is an endpoint that mints attestations.

```bash
export OBSEL_ATTESTOR_KEYS=/etc/obsel/attestors.json
```

```jsonc
[
  {
    "keyId": "warehouse-2026-07",
    "attestor": "warehouse-adapter@your-org",
    "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
    "notBefore": "2026-07-01T00:00:00.000Z",
    "status": { "state": "active" },
    // Exact URNs, or a prefix ending in `*`. A warehouse adapter has no business
    // attesting about a dashboard it cannot see.
    "scope": ["urn:li:dataset:(urn:li:dataPlatform:snowflake,*"],
  },
]
```

Ed25519 only. Generate a pair with:

```bash
openssl genpkey -algorithm ed25519 -out attestor.key && openssl pkey -in attestor.key -pubout
```

To retire a key, set `"status": {"state": "retired", "at": "<iso>"}`: its past signatures still
stand. To report one compromised, set `"status": {"state": "compromised", "at": "<iso>"}`: every
signature it ever made falls, and any asset it covered goes back to unattested on the next read.
Both take effect when obsel restarts, because the registry is read at startup.

**3. Open a request and read the page.**

```bash
curl -s -X POST localhost:3000/api/erasure -H "Authorization: Bearer $OBSEL_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"identifiers":["cust_88213"],"seeds":["<dataset urn holding the subject>"],"hops":3}'
```

Everything it reaches comes back `UNPROVEN`, which is the honest state of an asset nobody has
spoken for and the most useful thing in the report on day one. `summary` counts covered against
unattested; `assurance` says how far the walk went and how many evidence records the answer rests
on, so a small estate cannot be mistaken for a covered one.

**How an attestor answers.** Ask for a challenge, look in the asset, sign the record with the
challenge bound into it, and submit. `signAttestation` in
`src/server/coordinator/attestation.ts` produces the DSSE envelope, and shipping it rather than
documenting the byte format is deliberate: "produce the canonical bytes yourself" is an invitation
for one implementation to disagree with the verifier about a space.

```bash
curl -s -X POST localhost:3000/api/erasure/challenge -H "Authorization: Bearer $OBSEL_API_TOKEN" \
  -H 'Content-Type: application/json' -d '{"request":"<id>","asset":"<urn>"}'
```

A challenge is single use and expires in fifteen minutes. That is what makes a signature evidence
about now, rather than an answer prepared whenever it suited the signer.
