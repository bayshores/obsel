# Environment findings

Findings measured directly against a real local DataHub, recorded because several of them contradict
the documentation and would make obsel report confident wrong answers.

These were gathered on 2026-07-21 during an earlier design for this project (an ML lineage auditor,
since abandoned — see `docs/concept.md` §8). The DataHub behavior is independent of that design and
carries over unchanged; where the original rationale was specific to the old concept, it has been
rewritten for obsel.

Every claim here was measured on this machine on 2026-07-21 against GMS `v1.5.0.6`
(`serverEnv: core`, `serverType: quickstart`) with `showcase-ecommerce` loaded. Commands are given
so each is reproducible rather than asserted.

---

## 1. `GET /entities/<urn>` fabricates entities that do not exist

**Severity: critical for this project specifically.**

The GMS REST endpoint `GET /entities/<urn>` returns a well-formed snapshot with a synthesised *key*
aspect for **any syntactically valid URN**, including one invented on the spot. It does not 404.

```bash
curl -s "http://localhost:8080/entities/urn%3Ali%3AmlModel%3A%28urn%3Ali%3AdataPlatform%3Amlflow%2CTOTALLY_INVENTED_qqq999%2CPROD%29"
```

Returns:

```json
{"value":{"com.linkedin.metadata.snapshot.MLModelSnapshot":{
  "urn":"urn:li:mlModel:(urn:li:dataPlatform:mlflow,TOTALLY_INVENTED_qqq999,PROD)",
  "aspects":[{"com.linkedin.metadata.key.MLModelKey":{
    "origin":"PROD","name":"TOTALLY_INVENTED_qqq999","platform":"urn:li:dataPlatform:mlflow"}}]}}}
```

The key aspect is derived from parsing the URN string, not from stored data.

**Why this matters to obsel.** obsel decides what is stale by walking from a changed output to the
tasks that consumed it. An existence check built on `/entities/` would confirm every phantom URN as
a real entity, so a typo or a stale reference in a task's declared inputs would produce a confident
staleness verdict about a task that does not exist — or, worse, silently mask one that does.

**Required predicate.** Use `DataHubGraph.exists()`, which is correct:

```bash
/Users/seane/.local/share/uv/tools/acryl-datahub/bin/python -c "
from datahub.ingestion.graph.client import DataHubGraph, DatahubClientConfig
g=DataHubGraph(DatahubClientConfig(server='http://localhost:8080'))
print(g.exists('urn:li:mlModel:(urn:li:dataPlatform:mlflow,TOTALLY_INVENTED_qqq999,PROD)'))  # False
print(g.exists('urn:li:dataset:(urn:li:dataPlatform:powerbi,b2fd91.datahub_order_entries.ORDER_DETAILS,PROD)'))  # True
"
```

**Rule for this repository:** `/entities/` must never be used to establish existence. Entity
existence is a proof obligation like any other, and it needs a predicate that can return false.

---

## 2. `mcp-server-datahub@latest` silently resolves to a read-only 0.4.0

**Severity: critical. Silently removes the entire write path.**

`uvx mcp-server-datahub@latest` resolved to **0.4.0** (published 2025-11-19) on this machine, not the
current 0.6.0. Version 0.4.0 has no mutation tools at all and does not know the
`TOOLS_IS_MUTATION_ENABLED` variable, so setting it has no effect **and produces no warning**. obsel
would then detect staleness correctly and silently fail to mark any of it.

```bash
uvx mcp-server-datahub@latest  --version   # => mcp-server-datahub, version 0.4.0
uvx mcp-server-datahub==0.6.0  --version   # => mcp-server-datahub, version 0.6.0
```

| Invocation | Tools registered | Mutation tools |
| --- | --- | --- |
| `@latest` (resolved 0.4.0) | 6 | 0 |
| `==0.6.0` | 21 | 11 |

**Rule for this repository:** the MCP server version is pinned everywhere — scripts, docs, README,
and CI. `@latest` is forbidden. An agent that reports success while writing nothing is the worst
available failure mode for a tool whose entire job is marking things.

---

## 3. Actual tool inventory on open-source DataHub Core

Measured over stdio against GMS `v1.5.0.6` with `mcp-server-datahub==0.6.0`,
`TOOLS_IS_MUTATION_ENABLED=true`, `TOOLS_IS_USER_ENABLED=true`. **21 tools:**

**Read (10):** `search`, `get_entities`, `list_schema_fields`, `get_lineage`,
`get_lineage_paths_between`, `get_dataset_queries`, `search_documents`, `grep_documents`, `get_me`,
`save_document`¹

**Write (11):** `add_tags`, `remove_tags`, `add_terms`, `remove_terms`, `add_owners`,
`remove_owners`, `set_domains`, `remove_domains`, `add_structured_properties`,
`remove_structured_properties`, `update_description`

¹ `save_document` is a write, listed here because it is the knowledge-capture primitive rather than a
metadata mutation.

### Documented tools that do **not** exist on open-source Core

`docs.datahub.com` documents a larger surface than open-source Core registers. These were confirmed
absent from the live listing and must not appear in obsel's design:

- **The entire proposals workflow** — `propose_create_glossary_term`, `propose_lifecycle_stage`,
  `list_pending_proposals`, `accept_or_reject_proposals`
- `find_sql_context`, `draft_sql_for_tables`
- `get_dataset_assertions`
- `create_glossary_term`, `create_glossary_term_version`, `add_related_terms`,
  `set_lifecycle_stage`, `list_lifecycle_stages`, `get_glossary_term_versions`

**Consequence for obsel:** there is no proposal queue to route a staleness mark through for human
review, so a mark is applied directly as a tag plus structured properties. `save_document` is
available if a richer human-readable explanation needs to hang off the entity.

Tool listings are also environment-dependent: `search_documents` and `grep_documents` register only
because showcase-ecommerce loaded 18 documents. Never hardcode an expected tool set; query
`tools/list` and fail loudly if a required tool is absent.

### Confirmed present, and load-bearing

- **`get_lineage_paths_between`** is available. obsel needs it to show *why* a task is stale — the
  exact path from the changed output to the task that consumed it, which is what makes a mark
  actionable rather than an alarm.
- **`get_lineage`** is available, and is the traversal primitive the cascade depends on.
- **`update_description`** is available on Core despite a changelog note suggesting otherwise.
- **`get_dataset_queries`** is available. Not currently on obsel's path, but it returns the real SQL
  referencing a dataset, which is a candidate source for fingerprinting an output's meaning rather
  than its bytes.

---

## 4. The local quickstart cannot issue a Personal Access Token

`datahub docker quickstart` sets `METADATA_SERVICE_AUTH_ENABLED=false` on the GMS container, which
disables the UI's Settings → Access Tokens page.

```bash
docker inspect datahub-datahub-gms-quickstart-1 | grep METADATA_SERVICE_AUTH_ENABLED   # => false
```

This is harmless in practice because GMS then accepts unauthenticated requests and the MCP server's
token is optional — both the GraphQL endpoint (`:8080/api/graphql`) and the OpenAPI entity endpoints
answered without any credential during this work.

It is only a problem for a design that assumes bearer auth. To obtain a real PAT the stack must be
recreated with `METADATA_SERVICE_AUTH_ENABLED=true`, and
`DATAHUB_TOKEN_SERVICE_SIGNING_KEY`/`DATAHUB_TOKEN_SERVICE_SALT` should be set before first start so
tokens survive restarts.

---

## 5. Counting entities: use GraphQL aggregation, not the OpenAPI entity endpoint

`GET /openapi/v3/entity/{type}` paginates via `scrollId` and caps returned rows, so counting the
`entities` array understates totals and cannot support a claim of zero. Use the GraphQL aggregation
endpoint instead — see `docs/upstream-contributions.md` §3 for the exact query and the full census.

Ingestion is also asynchronous (`ASYNC_BATCH` over Kafka): counts continue rising for minutes after
`datahub datapack load` exits successfully. Always wait for counts to stabilise before asserting
anything about graph contents.

---

## 6. Write semantics, verified by round-trip

A full round-trip was run over MCP against a real dataset: apply a tag, confirm via GraphQL, remove
it, confirm removal. **obsel has a verified write path** — marking a task stale, and clearing that
mark, both work. Three constraints came out of it.

### 6.1 Writes are asynchronous; immediate read-back is unreliable

The first round-trip attempt failed at the removal step. `add_tags` succeeded and the tag was
readable, but `remove_tags` issued immediately afterwards errored and the tag survived. The
identical call, run seconds later as a separate process, succeeded:

```
add_tags     -> {"success":true,"message":"Successfully added 1 tag(s) to 1 entit(ies)"}
remove_tags  -> isError=True          (immediately after the add)
remove_tags  -> {"success":true,...}  (moments later, same arguments)
```

**Consequence for obsel.** Confirming a stale mark landed must tolerate propagation delay — poll
with a bounded timeout rather than reading once. A single immediate read-back produces false "write
failed" verdicts, and a naive retry on that false verdict double-writes.

This also sets the honest floor on obsel's headline number. Detection is fast; the mark becoming
visible is bounded by this propagation delay. Demo and README timing claims must be measured
end-to-end, including it, and stated as a real number — never "instant".

### 6.2 obsel cannot mint new labels; it can only apply existing vocabulary

Applying a tag URN that does not already exist as an entity is rejected:

```
Error add tags: Failed to validate label with urn urn:li:tag:attest-write-probe. Urn does not exist.
```

There is no `create_tag` or `create_glossary_term` in the open-source tool surface, so **the agent
cannot invent a classification at runtime.** Any tag obsel applies must already exist, registered out
of band.

Practical consequence: obsel's own vocabulary — the stale marker and anything alongside it — is
registered once during setup, and setup must fail loudly if registration did not land. A missing tag
at runtime means staleness is detected and silently not recorded, which is the failure mode this
whole document exists to prevent.

### 6.3 Real parameter shapes

The tools take plural arrays, not a single `urn`, and the schema is strict
(`additionalProperties: false`):

```jsonc
// add_tags / remove_tags
{
  "tag_urns":    ["urn:li:tag:b2fd91.PII_Data"],   // required
  "entity_urns": ["urn:li:dataset:(...)"],          // required
  "column_paths": ["email_address"]                 // optional, same length as entity_urns
}
```

`column_paths` gives **column-level tagging** — obsel can point at the specific field that changed
rather than the whole dataset, which makes a stale mark far more useful to read. Pass `null` or an
empty string for entity-level application.

---

## 7. Lineage: the search index lags by minutes, the graph store does not

**Severity: decides obsel's core traversal. Measured 2026-07-21.**

DataHub answers "what is downstream of X" from two different places, and they do not agree on
recently written data.

| Surface | Backed by | Sees data written seconds ago | Hops |
| --- | --- | --- | --- |
| `searchAcrossLineage` (GraphQL) | search index | **No** — lagged by minutes | multi-hop, returns `degree` |
| `GET /relationships` (REST) | graph store | **Yes** — immediate | one hop per call |

Three agent tasks were registered, then queried immediately. `searchAcrossLineage` returned **0
results for over 90 seconds** while `/relationships` returned the edges correctly the whole time.
The same query against entities written ~15 minutes earlier returned results on the first attempt.
The index caught up during the session (0 → 6 results), confirming lag rather than failure.

The data itself was never in doubt: `graph.exists()` was true for every entity, and
`get_aspect(..., DataJobInputOutputClass)` returned the correct inputs and outputs throughout.

**Why this decides the design.** obsel coordinates a swarm that is working *right now*, so the tasks
it must reason about are always the most recently registered ones — precisely the ones the search
index cannot see. Building traversal on `searchAcrossLineage` would make obsel blind exactly when it
matters, and the failure is silent: it returns an empty list, not an error, which reads identically
to "nothing is affected."

**Consequence:** obsel walks the graph store. `/relationships` is one hop, so the cascade is
hand-rolled, alternating direction by entity type:

```
dataset --(INCOMING "Consumes")--> tasks that READ it
task    --(OUTGOING "Produces")--> datasets it WROTE   ->  repeat
```

Verified end to end on the four-table, three-task demo shape: a change to `clean_orders` returned
`build_revenue` at hop 1, then `write_report` and `write_docs` at hop 2 — both reached transitively,
neither having ever read `clean_orders`. **Full cascade in 92 ms**, on data the index still could not
see. A visited set is carried so a cyclic graph terminates.

`searchAcrossLineage` remains useful for anything not time-sensitive, and its `degree` field is a
convenient cross-check once the index has settled.

```bash
# one hop, immediate — the predicate obsel traverses on
curl -s "http://localhost:8080/relationships?urn=<url-encoded-dataset-urn>&direction=INCOMING&types=Consumes"
```

---

## 8. Open questions, not yet resolved

These are recorded as unknown rather than guessed. Each must be settled before the code that depends
on it is written.

0. ~~**Does lineage traversal actually return agent tasks?**~~ **RESOLVED 2026-07-21: yes.** A
   `DataJob` registered with `Consumes`/`Produces` edges is returned when walking downstream from a
   dataset it reads, and the cascade is transitive. See section 7 — with the important correction
   that this only holds immediately via the graph store, not the search index.
1. **Structured-property definitions must exist before values can be written**, and there is no MCP
   tool that creates one. The instance currently has only 5 `showcase.*` properties, none scoped to
   `dataJob`. The definition path — YAML plus `datahub properties upsert`, or the Python SDK — has
   not yet been exercised here. obsel needs at least one property to carry a mark's reason.
2. **Attribution on structured properties.** `upsertStructuredProperties` reportedly calls
   `removeAttribution()`, so DataHub's native attribution metadata may not survive an MCP write.
   obsel's reason and source-change data live *inside* the property values, so this is expected to
   be tolerable, but it has not been verified.
3. **Durability across re-ingestion** — whether written values survive a later ingestion run — is
   untested, and decides whether a mark from one run is still there for the next.
4. **Whether the MCP filter DSL accepts `entity_type = dataJob`.** If not, agent tasks cannot be
   discovered via `search` and must be traversed by URN from a known root.
5. **Client/server version skew.** CLI `1.6.0.15` against GMS `v1.5.0.6`. Aspect rejection
   (`422 ValidationException`) is the likely failure mode when emitting `dataJobInputOutput`, and a
   rejected `(entityType, aspectName)` pair can be dropped silently — so registration must verify
   what actually landed rather than trusting a successful exit code.
