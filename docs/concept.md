# What obsel is, and why

Written 2026-07-21. This carries forward the research done before any code was written, so the
reasoning behind the design does not have to be rediscovered.

---

## 1. The problem, in plain terms

Several AI agents work on the same data at the same time. Each builds on what an earlier one
produced. Then something upstream changes — a table gets rebuilt, a column gets renamed — and every
agent that already finished downstream is now holding work built on something that is no longer
true.

Nothing tells them. The work sits there marked complete. Someone finds out later, usually at the
worst moment.

## 2. Evidence the problem is real and current

**A dated first-person account.** Dave Paola, _"Stop parallelizing your AI agents"_, 2026-02-24
([source](https://thedailydeveloper.substack.com/p/stop-parallelizing-your-ai-agents)) — a sprint
with four agents on one database. In his words: agent 4 adds a `deactivated_at` column and a filter
for active users, "which breaks agent 2's search query that didn't know about it." Agent 2 had
already finished. Verified by reading the article directly.

**Independent academic recognition, three papers in two months:**

| Paper                                                                                                 | Date       | What it does                                                                                    | Why it is not this                                                        |
| ----------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| CoAgent: Concurrency Control for Multi-Agent Systems ([2606.15376](https://arxiv.org/abs/2606.15376)) | 2026-06-13 | Runtime that informs agents when a parallel write invalidates their plan, so they can repair it | A research protocol, not a shipped tool; built on nothing existing        |
| GRADE ([2606.22741](https://arxiv.org/abs/2606.22741))                                                | 2026-06-22 | Two-layer graph of what each agent step relied on                                               | Recovered from traces **after the run**, for failure diagnosis — not live |
| Execution lineage for AI-native work ([2605.06365](https://arxiv.org/pdf/2605.06365))                 | 2026-05    | Invalidates only the true descendants of a changed artifact                                     | A proposed runtime, not shipped                                           |

The first two were verified by fetching their abstracts directly. The third comes from a search
summary and has not been read in full.

**Timeliness check.** The concern that this was already solved was tested on 2026-07-21 against
work from the preceding 30 days. It is not solved: the June 22 paper still states the gap plainly —
"a trace records what each step did, never what it relied on" — and fixes it only after the fact.

## 3. What already exists, and the gap it leaves

Every shipped multi-agent coordination tool surveyed prevents collisions _before_ they happen. None
detects invalidation _after_ work is finished.

- **Prevention is the whole state of the art.** A representative April 2026 survey of the field
  ([source](https://getautonoma.com/blog/parallel-ai-agent-prs)) lists five strategies: scope agents
  to non-overlapping work, branch isolation with frozen bases, serialized merge queues, explicit
  overlap zones, verify-after-merge. Each was checked. All five are preventive; none flags completed
  work retroactively.
- **Git worktrees, file locks, and dependency-ordered task lists** are the common mechanisms. They
  answer "what may start now," never "what already finished is now wrong."
- **The newest shipping agent-team tooling** has a shared task list with dependencies, a mailbox,
  and idle notifications. Its documentation does not mention detecting invalidated finished work.
- **No data-catalog vendor points their graph at this.** Atlan, Collibra, Alation, and DataHub's own
  public writing about AI agents is backward-looking (audit, governance, trustworthy answers) or
  read-direction (giving agents context before they act). None coordinates in-flight agent work.

**The gap obsel fills:** live, retroactive invalidation of already-completed agent work, built on an
existing open metadata platform with a real UI. The "what can start next" half is table stakes and
is not the pitch.

## 4. Why DataHub, and not a task queue

The strongest anticipated judge question. The answer is the demo scenario, not an argument.

When the swarm's job is **building a data pipeline**, the things the agents produce are datasets —
so the coordination graph and the data catalog are literally the same graph. Dependencies between
agent tasks are dependencies between tables, which is what DataHub already models natively. A
side-channel task queue would have to reinvent lineage, and would know nothing about the data.

Secondary benefits that fall out of the same choice: DataHub's own lineage UI displays the swarm's
structure with no extra work, and the record left behind after the run is a permanent, queryable
account of which agent built what on top of what.

## 5. The demo scenario

Four agent workers build a small pipeline, in dependency order:

```
clean_orders  ->  daily_revenue  ->  revenue_report
                                 ->  pipeline_docs
```

All four finish. Then `clean_orders` re-runs and renames a column. obsel detects the changed output,
walks downstream, and marks `daily_revenue` stale (direct), then `revenue_report` and
`pipeline_docs` stale (transitively, through `daily_revenue`) — visible in obsel's cockpit and in
DataHub's own lineage view.

The cascade is the demonstration. Flagging only the direct dependent is the trivial version and does
not carry the demo.

## 6. Scale context, used honestly

Numbers found on 2026-07-21, from search summaries rather than primary sources. They set context;
none of them measures this specific problem, and the submission must not imply otherwise.

- 57% of organizations deploy multi-step agent workflows; 81% plan more complex use in 2026.
- Counterweight: one survey put teams with agents in production serving real users at ~5%. Agentic
  data engineering adoption specifically is described as low.
- Multi-agent systems consume roughly 15x the tokens of a single chat interaction; one cost analysis
  attributed 10–20% of agent sessions to redoing work another agent had already done.
- Integration with existing systems is the most-cited scaling challenge (46%).

**No published measurement exists of the cost of stale downstream agent work specifically.** The
demo therefore measures its own scenario live rather than citing a statistic that does not exist.

Two consequences for positioning. First, do not premise the pitch on large swarms being common —
the problem appears the moment _two_ actors touch the same pipeline, including one agent and one
human, which is a far larger audience. Second, joining should cost nothing: any agent that can emit
an OpenLineage event (the neutral standard DataHub already ingests, which Airflow and dbt already
speak) can participate, with no rewrite into a new framework.

## 7. What is verified, and what is not

**Verified hands-on** (see `docs/environment-findings.md` for reproductions): the local DataHub
stack runs; the MCP server exposes 21 tools including 11 writes when correctly pinned; tags can be
applied and removed over MCP and confirmed via GraphQL; writes are asynchronous; `/entities/`
fabricates entities; `@latest` resolves to a broken read-only version; new tag vocabulary cannot be
minted at runtime.

**The load-bearing assumption is now verified.** An agent task registered as a `DataJob` with
`Consumes`/`Produces` edges _is_ returned when walking downstream from a dataset it reads, and the
cascade is transitive: on the four-table demo shape, a change to `clean_orders` reached
`build_revenue` at one hop and `write_report` and `write_docs` at two — neither of the latter having
ever read `clean_orders`. Measured at 92 ms for the full walk.

That test also produced a design correction worth more than the confirmation itself. DataHub answers
lineage from two places: GraphQL's `searchAcrossLineage`, served from a **search index that lags by
minutes**, and the REST `/relationships` endpoint, served from the **graph store, immediately**. On
freshly registered tasks the GraphQL surface returned nothing for over 90 seconds while the data was
provably present. obsel reasons about work registered seconds ago, so it walks the graph store; the
index would have made it blind exactly when it matters, and silently — an empty result reads
identically to "nothing is affected". See `docs/environment-findings.md` §7.

Still unproven: whether obsel's marks survive re-ingestion, and whether structured-property
definitions can be created without leaving the MCP surface.

## 8. Ideas rejected on the way here

Recorded so they are not re-proposed. Four concepts were dropped before this one, each for a checked
reason: an ML model-card auditor (sound, but every catalog vendor is racing into that same
governance-flavored shape); a tool-tampering detector (already shipping from Trail of Bits, Snyk,
Docker, and Vercel); a contradiction referee between agents (real, but judged not impactful); and a
lineage-based incident filer (Atlan, Databricks, and Alation all had near-identical offerings).

The pattern behind all four: _point an agent at the catalog, have it check something, write a
finding back._ That shape is inherently backward-looking and is exactly where every funded competitor
already is. obsel is forward-looking — it uses the graph while the work is happening.

## 9. Honest weaknesses

- The core loop is simple to describe and a naive version is a weekend build. The difficulty is in
  being correct: no false alarms on identical re-runs, transitive cascade, cycle termination,
  tolerating asynchronous writes. A naive version silently lies.
- The category brief publicly asks for agents working "as a team" that write results back, so
  another entrant could land nearby. The defense is depth and a demo that does not flinch.
- The operator mostly watches. This is infrastructure; the experience is thin by nature, which puts
  the entire weight of the demo on the invalidation moment being genuinely surprising.
