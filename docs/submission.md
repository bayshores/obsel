# Submission drafts

Three drafts, ready to file. Filing any of them is Sean's action, never automated: the Devpost
form, the GitHub comment, and the feedback survey are all outward-facing. Every number in here is
measured and traceable to [`verification.md`](verification.md); if a number there changes, it
changes here in the same commit.

---

## 1. Devpost description draft

**Elevator:** obsel flags finished agent work when the ground it was built on moves.

### The problem

When several AI agents build on each other's data, each one finishes and reports done. If
something upstream changes after a downstream agent already finished, that finished work is now
wrong, and nothing tells anyone. It sits there looking complete. The more agents you run, the more
finished-looking wrong work you accumulate, and at forty tasks nobody can eyeball what a change
reached.

### What obsel does

Every agent task becomes a real DataJob in DataHub, wired with Consumes and Produces lineage to
the tables it reads and writes. The lineage graph is the coordination: there is no message bus and
no scheduler. When an agent reports completion, obsel fingerprints what it produced (sha256 over
schema and content, separately, so a rename is distinguishable from new rows), compares against
the recorded baseline, and walks DataHub's own lineage downstream. Finished work built on the
changed table gets marked stale, with the cause, the hop distance, and a plain sentence stored on
the mark. The `obsel-stale` tag lands on the DataJob through DataHub's MCP server, so the flag shows up in
DataHub's own UI beside obsel's page.

The rules that make the flags trustworthy:

- A re-run that produces the same output marks nothing. Staleness is decided by fingerprint
  comparison, never by "a write happened". "The same" is the fingerprint's word: rows are sorted
  before hashing and columns the task registered as volatile are excluded, so a re-run differing
  only in row order or only in a load timestamp counts as identical. Proven at forty tasks: an
  identical re-run marked zero of 40.
- Work in flight is never judged. A mid-swarm change marked 8 finished tasks in a measured
  13,349 ms while 9 agents were still running, and none of the nine was touched.
- Flags clear only through redone work. There is no route and no tool that clears a flag, because
  a tool to declare work fresh would be a tool for silencing the one thing obsel is for. When a
  flagged task re-runs and its output comes back identical, obsel clears the downstream flags
  that redo provably restores, and only those.
- Every number on the page was measured, or it is withheld. A failed read blanks every stat.

### The demo

Forty real Codex agent sessions build a pipeline over one week of real NYC yellow-taxi trips
(2,100 rows, sha256-pinned, provenance documented), concurrently, peak 8 at once, 252.6 s wall
clock. One agent re-runs with a renamed column, and how much that reaches depends on how much has
finished, which is the product rather than a caveat about it. Three measured runs, each named
because they give different counts:

- **Settled board, 2026-07-24.** `daily_trips` renamed its column with every task complete: **9 of
  40** marked out to three hops in **3968 ms**, the other 31 untouched, all nine tags confirmed in
  DataHub.
- **Mid-swarm, the same day.** The same rename while **9 agents were still in flight**: **8 of 40**
  finished tasks marked in **13,349 ms**, five direct readers and three transitive, and not one of
  the nine running agents touched. `report_city` finished after the cascade on inputs that had not
  moved and was correctly left alone.
- **The run the video is cut from.** The change marked **7 of 40**, detection **658 ms**.

Then the repair, from the 8-flag page: obsel redoes only the flagged work, in parallel, and every
time a redo lands identical it cancels the downstream redos that are now provably unnecessary.
Measured: 5 of 8 redone in 42.4 s against
roughly 188 s to redo everything, that baseline estimated from each task's own last measured run
and labeled as an estimate everywhere it appears.

Any MCP-capable agent can join a swarm through obsel's own MCP server (ten tools, seven for the
page and three for erasure; every mutation goes through obsel's HTTP API and the server holds no
DataHub credentials). The
bring-your-own-data walkthrough in `docs/setup.md` was executed for real: a five-row expenses CSV,
a renamed column, the downstream task flagged at one hop in 3,934 ms, the flag cleared by the
redo. Declaring your own tasks does not need an agent at all: a form on the page posts to the same
registration route the MCP tool calls, driven against a real DataHub on 2026-07-26. Reporting the
work still comes from whatever runs it, because obsel takes the fingerprint from the rows itself and
a second implementation of that would be a second definition of what counts as a change.

### Built with

DataHub (quickstart, GMS v1.5.0.6) for the graph and the record; DataHub's MCP server
(`mcp-server-datahub`, pinned `==0.6.0`) for the tag writes; Next.js for the page; Python for
the agents and obsel's own MCP server; the Codex CLI or Claude Code for the real agent sessions,
whichever the operator has. The traps found on
the way, including the endpoint that fabricates entities for invented URNs and the search index
that lags freshly registered tasks, are documented with reproductions in
`docs/environment-findings.md` and were submitted through the feedback survey.

### What is honestly not proven

Forty-task detection has five observations on one machine; the other forty-task figures remain one
or two observations on one machine. The engine never uses a model for its decisions, so the flags
are deterministic, but the agent is a live model and its output needed pinning three times
(documented). One forty-task Claude Code pass ran on one machine with `claude-sonnet-5` at medium
effort. Dagster does retroactive invalidation for assets declared in its own code, and
agent-coherence handles the in-memory half of this problem for shared artifacts inside one run; the
prior-art survey in `docs/concept.md` names both rather than claiming novelty they would disprove.
obsel's case is the one where no single orchestrator owns the graph: agents from different
frameworks joining at runtime, each becoming a node in a metadata platform that outlives them.

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
> `"datahub.cli.resources": ["*.md"]`, and the file lives in `datahub.cli.datapack.resources`.
> The installed wheel's `datahub/cli/datapack/resources/` contains only `__init__.py`, confirmed
> on acryl-datahub 1.6.0.15.
>
> Fix is one line in `package_data`:
>
> ```python
> "datahub.cli.datapack.resources": ["*.md"],
> ```
>
> Worth a regression test that imports the resource, since the failure is invisible to anyone at
> a terminal and guaranteed for the audience the file was written for: the non-TTY branch is the
> one AI agents hit.
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
Produces edges, custom properties for the record, a tag for the human-visible flag. The Python
SDK's `DataHubGraph.exists()` and the v3 entity endpoints behave honestly. The MCP server's
mutation tools worked once pinned, and the whole project runs on the open-source quickstart.

**Findings that cost real time, each with a reproduction on file:**

1. `GET /entities/<urn>` fabricates a well-formed response for any syntactically valid URN,
   including invented ones (§1). Anything using it as an existence check will believe in entities
   that were never created. The v3 endpoint genuinely 404s and should be the documented answer.
2. GraphQL `searchAcrossLineage` serves from a search index that lags minutes behind the graph
   store and returns an empty list rather than an error for fresh entities (§7). A traversal
   built on it goes blind on exactly the newest tasks, silently. `GET /relationships` reads the
   graph store and does not have this problem.
3. `uvx mcp-server-datahub@latest` resolved to 0.4.0, which registers zero mutation tools and
   ignores `TOOLS_IS_MUTATION_ENABLED` without a warning (§2, §3). A version pin with `==` was
   the difference between marking work and silently marking nothing.
4. Writes are asynchronous, and a single immediate read-back returns false failures; retrying on
   a false failure double-writes (§6.1). Bounded polling confirmation should be the documented
   pattern, and the write-then-confirm receipt in §6.1 is a measured example.
5. Open-source Core has `add_tags` but no `create_tag`, so runtime vocabulary creation is
   impossible and setup-time registration is mandatory (§6.2). Fine as a design, worth a line in
   the MCP server's docs.
6. The graph store lags the aspect store by about a second on entity creation (§11), so
   registering an entity and immediately reading its membership edge fails intermittently.
   Confirming the edge, not the entity, is what made registration reliable.
7. The `datahub datapack` CLI crash in non-TTY contexts (issue #18497) has its root cause in
   `package_data`; a one-line fix is drafted above.

**One suggestion.** The agent-facing surfaces (MCP server, datapack context) are close to being
genuinely agent-usable, and the failures found were all of one kind: behavior that is fine for a
human at a terminal and wrong for a program reading the output. A CI job that exercises the
non-TTY, non-interactive paths would catch this whole class.
