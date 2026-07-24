<div align="center">

# obsel

**Several AI agents. One shared set of tables. Somebody has to notice when the ground moves.**

Built for [Build with DataHub: The Agent Hackathon](https://datahub.devpost.com/) &nbsp;·&nbsp;
Category: _Agents That Do Real Work_ &nbsp;·&nbsp; Apache-2.0

[Try it](#try-it) &nbsp;·&nbsp; [Bring your own agent](#bring-your-own-agent) &nbsp;·&nbsp;
[Check the claims](#check-the-claims-yourself) &nbsp;·&nbsp; [Commands](#commands) &nbsp;·&nbsp;
[Docs](#more-reading)

</div>

---

## The problem

Each agent reads a table that another agent wrote.

When one of them changes a table, everyone who already finished downstream is now working from
something that moved. Nothing tells them. Their work sits there saying **complete**.

## What obsel does

> obsel gives every agent task a real entry in DataHub, wired to the data it reads and the data it
> writes. When an output changes, obsel follows those wires and flags every finished task
> downstream, with the reason and the change that caused it.
>
> That includes work which never touched the change itself, only something built on it.

It stays quiet otherwise. A re-run that produces the same table flags nothing at all, which is the
whole reason anybody would trust it the day it does speak up.

---

## See it

|                                                                                                        Everything is fine                                                                                                        |                                                                                                                                                  Something changed upstream                                                                                                                                                  |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: |
| [![Four agent boxes all showing done, the headline reporting that all four finished and nothing is out of date, and the write-back cell reporting there is nothing to write.](docs/images/settled.png)](docs/images/settled.png) | [![Three agents flagged amber. The changed table shows order_total leaving and order_total_usd arriving, an amber path runs outward from it through two hops, and the ribbon reports a measured detection time of 5399 ms beside three of three marks tagged in DataHub.](docs/images/flagged.png)](docs/images/flagged.png) |
|                                                                        Four agents finished. Nothing they read has changed since, so obsel says nothing.                                                                         |                                                                                                        One column was renamed. Three finished agents are now out of date, and **two of them never read that table**.                                                                                                         |

<div align="center"><em>Click either image for full size.</em></div>

Both came out of one run on 2026-07-23, from commit `9bd695e`, against a live DataHub and a live
Codex CLI. Not mockups, and not assembled from separate sessions.

| What happened                                       | Measured                                             |
| --------------------------------------------------- | ---------------------------------------------------- |
| Four agents did the work                            | 206.0 s of real Codex sessions                       |
| One agent's instructions changed                    | `order_total` became `order_total_usd`               |
| obsel called it a column change, not a value change | the content hash was `539b509722e8` before and after |
| Three finished agents flagged                       | 5399 ms, one at one hop and two at two               |
| Written back into DataHub                           | 3 of 3 tagged                                        |

---

## Try it

```bash
datahub docker quickstart
cp .env.example .env.local
pnpm install && pnpm dev
```

Open **`http://localhost:3000`**.

The board opens on a checklist, because those three commands are not quite everything. The demo
agents need their own Python packages and a signed-in Codex CLI, and obsel needs its tag registered
in DataHub. Every item is checked on your machine a couple of times a second, finished ones are
ticked, and anything missing shows you the exact command to run. Work down the list and it empties.

After that, the whole demo is buttons.

| Button                                       | What happens                                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Set up the demo agents**                   | Four agents are added to DataHub. Nothing runs yet.                                           |
| **Start the demo agents**                    | Four real Codex sessions do the work. Two to three minutes.                                   |
| **Run the orders cleaner again, no changes** | The same table comes out, so nothing should go out of date. obsel stays quiet.                |
| **Change one agent's instructions**          | A column gets renamed. Three finished agents go amber, and two of them never read that table. |
| **Reset and start over**                     | Everything goes back to up to date. The agents stay set up.                                   |

### What you need

| Thing                | Why                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------- |
| Node 24 and pnpm 11  | the app                                                                             |
| Docker               | the local DataHub stack                                                             |
| Python 3             | the demo agents, which get their own environment                                    |
| `uv`                 | obsel writes its tag through DataHub's own MCP server                               |
| Codex CLI, signed in | each agent is a real Codex session, so there is no offline mode and no API key path |

Every step written out in full, with a way to tell each one worked, is in
**[`docs/setup.md`](docs/setup.md)**.

---

## Bring your own agent

obsel speaks MCP in both directions. It uses DataHub's MCP server to write its tag, and it runs one
of its own, so any MCP-capable agent can join a swarm.

```bash
claude mcp add obsel -- "$PWD/agents/.venv/bin/python" -m agents.mcp_server
```

| Tool                                              | What your agent uses it for                           |
| ------------------------------------------------- | ----------------------------------------------------- |
| `check_freshness(reads)`                          | before working: are my inputs still trustworthy?      |
| `register_task(name, reads, writes, title?, ...)` | say what I read and what I write, once                |
| `announce_start(taskUrn)`                         | before writing, so work in flight is never flagged    |
| `report_complete(taskUrn, outputs, runner?, ms?)` | what I produced, and obsel replies with what it broke |
| `abandon_task(taskUrn)`                           | hand the announcement back if I failed                |
| `read_board()`                                    | who else is in the swarm, and how they are doing      |

Two things your agent deliberately cannot do:

- **It never hashes its own output.** `report_complete` takes the real rows and columns, and obsel
  hashes them itself. An agent that could hand obsel a hash could hand it the _previous_ hash and be
  believed.
- **It cannot flag or unflag anything.** The only way to clear a flag is to redo the work and report
  it.

[`skills/obsel-collaboration/SKILL.md`](skills/obsel-collaboration/SKILL.md) teaches an agent the
order that makes obsel's answers mean anything. Copy it into `.claude/skills/` to install it.

---

## Check the claims yourself

Every row is one command away, and names the file that would fail if the claim were false.

| Claim                                                                    | Run                                | Where it lives                                                                  |
| ------------------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------- |
| A re-run producing the same table flags nothing                          | `pnpm test`                        | `tests/staleness.test.ts`, where about half the tests assert no action          |
| Same again, through a real DataHub and through MCP                       | `pnpm test:live`                   | `engine.live.test.ts`, `obsel-mcp.live.test.ts`                                 |
| A change reaches work that never read the table that changed             | `pnpm test:live`                   | `obsel-mcp.live.test.ts` checks one hop and two, each with its reason           |
| Work in flight is never flagged                                          | `pnpm test`                        | `tests/staleness.test.ts`                                                       |
| The `obsel-stale` tag really lands in DataHub, confirmed by reading back | `pnpm test:live`                   | `mcp.live.test.ts`, `obsel-mcp.live.test.ts`                                    |
| `217` and `217.0` are not treated as a change                            | `python3 -m agents.worker`         | and again through MCP in `agents/mcp_core.py`                                   |
| A reply obsel never sent is refused, not read as "nothing was affected"  | `python3 -m agents.run self-check` | breaking that guard fails six checks, and five more in `mcp_core.py`            |
| Any MCP agent can join and set off a real cascade                        | `pnpm test:live`                   | `obsel-mcp.live.test.ts`, with a real client, a dead port, and the wrong server |
| TypeScript and Python build identical DataHub ids                        | `pnpm test`                        | `tests/urns.test.ts` runs the Python module for real                            |

**Nothing here is tested against a stand-in.** Anything that crosses a process boundary is covered
against a live DataHub, the real MCP server, a real obsel, and a real `codex exec` session.

### What is still open

The full record of what has been measured, and what has not, is in
**[`docs/verification.md`](docs/verification.md)**. The short version:

- The demo has passed cleanly six times, on one machine. That is not a pass rate.
- Codex is a live agent, and its output has needed pinning down twice.
- Detection times are single observations, not a benchmark.
- The graph has only been laid out for one pipeline shape.
- The demo video is not recorded.

---

## Commands

```bash
pnpm dev         # the cockpit at http://localhost:3000
pnpm verify      # format, lint, typecheck, tests, Python self-checks, build
pnpm test        # pure logic only, no Docker
pnpm test:live   # the real thing; needs DataHub up, and uvx and codex on PATH
pnpm e2e         # browser checks; builds and serves the app itself
```

**`pnpm verify` is the one to run first.** It needs no Docker and no browser download.

Checked 2026-07-23: `pnpm verify` passes end to end, with 232 tests and 109 Python self-checks
across five modules. `pnpm test:live` passes 58 tests across seven files in about 120 s, one of them
a real Codex session. `pnpm e2e` passes 73 browser checks across two viewports, with one skipped by
design.

---

## Where things live

```
app/                     routing, and the nine HTTP routes
src/features/cockpit/    the board you look at
src/server/coordinator/  the staleness rules, and the part that talks to DataHub
src/server/datahub/      DataHub client, tag writes, id shapes
src/server/runner/       the demo runner behind the buttons
agents/                  the four demo agents, and obsel's own MCP server
skills/                  how an agent should work in a swarm obsel is watching
docs/                    setup, concept, architecture, findings, demo script, verification
examples/                sample outputs, so you can judge them without running anything
tests/                   deterministic tests, no browser and no DataHub
e2e/                     browser checks
```

There is no scheduler, and nothing listening for events. An agent reporting that it finished is what
starts every check obsel does.

---

## More reading

| Document                                                           | What is in it                                                    |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| [`docs/setup.md`](docs/setup.md)                                   | Every setup step, with a way to tell each one worked             |
| [`docs/concept.md`](docs/concept.md)                               | What obsel is, and the evidence the problem is real              |
| [`docs/architecture.md`](docs/architecture.md)                     | How the pieces fit, and why each decision was made               |
| [`docs/verification.md`](docs/verification.md)                     | What is built, what is proven, and what is not                   |
| [`docs/environment-findings.md`](docs/environment-findings.md)     | DataHub behaviour measured directly, including several traps     |
| [`docs/demo-script.md`](docs/demo-script.md)                       | The shot list for the submission video                           |
| [`docs/upstream-contributions.md`](docs/upstream-contributions.md) | A DataHub CLI bug found here, root caused, with a proposed fix   |
| [`agents/README.md`](agents/README.md)                             | The demo agents, and what each command prints                    |
| [`examples/README.md`](examples/README.md)                         | Sample outputs, and exactly which parts of them are real         |
| [`hackathon.md`](hackathon.md)                                     | Submission requirements, judging criteria, and a self assessment |
| [`CLAUDE.md`](CLAUDE.md)                                           | Rules for working in this repository                             |
| [`PREEXISTING.md`](PREEXISTING.md)                                 | The hackathon's pre-existing code disclosure                     |
