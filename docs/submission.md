# Submission drafts

Three drafts, ready to file. Filing any of them is Sean's action, never automated: the Devpost form,
the GitHub comment, and the feedback survey are all outward-facing. Every number in here is measured
and traceable to [`verification.md`](verification.md); if a number there changes, it changes here in
the same commit.

---

## 1. Devpost description draft

**obsel tracks a right-to-erasure request across the systems it cannot see: every asset the request
reaches stays unattested until an operator who can look signs for it.**

Category: _Agents That Do Real Work_ · Apache-2.0 · built solo · video 2:59 · every number here is
traceable to `docs/verification.md` in the repository.

### Erasure coverage

A GDPR Article 17 request arrives, the team holding the system of record deletes the subject's rows,
and the ticket closes. Copies of those rows had already flowed into stores other people run, and
nothing on file says which of those places anybody has looked at.

obsel starts from the tables known to hold the subject and walks lineage, the Consumes and Produces
edges between jobs and tables that DataHub's ingestion already records for the estate. Every asset
that walk reaches begins at `UNPROVEN`, which says nobody has spoken for the asset, not that the
subject is still in it.

An asset leaves `UNPROVEN` when an attestation arrives, a statement signed with a registered Ed25519
key by the operator of the store the asset sits in. The attestation binds the subject's absence to a
named version of a named table, the whole version rather than a partition of it. A hash says what
the bytes were. A signature says who answers for the claim, and can be revoked. The attestor is
whoever holds credentials to that store, and obsel never is, because it holds no warehouse
credentials and reads no warehouse data. It cannot establish absence and does not claim to. What it
can do is combine those local claims into a per-asset picture no single attestor is positioned to
produce, and lead with the assets nobody signed for.

Coverage is that picture totaled, N of M attested and K unattested, recomputed from the append-only
ledger on every read and never stored. A stored verdict would still be reporting the old number
after a signing key was reported compromised, because a compromise report touches no table and no
stored field.

### The one-minute version

A day-one report is almost entirely unattested. Seeded from one Snowflake customers table in the
`showcase-ecommerce` catalog, the walk went four hops and reached 23 assets across five platforms,
every one `UNPROVEN` with `no-attestation`. One Ed25519 keypair, one challenge and one signed
attestation moved exactly one of them, to 1 of 23 attested and 22 unattested, driven by hand against
a live DataHub on 2026-07-26.

Retiring a key and reporting one compromised are separate code paths. A retired key's past
signatures stand. A compromised key's signatures fail whatever their age, so a compromise takes
coverage back with nobody touching data. The falsifier is a passing test in
`tests/attestation.test.ts`, "an asset goes back to unattested when the signing key is reported
compromised".

No route, tool or argument marks an asset covered. A live test posts to the three paths a later
commit would add and asserts there is no mutation behind any of them, and the MCP suite asserts no
such tool is offered. With no `OBSEL_API_TOKEN` set, `POST /api/erasure` answers 503 and names the
reason.

The vocabulary is enforced in code and in every document. Never "proven clean", always "attested
absent over version V by attestor A". Never "complete", always "N of M covered, K unattested".

Absence in a table cannot be established from a graph of how tables connect, only carried through
one. obsel reports who has accounted for what, and who has not.

### The same walk, on finished work

Agents in a swarm read tables other agents wrote. When an upstream table changes, downstream work
that already finished is now built on data that has moved, and nothing says so. The work still looks
finished, and at forty tasks nobody can eyeball what a change reached.

Every agent task becomes a DataJob in DataHub, wired with Consumes and Produces edges to the tables
it reads and writes, so the lineage graph itself does the coordination. obsel runs no message bus
and no scheduler. When an agent reports completion, obsel fingerprints what it produced (sha256 over
schema and content, separately, so a rename is distinguishable from new rows), compares against the
recorded baseline, and walks those edges downstream. Finished work built on the changed table is
flagged with the cause, the hop distance, and a plain sentence stored on the flag. The `obsel-stale`
tag lands on the DataJob through DataHub's MCP server, and the cascade raises one native DataHub
Incident on the changed table naming every flagged task, so somebody browsing DataHub sees both
without knowing obsel exists. The incident comes down when the marks it names are gone, through
redone work or a board reset that wipes them, and never on request. Measured live, the raise added
345 ms and the resolve 300 ms, each including its confirming read-back.

Four rules make the flags worth reading.

- A re-run producing the same table flags nothing. Staleness is decided by comparing fingerprints,
  never by the fact that a write happened. Rows are sorted before hashing and columns the task
  registered as volatile are left out, so a re-run differing only in row order or only in a load
  timestamp counts as identical. At forty tasks, an identical re-run flagged zero of 40.
- Work in flight is never judged. A mid-swarm change flagged 8 finished tasks in a measured 13,349
  ms while 9 agents were still running, and none of the nine was touched.
- A flag comes off through redone work and nothing else. No route and no tool takes a task to clear,
  because a tool that declares work fresh would let a caller dismiss the warning obsel exists to
  raise. When a flagged task re-runs and its table comes back identical, obsel clears the downstream
  flags that redo restores, and only those.
- Every number on the page was measured, or it is withheld. A failed read blanks every stat.

The demo runs forty Codex agent sessions building a pipeline over one week of NYC yellow-taxi trips
(2,100 rows, sha256-pinned, provenance documented), concurrently, peak 8 at once, 252.6 s wall
clock. One agent then re-runs with a renamed column. How far that reaches depends on how much has
finished, so the runs below differ on purpose.

- On a settled board on 2026-07-24, 9 of 40 flagged out to three hops in 3968 ms. The 30 tasks
  outside the change stayed unflagged, and all nine tags were confirmed in DataHub.
- The same rename while 9 agents were still in flight, the same day, flagged 8 of 40 finished tasks
  in 13,349 ms, five direct readers and three transitive, and touched none of the nine running
  agents. `report_city` finished after the flags landed, on inputs that had not moved, and was
  correctly left alone.
- On 2026-08-02 the forward and reverse rename alternated on a settled board five times, each a real
  agent session, and all five flagged 9 of 40 at three hops. Detection ran from 473 ms to 4166 ms
  with a median of 666 ms, on one machine, so it is a range rather than a benchmark.
- The same pipeline also ran on Claude Code that day. Forty sessions of `claude-sonnet-5` at medium
  effort finished in 129.3 s at peak 8, every output passing its contract and nothing flagged. The
  settled change then flagged 9 of 40 at 4575 ms, and the repair redid 6 of 9 in 37.8 s, clearing
  the other three without re-running them.

The repair, run from the 8-flag page, redoes only the flagged work, in parallel, and cancels each
downstream redo as soon as an upstream redo lands identical and makes it unnecessary. It redid 5 of
8 in 42.4 s against roughly 188 s to redo all eight, a baseline estimated from each task's own last
measured run and labeled an estimate everywhere it appears.

Any MCP-capable agent can join a swarm through obsel's own MCP server (ten tools, seven for the page
and three for erasure; every mutation goes through obsel's HTTP API and the server holds no DataHub
credentials). The bring-your-own-data walkthrough in `docs/setup.md` was executed for real, with a
five-row expenses CSV and a renamed column. The downstream task was flagged at one hop in 3934 ms
and the redo cleared the flag. Declaring your own tasks needs no agent at all. A form on the page
posts to the same registration route the MCP tool calls, and that path ran against a live DataHub on
2026-07-26. Reporting the work still comes from whatever runs it, because obsel takes the
fingerprint from the rows itself, and a second implementation of that would be a second definition
of what counts as a change.

The video (2:59) follows the forty-agent run, the mid-swarm change and the repair end to end, then
closes on an erasure request opened against a live catalog, its report on camera reading 2 of 18
assets covered, 16 unattested, each of the two signed by a different team's key. That is a separate
run, walked two hops rather than four, and its figures are never combined with the 23-asset walk
above.

### Check it yourself

`pnpm verify` runs the typecheck, lint, 651 unit tests and the Python self-checks, no Docker needed.
`pnpm test:live` runs 176 tests against a real DataHub, the real `mcp-server-datahub`, a real obsel
server and real agent CLI sessions. Nothing in the repository is tested against a stand-in.
Everything that crosses a process boundary is covered against the real thing, and the one in-memory
stand-in that ever existed was deleted for cause, recorded in `docs/verification.md`. Every screen
in the video is a recording of a run that actually happened. One check needs nothing installed but
Node:

```
node scripts/verify-erasure-evidence.mjs examples/erasure-evidence/bundle.json
```

That re-runs obsel's own signature check and coverage kernel over a committed capture, offline, and
exits 0 only if the answer obsel recorded is the one the evidence supports. Change any signature,
key status or lineage edge in the file and it exits 1 naming the record and what failed.

### Built with

DataHub (quickstart; the forty-task numbers were measured on GMS v1.5.0.6 and the 2026-08-09 runs on
v1.7.0, each run's stack named in `docs/verification.md`) for the graph and the record; DataHub's
MCP server (`mcp-server-datahub`, pinned `==0.6.0`) for the tag writes; Next.js for the page; Python
for the agents and obsel's own MCP server; `node:crypto` for the Ed25519 signature arithmetic behind
the attestations, with no third-party cryptography added; the Codex CLI or Claude Code for the agent
sessions, whichever the operator has.

Where the tables an agent reads are already documented in DataHub, an optional step reads that
documentation through DataHub's Agent Context Kit (`datahub-agent-context` 1.7.0), read-only, in its
own environment, and folds it into the agent's prompt as a delimited section marked as data rather
than instructions. Verified live on 2026-08-09 against a cataloged dbt table, it returned one
description and 22 columns each carrying a native type, in three calls at 812, 590 and 626 ms. It
plays no part in the forty-task demo. obsel registers its own datasets without a description or a
schema, so there is nothing for the kit to return there, and the worker's prompt came back
byte-identical with the kit present and with it renamed away.

The traps found on the way, including the endpoint that fabricates entities for invented URNs and
the search index that lags freshly registered tasks, are documented with reproductions in
`docs/environment-findings.md` and were submitted through the feedback survey.

### What is honestly not proven

Forty-task detection has five observations, all on one machine. The other forty-task figures are
still one or two observations each. The Claude Code pass at that scale is a single run, pinned to
`claude-sonnet-5` at medium effort so it is repeatable rather than dependent on an account's current
default.

The erasure half has a page and no workflow behind it. Opening a request is a curl command, no agent
drives the tab on its own, and the attestations in those runs were signed by the operator rather
than routed to the owner of each asset and waited for. Nothing binds an attestation to a version
obsel derived from the warehouse itself, for the reason the erasure section states.

The Agent Context Kit is verified live for the bring-your-own-data case only. No live worker prompt
has yet carried a populated catalog section, because no obsel-registered dataset carries a
description for the kit to read.

obsel's case is the one where no single orchestrator owns the graph. Agents from different
frameworks join at runtime, and each becomes a node in a metadata platform that outlives them. The
prior-art survey is in `docs/concept.md`.

---

## 1a. Gallery captions, in order

1. **card5a_erasure_covered.** One erasure request against somebody else's catalog, seeded from one
   table: the walk reached 18 assets at two hops, and two Ed25519 signatures from two different
   teams covered two of them. 2 of 18 covered, 16 unattested, and no route can move the rest.
2. **card5b_erasure_compromised.** The same report 4.0 s after both signing keys were reported
   compromised. No asset was written and no version moved, so nothing else in obsel would have
   noticed: the coverage is derived on every read, both attestations are dropped with the reason
   named, and the report says 0 of 18 covered, 18 unattested.
3. **card1_hero.** Forty agent tasks, each a real DataJob in DataHub with Consumes and Produces
   edges to the tables it read and wrote. The record belongs to the catalog and outlives the run.
4. **card2_flagged.** One column renamed on a settled board: 9 of 40 flagged out to three hops, four
   of the nine never having read that table, the 30 outside it unflagged. Five observations of that
   change put detection at a median of 666 ms.
5. **card3_datahub.** The `obsel-stale` tag on a flagged job, read out of DataHub's own interface.
   obsel writes it through `mcp-server-datahub` and confirms it by reading `globalTags` back off the
   entity: 3 of 3 tagged.
6. **card4_repair.** The repair redid 6 of 9 flagged tasks in 37.8 s. The other three cleared
   without re-running, because an upstream redo came back identical. No endpoint clears a flag, and
   a live test asserts that.

---

## 2. Upstream issue comment, posted 2026-08-01

Posted on [datahub-project/datahub#18497](https://github.com/datahub-project/datahub/issues/18497),
which documented the symptom without the cause; the matching fix is open as
[PR #18810](https://github.com/datahub-project/datahub/pull/18810). Full detail with reproductions
in [`upstream-contributions.md`](upstream-contributions.md).

> Root cause and a one-line fix, found while using the CLI from an AI agent.
>
> The crash fires exactly when stdout is not a TTY, because `_DatapackGroup.format_help` in
> `metadata-ingestion/src/datahub/cli/datapack/datapack_cli.py` only reads
> `DATAPACK_AGENT_CONTEXT.md` on the non-TTY path. The file exists in the source tree but never
> reaches the built wheel: `package_data` in `metadata-ingestion/setup.py` declares
> `"datahub.cli.resources": ["*.md"]`, and the file lives in `datahub.cli.datapack.resources`. The
> installed wheel's `datahub/cli/datapack/resources/` contains only `__init__.py`, confirmed on
> acryl-datahub 1.6.0.15.
>
> Fix is one line in `package_data`:
>
> ```python
> "datahub.cli.datapack.resources": ["*.md"],
> ```
>
> Worth a regression test that imports the resource, since the failure is invisible to anyone at a
> terminal and guaranteed for the audience the file was written for: the non-TTY branch is the one
> AI agents hit.
>
> Reproduction showing the TTY dependence:
>
> ```bash
> script -q /dev/null datahub datapack --help >/dev/null 2>&1; echo "tty exit: $?"   # 0
> datahub datapack --help >/dev/null 2>&1; echo "piped exit: $?"                     # 1
> ```

---

## 3. Feedback survey draft

Each finding is reproduced and dated in [`environment-findings.md`](environment-findings.md);
section numbers below refer to it.

**What went well.** The lineage model held everything obsel needed: DataJobs with Consumes and
Produces edges, custom properties for the record, a tag for the human-visible flag. The Python SDK's
`DataHubGraph.exists()` and the v3 entity endpoints behave honestly. The MCP server's mutation tools
worked once pinned, and the whole project runs on the open-source quickstart.

**Findings that cost real time, each with a reproduction on file:**

1. `GET /entities/<urn>` fabricates a well-formed response for any syntactically valid URN,
   including invented ones (§1). Anything using it as an existence check will believe in entities
   that were never created. The v3 endpoint genuinely 404s and should be the documented answer.
2. GraphQL `searchAcrossLineage` serves from a search index that lags minutes behind the graph store
   and returns an empty list rather than an error for fresh entities (§7). A traversal built on it
   goes blind on exactly the newest tasks, silently. `GET /relationships` reads the graph store and
   does not have this problem.
3. `uvx mcp-server-datahub@latest` resolved to 0.4.0, which registers zero mutation tools and
   ignores `TOOLS_IS_MUTATION_ENABLED` without a warning (§2, §3). A version pin with `==` was the
   difference between marking work and silently marking nothing.
4. Writes are asynchronous, and a single immediate read-back returns false failures; retrying on a
   false failure double-writes (§6.1). Bounded polling confirmation should be the documented
   pattern, and the write-then-confirm receipt in §6.1 is a measured example.
5. Open-source Core has `add_tags` but no `create_tag`, so runtime vocabulary creation is impossible
   and setup-time registration is mandatory (§6.2). Fine as a design, worth a line in the MCP
   server's docs.
6. The graph store lags the aspect store by about a second on entity creation (§11), so registering
   an entity and immediately reading its membership edge fails intermittently. Confirming the edge,
   not the entity, is what made registration reliable.
7. The `datahub datapack` CLI crash in non-TTY contexts (issue #18497) has its root cause in
   `package_data`; a one-line fix is drafted above.

**One suggestion.** The agent-facing surfaces (MCP server, datapack context) are close to being
genuinely agent-usable, and the failures found were all of one kind: behavior that is fine for a
human at a terminal and wrong for a program reading the output. A CI job that exercises the non-TTY,
non-interactive paths would catch this whole class.
