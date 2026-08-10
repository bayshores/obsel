# What obsel is, and why

Written 2026-07-21. This carries forward the research done before any code was written, so the
reasoning behind the design does not have to be rediscovered.

---

## 1. The problem, in plain terms

Several AI agents work on the same data at the same time. Each builds on what an earlier one
produced. Then something upstream changes, perhaps a table getting rebuilt or a column getting
renamed, and every agent that already finished downstream is now holding work built on something
that is no longer true.

Nothing tells them. The work sits there marked complete. Someone finds out later, usually at the
worst moment.

## 2. Evidence the problem is real and current

**A dated first-person account.** Dave Paola, _"Stop parallelizing your AI agents"_, 2026-02-24
([source](https://thedailydeveloper.substack.com/p/stop-parallelizing-your-ai-agents)), describing a
sprint with four agents on one database. In his words: agent 4 adds a `deactivated_at` column and a
filter for active users, "which breaks agent 2's search query that didn't know about it." Agent 2 had
already finished. Verified by reading the article directly.

**Independent academic recognition, three papers in two months:**

| Paper                                                                                                 | Date       | What it does                                                                                    | Why it is not this                                                       |
| ----------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| CoAgent: Concurrency Control for Multi-Agent Systems ([2606.15376](https://arxiv.org/abs/2606.15376)) | 2026-06-13 | Runtime that informs agents when a parallel write invalidates their plan, so they can repair it | A research protocol, not a shipped tool; built on nothing existing       |
| GRADE ([2606.22741](https://arxiv.org/abs/2606.22741))                                                | 2026-06-22 | Two-layer graph of what each agent step relied on                                               | Recovered from traces **after the run**, for failure diagnosis, not live |
| Execution lineage for AI-native work ([2605.06365](https://arxiv.org/pdf/2605.06365))                 | 2026-05    | Invalidates only the true descendants of a changed artifact                                     | A proposed runtime, not shipped                                          |

The first two were verified by fetching their abstracts directly. The third comes from a search
summary and has not been read in full.

**Timeliness check.** The concern that this was already solved was tested on 2026-07-21 against
work from the preceding 30 days. It is not solved. The June 22 paper still states the gap plainly,
"a trace records what each step did, never what it relied on", and fixes it only after the fact.

## 3. What already exists, and the gap it leaves

Every shipped multi-agent coordination tool surveyed prevents collisions _before_ they happen. None
detects invalidation _after_ work is finished.

**Read that sentence narrowly.** It is a claim about agent-coordination tooling, and it was written
before orchestrators were checked. They were checked on 2026-07-23 and Dagster does detect
invalidation after the fact, cascading downstream, for assets declared in its own graph. Section 3a
records that in full, and section 3b records agent-coherence, the closest agent-side neighbour,
checked 2026-07-24. Nothing below should be read as claiming the idea is unprecedented.

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

### 3a. Orchestrators, checked properly on 2026-07-23

The survey above covered multi-agent coordination tools and catalog vendors. It did not cover data
orchestrators, which is where the strongest substitute actually lives, and skipping them was the
biggest hole in this document. Checked against primary documentation, not summaries. The result
narrows obsel's claim, and the narrowed claim is the one to make.

**Dagster is a genuine substitute, and does most of this already.** An asset is stale when its code
version or its upstream data has changed and it has not been re-materialized since, and any asset
downstream of a stale asset is stale too
([docs](https://docs.dagster.io/guides/build/assets/asset-versioning-and-caching)). That is the same
cascade obsel performs. **obsel is not novel here and the README must not imply it is.** Two real
differences survive:

- **Dagster's default data version is derived, not measured.** It is computed "by hashing a code
  version together with the data versions of any input assets", so bumping a code version marks
  everything downstream stale even when the output is byte-identical. That is exactly the false
  alarm obsel's first correctness rule exists to prevent. Dagster can be made content-addressed:
  user code may supply its own data version, and an observable source asset computes one from real
  contents. So this is a difference in default, not in capability, and should be described that way.
- **The asset must be declared in Dagster code first.** External assets are declared with
  `AssetSpec` before an outside process may report a materialization against them
  ([docs](https://docs.dagster.io/guides/build/assets/external-assets)); nothing found indicates an
  external process can create a new node at runtime. This is the difference that holds.

**dbt state-aware orchestration is closer than expected, and is a build optimiser rather than an
alarm.** It rebuilds a model when code changed, when a source has new data, when upstream models are
fresher than the prior run, and even when a table was deleted from the warehouse
([docs](https://docs.getdbt.com/docs/deploy/state-aware-about)). But it decides what to rebuild _on
the next run_. It does not leave already-finished work standing and flagged, which is obsel's entire
output. Separately, plain `state:modified` compares code and configuration, not data
([docs](https://docs.getdbt.com/faqs/State/state-modified-difference)).

**Airflow 3 assets schedule, they do not invalidate.** An asset update triggers the consuming DAG
([docs](https://airflow.apache.org/docs/apache-airflow/stable/authoring-and-scheduling/assets.html)).
Nothing found marks a completed task instance stale; the response to a change is a fresh run.

**DataHub's own observability answers the opposite question.** A Freshness Assertion detects a table
that has _not_ been updated inside a window, does not compare contents between runs, and is
["available as part of the DataHub Cloud Observe module"](https://docs.datahub.com/docs/managed-datahub/observe/freshness-assertions),
not the open-source stack obsel runs on. Impact analysis shows a human the blast radius before they
make a change. Both are useful and neither watches finished work after the fact.

**What honestly remains.** Every tool above requires one system to own the graph, with each node
declared in its project before it can participate. obsel's case is the one where no such owner
exists: agents from different frameworks and machines joining at runtime over MCP, each creating its
own node. Plus content-addressing by default, so an unchanged re-run is silent without anyone
wiring that up. **If the agents in question are Dagster assets, use Dagster.**

**The gap obsel fills:** live, retroactive invalidation of already-completed agent work, built on an
existing open metadata platform with a real UI, in the case where no single orchestrator owns the
graph. The "what can start next" half is table stakes and is not the pitch.

### 3b. agent-coherence, the closest neighbour, checked on 2026-07-24

Found during a competitive assessment and added here because leaving the nearest tool out of a
prior-art survey would make the survey worth less than nothing. Facts re-verified against the
project site, the GitHub repository (`hipvlady/agent-coherence`), and the paper behind it
([arXiv 2603.15183](https://arxiv.org/abs/2603.15183), "Token Coherence", Parakhin, March 2026)
before writing this.

**What it is.** A coherence layer for agents that share mutable state: shared plans, specs,
scratchpads, memory. It adapts MESI, the cache-coherence protocol CPUs use, to artifacts cached
per agent: a write commits to a coordinator, which sends small invalidation signals (about a dozen
tokens) to peers whose cached view just went stale, instead of rebroadcasting the artifact. The
paper reports simulated token savings of 84 to 95 percent over naive rebroadcast depending on
staleness tolerance, with the protocol invariants checked in TLA+. Adapters for LangGraph, CrewAI
and AutoGen.

**Where it genuinely overlaps obsel.** Both exist because one agent's finished reasoning can be
quietly built on another agent's superseded output, and both refuse to let that stay silent. The
stale-read-then-write-back failure it blocks is a first cousin of obsel's straddling reader.

**Where it is a different tool, in its own words.** The project draws the line itself: "If your
agents only read from sources you don't control, you need a freshness pipeline. If your agents
write to each other's state, you need a coherence protocol." agent-coherence is the second thing:
in-memory artifacts, inside one run, on a single host (multi-host is described as roadmap), with
the goal of preventing a lost update at the moment of write. obsel is closer to the first, with a
difference: it is not about whether a READ is about to be stale, it is about whether FINISHED,
reported work is still standing on ground that is still true, across sessions and machines, with
the record kept in a metadata platform other tools and people already read. obsel judges nothing
in flight and blocks nothing; it marks completed work after the fact, with the cause attached,
and the mark outlives every process that produced it.

**What obsel takes from the comparison.** Coherence for in-flight shared state and staleness for
finished recorded work compose rather than compete; a swarm could run both. And the existence of
a second tool, with a paper, built on the same underlying observation, is evidence the problem is
real rather than invented for a demo.

## 4. The second question the same graph answers

Everything above is about agents invalidating each other's finished work. The same wires answer a
question with far higher stakes, and it is the one this project now leads with.

Someone exercises their right to erasure under Article 17. An organization deletes their rows in one
system and reports it done. DataHub's own compliance writing puts the state of the art plainly:
lineage does not perform the deletion, it makes the scope of deletion knowable and verifiable. It
stops there. Ethyca verifies that deletion jobs ran against systems holding the subject key, not
absence where the identifier link is severed.

obsel occupies the layer after that sentence. It walks the recorded lineage from the tables known to
hold the subject, holds every reachable asset unattested, and composes independently signed local
claims into a global coverage picture no single attestor is positioned to assert. Composing signed
local claims into a conclusion nobody could assert alone is what in-toto verification is; applying
it to erasure accounting is what is new here.

**It is not a proof of erasure and does not claim to be.** obsel holds no warehouse credentials and
never reads warehouse data. What it adds to a trusted attestor's word is that the word is
attributable, scoped, version-bound, freshness-bound and revocable, and that everything nobody said
a word about is listed rather than omitted. The full rule, the counterexamples it survives, and
the classes of failure it provably does not catch are in
[`erasure-coverage.md`](erasure-coverage.md).

When the swarm's job is **building a data pipeline**, the things the agents produce are datasets, so
the coordination graph and the data catalog are literally the same graph. Dependencies between
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
`pipeline_docs` stale (transitively, through `daily_revenue`). All of it is visible in obsel's
page and in DataHub's own lineage view.

The cascade is the demonstration. Flagging only the direct dependent is the trivial version and does
not carry the demo.

## 6. Scale context, used honestly

Numbers found on 2026-07-21, from search summaries rather than primary sources. They set context;
none of them measures this specific problem, and the submission must not imply otherwise.

- 57% of organizations deploy multi-step agent workflows; 81% plan more complex use in 2026.
- Counterweight: one survey put teams with agents in production serving real users at ~5%. Agentic
  data engineering adoption specifically is described as low.
- Multi-agent systems consume roughly 15x the tokens of a single chat interaction; one cost analysis
  attributed 10 to 20% of agent sessions to redoing work another agent had already done.
- Integration with existing systems is the most-cited scaling challenge (46%).

**No published measurement exists of the cost of stale downstream agent work specifically.** The
demo therefore measures its own scenario live rather than citing a statistic that does not exist.

Two consequences for positioning. First, do not premise the pitch on large swarms being common,
because the problem appears the moment _two_ actors touch the same pipeline, including one agent and
one human, which is a far larger audience. Second, joining should cost nothing: any agent that can emit
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
`build_revenue` at one hop and `write_report` and `write_docs` at two, and neither of the latter had
ever read `clean_orders`. Measured at 92 ms for the full walk.

That test also produced a design correction worth more than the confirmation itself. DataHub answers
lineage from two places: GraphQL's `searchAcrossLineage`, served from a **search index that lags by
minutes**, and the REST `/relationships` endpoint, served from the **graph store, immediately**. On
freshly registered tasks the GraphQL surface returned nothing for over 90 seconds while the data was
provably present. obsel reasons about work registered seconds ago, so it walks the graph store. The
index would have made it blind exactly when it matters, and blind silently, because an empty result
reads identically to "nothing is affected". See `docs/environment-findings.md` §7.

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
already is. obsel uses the graph while the work is still happening instead.

## 9. Honest weaknesses

- The core loop is simple to describe and a naive version is a weekend build. The difficulty is in
  being correct: no false alarms on identical re-runs, transitive cascade, cycle termination,
  tolerating asynchronous writes. A naive version silently lies.
- The category brief publicly asks for agents working "as a team" that write results back, so
  another entrant could land nearby. The defense is depth and a demo that does not flinch.
- The operator mostly watches. This is infrastructure; the experience is thin by nature, which puts
  the entire weight of the demo on the invalidation moment being genuinely surprising.

### 9a. The silent participant, and what was done about it (2026-07-23)

The sharpest version of the weakness: obsel only learns anything when an agent reports, so an agent
that writes a shared table and never reports is invisible, and the resulting silence reads as "all
clear", which is worse than no tool.

Shipped mitigation, the reader-side cross-check. Every completion may carry fingerprints of what
the task **read** as well as what it wrote (`worker.py` sends them automatically; the MCP
`report_complete` takes them as `inputs`). The engine compares each observation against what that
dataset's producer recorded writing. A mismatch is a change nothing reported: every finished task
built on the old version is marked, `causedByTask` is null because the author is unknown, and the
reason says obsel noticed it through a read. The first observation is recorded on the producer
(`obsel.observed`) so later identical reads do not re-flag. Proven live in
`tests/live/engine.live.test.ts` ("a change nothing reported is caught by the next honest read").

The page's quiet claim is bounded to match: "none of the tables they read has changed since, as of
the last report at 17:42:07" rather than an unbounded all-clear.

What this deliberately does not fix, in honesty order:

- **Coverage grows with reads, not with time.** Between the silent write and the next honest read
  of that table, obsel is still blind. A user who wants the gap closed can run any agent that
  re-reads the tables and reports, since the mechanism is already the ordinary completion report, or
  in a real warehouse feed change-data-capture into the same API. Neither is built here.
- **A table obsel has never been told about stays invisible.** No tool can walk downstream of a
  node it does not know exists; the orchestrators in 3a answer this with up-front declaration,
  obsel answers it by making joining cost one call. The gap between those two is fundamental.
