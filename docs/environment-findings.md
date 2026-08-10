# Environment findings

Findings measured directly against a real local DataHub, recorded because several of them contradict
the documentation and would make obsel report confident wrong answers.

These were gathered on 2026-07-21 during an earlier design for this project (an ML lineage auditor,
since abandoned, see `docs/concept.md` §8). The DataHub behavior is independent of that design and
carries over unchanged; where the original rationale was specific to the old concept, it has been
rewritten for obsel.

Every claim here was measured on this machine, `serverEnv: core`, `serverType: quickstart`, with
`showcase-ecommerce` loaded. Commands are given so each is reproducible rather than asserted.

Sections 1 to 9 were measured on 2026-07-21. Sections 10 and 11 were measured on 2026-07-23 and say
so, so a reader can tell how old any given claim is rather than trusting one date for all of them.

**The GMS build changed partway down this file.** Sections 1 to 14 were measured against
`v1.5.0.6`. Section 16 records `GET /config` reporting `v1.7.0` on 2026-08-09, and section 16 is the
only one measured against it. Nothing in sections 1 to 15 has been re-checked on `v1.7.0`, and
nothing in section 16 has been checked on `v1.5.0.6`.

---

## 1. `GET /entities/<urn>` fabricates entities that do not exist

**Severity: critical for this project specifically.**

The GMS REST endpoint `GET /entities/<urn>` returns a well-formed snapshot with a synthesised _key_
aspect for **any syntactically valid URN**, including one invented on the spot. It does not 404.

```bash
curl -s "http://localhost:8080/entities/urn%3Ali%3AmlModel%3A%28urn%3Ali%3AdataPlatform%3Amlflow%2CTOTALLY_INVENTED_qqq999%2CPROD%29"
```

Returns:

```json
{
  "value": {
    "com.linkedin.metadata.snapshot.MLModelSnapshot": {
      "urn": "urn:li:mlModel:(urn:li:dataPlatform:mlflow,TOTALLY_INVENTED_qqq999,PROD)",
      "aspects": [
        {
          "com.linkedin.metadata.key.MLModelKey": {
            "origin": "PROD",
            "name": "TOTALLY_INVENTED_qqq999",
            "platform": "urn:li:dataPlatform:mlflow"
          }
        }
      ]
    }
  }
}
```

The key aspect is derived from parsing the URN string, not from stored data.

**Why this matters to obsel.** obsel decides what is stale by walking from a changed output to the
tasks that consumed it. An existence check built on `/entities/` would confirm every phantom URN as
a real entity, so a typo or a stale reference in a task's declared inputs would produce a confident
staleness verdict about a task that does not exist, or worse, silently mask one that does.

**Two correct predicates, one per language.**

From Python, `DataHubGraph.exists()`:

```bash
/Users/seane/.local/share/uv/tools/acryl-datahub/bin/python -c "
from datahub.ingestion.graph.client import DataHubGraph, DatahubClientConfig
g=DataHubGraph(DatahubClientConfig(server='http://localhost:8080'))
print(g.exists('urn:li:mlModel:(urn:li:dataPlatform:mlflow,TOTALLY_INVENTED_qqq999,PROD)'))  # False
print(g.exists('urn:li:dataset:(urn:li:dataPlatform:powerbi,b2fd91.datahub_order_entries.ORDER_DETAILS,PROD)'))  # True
"
```

From TypeScript there is no SDK, and for a while it looked as though the only safe option was
shelling out to Python. It is not. **`GET /openapi/v3/entity/<type>/<urn>` returns 404 for a URN
that was never written**, on the same URN that `/entities/` happily fabricates. Measured
2026-07-21 on this instance:

```bash
U='urn%3Ali%3AdataJob%3A%28urn%3Ali%3AdataFlow%3A%28obsel%2Corders_pipeline%2Cprod%29%2CTOTALLY_INVENTED_zzz404%29'

curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:8080/openapi/v3/entity/datajob/$U"
# => 404

curl -s "http://localhost:8080/entities/$U"
# => 200
# {"value":{"com.linkedin.metadata.snapshot.DataJobSnapshot":{
#   "urn":"urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),TOTALLY_INVENTED_zzz404)",
#   "aspects":[{"com.linkedin.metadata.key.DataJobKey":{
#     "jobId":"TOTALLY_INVENTED_zzz404","flow":"urn:li:dataFlow:(obsel,orders_pipeline,prod)"}}]}}}
```

Two endpoints on the same server, the same invented URN, opposite answers. The positive case works
too: a DataJob that really was registered returns 200 from the same `openapi/v3` path.

`src/server/datahub/client.ts` uses this. `readTaskEntity` treats a 404 as "no such task" and
anything else non-2xx as an error, so existence can genuinely come back false
without a Python subprocess in the request path.

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

| Invocation                 | Tools registered | Mutation tools |
| -------------------------- | ---------------- | -------------- |
| `@latest` (resolved 0.4.0) | 6                | 0              |
| `==0.6.0`                  | 21               | 11             |

**Rule for this repository:** the MCP server version is pinned everywhere, in scripts, docs, README
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

- **The entire proposals workflow**: `propose_create_glossary_term`, `propose_lifecycle_stage`,
  `list_pending_proposals`, `accept_or_reject_proposals`
- `find_sql_context`, `draft_sql_for_tables`
- `get_dataset_assertions`
- `create_glossary_term`, `create_glossary_term_version`, `add_related_terms`,
  `set_lifecycle_stage`, `list_lifecycle_stages`, `get_glossary_term_versions`

**Consequence for obsel:** there is no proposal queue to route a staleness mark through for human
review, so a mark is applied directly. It is applied as **a tag plus `customProperties`**, not
structured properties: a structured property has to be _defined_ before any value can be written to
it, no MCP tool creates a definition, and that path has never been exercised on this instance
(section 8, item 1). `customProperties` need no setup and show up in DataHub's own UI. The cost is
no typing and no per-property attribution, which obsel does not need because the cause lives inside
the value. `save_document` is available if a richer human-readable explanation ever needs to hang
off the entity.

Tool listings are also environment-dependent: `search_documents` and `grep_documents` register only
because showcase-ecommerce loaded 18 documents. Never hardcode an expected tool set; query
`tools/list` and fail loudly if a required tool is absent.

### Confirmed present, and which of them obsel actually uses

Availability and usefulness are different questions, and the first draft of this document conflated
them. What obsel calls over MCP is `add_tags` and `remove_tags`, and nothing else.

- **`add_tags` / `remove_tags`** are available, and are the only MCP tools on obsel's path.
  `src/server/datahub/mcp.ts` is the whole of it.
- **`get_lineage`** is available, but obsel does **not** traverse with it. The cascade runs on
  `GET /relationships` over GMS HTTP, for the freshness reason in section 7: the indexed lineage
  surface lagged over 90 seconds on tasks registered seconds earlier and returned an empty list
  rather than an error. obsel reasons about a swarm working right now, so it cannot use a surface
  that is blind to the newest entities.
- **`get_lineage_paths_between`** is available and is **never called**. obsel's explanation of why a
  task is stale is produced by `reasonFor()` in `src/server/coordinator/staleness.ts`, from the hop
  count and the task in between, both of which the hand-rolled walk already knows. That keeps the
  reason deterministic, testable without a network, and computed from the same graph read the
  verdict came from, because a second query could disagree with the first.
- **`update_description`** is available on Core despite a changelog note suggesting otherwise. Not
  used: obsel's marks are additive and reversible, and rewriting a human's description is neither.
- **`get_dataset_queries`** is available. Not on obsel's path, but it returns the real SQL
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
token is optional. Both the GraphQL endpoint (`:8080/api/graphql`) and the OpenAPI entity endpoints
answered without any credential during this work.

It is only a problem for a design that assumes bearer auth. To obtain a real PAT the stack must be
recreated with `METADATA_SERVICE_AUTH_ENABLED=true`, and
`DATAHUB_TOKEN_SERVICE_SIGNING_KEY`/`DATAHUB_TOKEN_SERVICE_SALT` should be set before first start so
tokens survive restarts.

---

## 5. Counting entities: use GraphQL aggregation, not the OpenAPI entity endpoint

`GET /openapi/v3/entity/{type}` paginates via `scrollId` and caps returned rows, so counting the
`entities` array understates totals and cannot support a claim of zero. Use the GraphQL aggregation
endpoint instead, and see `docs/upstream-contributions.md` §3 for the exact query and the full census.

Ingestion is also asynchronous (`ASYNC_BATCH` over Kafka): counts continue rising for minutes after
`datahub datapack load` exits successfully. Always wait for counts to stabilise before asserting
anything about graph contents.

---

## 6. Write semantics, verified by round-trip

A full round-trip was run over MCP against a real dataset: apply a tag, confirm via GraphQL, remove
it, confirm removal. **obsel has a verified write path**, since marking a task stale and clearing
that mark both work. Three constraints came out of it.

### 6.1 Writes are asynchronous; immediate read-back is unreliable

The first round-trip attempt failed at the removal step. `add_tags` succeeded and the tag was
readable, but `remove_tags` issued immediately afterwards errored and the tag survived. The
identical call, run seconds later as a separate process, succeeded:

```
add_tags     -> {"success":true,"message":"Successfully added 1 tag(s) to 1 entit(ies)"}
remove_tags  -> isError=True          (immediately after the add)
remove_tags  -> {"success":true,...}  (moments later, same arguments)
```

**Consequence for obsel.** Confirming a stale mark landed must tolerate propagation delay, so poll
with a bounded timeout rather than reading once. A single immediate read-back produces false "write
failed" verdicts, and a naive retry on that false verdict double-writes.

This also sets the honest floor on obsel's headline number. Detection is fast; the mark becoming
visible is bounded by this propagation delay. Demo and README timing claims must be measured
end-to-end, including it, and stated as a real number, never "instant".

### 6.2 obsel cannot mint new labels; it can only apply existing vocabulary

Applying a tag URN that does not already exist as an entity is rejected:

```
Error add tags: Failed to validate label with urn urn:li:tag:attest-write-probe. Urn does not exist.
```

There is no `create_tag` or `create_glossary_term` in the open-source tool surface, so **the agent
cannot invent a classification at runtime.** Any tag obsel applies must already exist, registered out
of band.

Practical consequence: obsel's own vocabulary, the stale marker and anything alongside it, is
registered once during setup, and setup must fail loudly if registration did not land. A missing tag
at runtime means staleness is detected and silently not recorded, which is the failure mode this
whole document exists to prevent.

### 6.3 Real parameter shapes

The tools take plural arrays, not a single `urn`, and the schema is strict
(`additionalProperties: false`):

```jsonc
// add_tags / remove_tags
{
  "tag_urns": ["urn:li:tag:b2fd91.PII_Data"], // required
  "entity_urns": ["urn:li:dataset:(...)"], // required
  "column_paths": ["email_address"], // optional, same length as entity_urns
}
```

`column_paths` gives **column-level tagging**, so obsel can point at the specific field that changed
rather than the whole dataset, which makes a stale mark far more useful to read. Pass `null` or an
empty string for entity-level application.

---

## 7. Lineage: the search index lags by minutes, the graph store does not

**Severity: decides obsel's core traversal. Measured 2026-07-21.**

DataHub answers "what is downstream of X" from two different places, and they do not agree on
recently written data.

| Surface                         | Backed by    | Sees data written seconds ago | Hops                        |
| ------------------------------- | ------------ | ----------------------------- | --------------------------- |
| `searchAcrossLineage` (GraphQL) | search index | **No**, lagged by minutes     | multi-hop, returns `degree` |
| `GET /relationships` (REST)     | graph store  | **Yes**, immediate            | one hop per call            |

Three agent tasks were registered, then queried immediately. `searchAcrossLineage` returned **0
results for over 90 seconds** while `/relationships` returned the edges correctly the whole time.
The same query against entities written ~15 minutes earlier returned results on the first attempt.
The index caught up during the session (0 → 6 results), confirming lag rather than failure.

The data itself was never in doubt: `graph.exists()` was true for every entity, and
`get_aspect(..., DataJobInputOutputClass)` returned the correct inputs and outputs throughout.

**Why this decides the design.** obsel coordinates a swarm that is working _right now_, so the tasks
it must reason about are always the most recently registered ones, precisely the ones the search
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
`build_revenue` at hop 1, then `write_report` and `write_docs` at hop 2, both reached transitively,
neither having ever read `clean_orders`. **Full cascade in 92 ms**, on data the index still could not
see. A visited set is carried so a cyclic graph terminates.

`searchAcrossLineage` remains useful for anything not time-sensitive, and its `degree` field is a
convenient cross-check once the index has settled.

```bash
# one hop, immediate: the predicate obsel traverses on
curl -s "http://localhost:8080/relationships?urn=<url-encoded-dataset-urn>&direction=INCOMING&types=Consumes"
```

---

## 8. Open questions, not yet resolved

These are recorded as unknown rather than guessed. Each must be settled before the code that depends
on it is written.

0. ~~**Does lineage traversal actually return agent tasks?**~~ **RESOLVED 2026-07-21: yes.** A
   `DataJob` registered with `Consumes`/`Produces` edges is returned when walking downstream from a
   dataset it reads, and the cascade is transitive. See section 7, with the important correction
   that this only holds immediately via the graph store, not the search index.
1. **Structured-property definitions must exist before values can be written**, and there is no MCP
   tool that creates one. The instance currently has only 5 `showcase.*` properties, none scoped to
   `dataJob`. The definition path, meaning YAML plus `datahub properties upsert` or the Python SDK,
   has not yet been exercised here. **obsel routed around this rather than resolving it:** a mark's
   reason is carried in `dataJobInfo.customProperties`, which need no definition. The question stays
   open because it is what a typed, attributable mark would need.
2. **Attribution on structured properties.** `upsertStructuredProperties` reportedly calls
   `removeAttribution()`, so DataHub's native attribution metadata may not survive an MCP write.
   obsel's reason and source-change data live _inside_ the property values, so this is expected to
   be tolerable, but it has not been verified.
3. **Durability across re-ingestion**, meaning whether written values survive a later ingestion run,
   is untested, and decides whether a mark from one run is still there for the next.
4. **Whether the MCP filter DSL accepts `entity_type = dataJob`.** Still unknown, and no longer on
   obsel's path: the swarm is enumerated from the flow's `IsPartOf` edges instead, which is
   immediate rather than index-backed. See section 9.
5. **Client/server version skew.** CLI `1.6.0.15` against GMS `v1.5.0.6`. Aspect rejection
   (`422 ValidationException`) is the likely failure mode when emitting `dataJobInputOutput`, and a
   rejected `(entityType, aspectName)` pair can be dropped silently, so registration must verify
   what actually landed rather than trusting a successful exit code.

---

## 9. Swarm membership is enumerable immediately, and it pages

**Measured 2026-07-21.** This section is numbered after the open questions so that the earlier
section numbers, which other files and code comments cite, keep pointing at the same content.

Section 7 established that the search index cannot see freshly registered tasks. That leaves the
question of how obsel lists the members of a swarm at all, given a `search` over `entity_type =
dataJob` would read the same lagging index. The answer needs no index: a `DataJob` carries an
`IsPartOf` edge to its `DataFlow`, and that edge is in the graph store like any other.

```bash
F='urn%3Ali%3AdataFlow%3A%28obsel%2Corders_pipeline%2Cprod%29'
curl -s "http://localhost:8080/relationships?urn=$F&direction=INCOMING&types=IsPartOf"
```

```json
{
  "start": 0,
  "count": 4,
  "relationships": [
    {
      "type": "IsPartOf",
      "entity": "urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),clean_orders)"
    },
    {
      "type": "IsPartOf",
      "entity": "urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),build_revenue)"
    },
    {
      "type": "IsPartOf",
      "entity": "urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),write_report)"
    },
    {
      "type": "IsPartOf",
      "entity": "urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),write_docs)"
    }
  ],
  "total": 4
}
```

### The paging is real and has to be followed

`start` and `count` are honoured, and `total` is the full size rather than the size of the page.
Four requests against the same four-member flow:

| Request              | Response                                                         |
| -------------------- | ---------------------------------------------------------------- |
| no paging parameters | `start 0`, `count 4`, 4 entities, `total 4`                      |
| `start=0&count=2`    | `start 0`, `count 2`, `clean_orders`, `build_revenue`, `total 4` |
| `start=2&count=2`    | `start 2`, `count 2`, `write_report`, `write_docs`, `total 4`    |
| `start=4&count=2`    | `start 4`, `count 0`, no entities, `total 4`                     |

Note that the `count` field in the response is **the number of rows on this page**, not an echo of
what was asked for, and `start=4&count=2` answers `count: 0`. Reading it as the request echo would make
a termination condition built on it never fire. Past the end is an empty list, not an error.

**Consequence for obsel.** `readSnapshot` in `src/server/datahub/client.ts` follows the pages until
`total` is covered rather than taking the first page. A truncated member list is not a smaller
answer, it is a wrong one: the tasks that fell off the page would be absent from the snapshot the
cascade walks, so a change that broke them would be reported as breaking nothing. That is the same
silent-empty failure mode as section 7, arriving by a different route.

The same applies to the `Consumes` and `Produces` hops, which come back from the same endpoint and
are paged the same way.

## 10. DataHub's UI needs a login, and its redirect throws away the path

**Measured 2026-07-23**, unlike the sections above, which were measured 2026-07-21.

The frontend at `:9002` requires the quickstart's own login. Requesting an entity page while signed
out does not send you to a sign-in page that remembers where you were going: it redirects to `/` and
the URN is gone.

```bash
# 200, and the body is the login form rather than the job
curl -s -o /dev/null -w '%{http_code} %{url_effective}\n' -L \
  'http://localhost:9002/tasks/urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),write_docs)'
```

Observed in a browser: the address bar ended at `http://localhost:9002` and the page rendered
"Welcome to DataHub" with username and password fields. Signing in from there lands on the home page,
not on the job.

The credentials are the quickstart's built-in local admin, `datahub` / `datahub`. **This is not an
account anyone registers for.** The hackathon requires no DataHub account of any kind; DataHub Cloud
is a separate hosted product obsel does not touch.

### Consequence for obsel

The details panel's `open this job in DataHub` link works for anyone whose DataHub tab is already
signed in, which is the demo's own setup, and strands a cold visitor on a login form. The panel says
so in words next to the link rather than letting it be discovered by clicking, and
the demo has DataHub signed in and parked on the lineage view already.

### The entity path, and the encoder that goes with it

Two things the link depends on, both read out of the JavaScript bundle the running instance serves
(`GET /assets/index-*.js`) rather than out of documentation:

```js
// DataHub's DataJob entity
getGraphName = () => "dataJob";
getPathName = () => "tasks";

// how it escapes a URN for that path
getEntityUrl(type, urn, params) { return `/${this.getPathName(type)}/${vR(urn)}…` }
function vR(e) { return e && e
  .replace(/%/g, "{{encoded_percent}}").replace(/\//g, "%2F")
  .replace(/\?/g, "%3F").replace(/#/g, "%23")
  .replace(/\[/g, "%5B").replace(/\]/g, "%5D") }
```

So the path is `/tasks/<urn>`, not `/dataJob/<urn>`, because `dataJob` is the graph name rather than
the route.

And **`encodeURIComponent` is the wrong function here**, which is the trap. DataHub escapes exactly
six characters and leaves `:` `(` `)` `,` raw, so a fully percent-encoded URN hands its matching
decoder `%` sequences it will transform again. A percent sign becomes the literal
`{{encoded_percent}}` rather than `%25`, which looks like a bug and is how DataHub avoids
double-decoding its own escapes.

obsel reproduces the rule in `src/features/dashboard/datahub-link.ts` so the href is byte-identical to
the one DataHub's own UI would generate. An obsel task URN happens to contain none of the six, so the
raw URN would have worked by luck; the encoder makes it correct by construction instead, and
`tests/datahub-link.test.ts` pins each case.

## 11. The graph store lags the aspect store on a new entity

**Measured 2026-07-23**, and found by an integration test rather than by inspection.

A DataJob is readable as an entity well before its `IsPartOf` edge into its DataFlow is
queryable. Against a brand-new flow, one `POST` and then two polls every 25 ms:

| Moment                                                                             | Elapsed     |
| ---------------------------------------------------------------------------------- | ----------- |
| `POST /openapi/v3/entity/datajob?async=false` returned                             | 201 ms      |
| `GET /openapi/v3/entity/datajob/<urn>` answered 200                                | 218 ms      |
| `GET /relationships?urn=<flow>&direction=INCOMING&types=IsPartOf` returned the job | **1302 ms** |

So the edge trailed the aspect by about 1.1 seconds. This is a different lag from §7:
that one is the **search index** behind the graph store, minutes wide. This one is the
**graph store** behind the aspect store, roughly a second wide, and §7's advice to prefer
`GET /relationships` does not avoid it.

Note also that the DataFlow entity itself does not have to exist for the edge to appear.
Checked directly: the flow URN answered 404 while `/relationships` already listed five
members of it. Membership is derived from the DataJob's own key, so a missing DataFlow
entity is not what makes enumeration come back empty.

### Consequence for obsel, and the bug it had

`readSnapshot` enumerates the swarm from exactly this edge, so for about a second after a
task is registered, **obsel could not see it while reporting it registered**. That is the
worst shape of failure available here: a change upstream of a task missing from the
snapshot traverses straight past it, the task is not marked, and nothing reports a
problem. An incomplete swarm is not a smaller answer, it is a wrong one.

`registerTask` in `src/server/datahub/client.ts` confirmed the entity and stopped there.
It now also polls `/relationships` until the flow lists the task, with a bounded timeout
and a named failure. `agents/graph.py`'s `register_task` has the same gap, and its comment
already names the exact risk, "so it is not in the lineage graph and a change upstream of
it would traverse straight past it", while `confirm_exists` only checks entity existence.
That path is the Python reference implementation and not what the demo runs, which posts
to obsel's own `/api/tasks/register`; it is recorded here as a known difference rather
than quietly matched.

**This could not have been found against a stand-in.** obsel had an in-memory GMS for one
commit, and it derived relationship answers from its own entity map, so its edges were
never late and this behaviour did not exist in it. The fake was deleted and the suite runs
against a real DataHub, which is what surfaced this within one run.

## 12. Two halves of DataHub fail separately, and the shallow probe cannot tell

**Measured 2026-07-24.** GMS is one process in front of two stores: a document store holding
aspects, and a search index holding the graph. Section 7 established that they disagree about
freshness and section 11 measured the lag. This section is the harder case: one of them can be
**entirely gone** while every cheap health signal stays green.

Observed after `datahub-opensearch-1` exited on its own, four hours before it was noticed:

```bash
docker ps --format '{{.Names}}\t{{.Status}}' | grep -E 'gms|opensearch'
# datahub-datahub-gms-quickstart-1   Up 3 days (healthy)
# (no opensearch row; `docker ps -a` showed: Exited (127) 4 hours ago)

curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/config
# 200

curl -s -o /dev/null -w '%{http_code}\n' \
  'http://localhost:8080/openapi/v3/entity/dataflow/urn%3Ali%3AdataFlow%3A(obsel,orders_pipeline,prod)'
# 200   <- the aspect store, still serving

curl -s 'http://localhost:8080/relationships?urn=urn%3Ali%3AdataFlow%3A%28obsel%2Corders_pipeline%2Cprod%29&direction=INCOMING&types=IsPartOf&start=0&count=200'
# 500   {"exceptionClass":"com.linkedin.restli.server.RestLiServiceException", ...
#        com.datahub.util.exception.ESQueryException: Search query failed
```

So `/config` answers, Docker reports the container healthy, entity reads by URN succeed, and
**every traversal fails**. Since traversal is the whole of obsel's reasoning (section 7), obsel
was completely blind while three separate signals said it was fine.

`docker start datahub-opensearch-1` was enough; the container reported healthy in about 20 s and
the page recovered on its next poll, roughly 3 s later. No data was lost, because the graph is
rebuilt from the aspect store rather than stored only in the index.

### The frontend is a worse version of the same trap

Section 10 records that `:9002` is the web app and will not answer GMS calls. Measured properly,
it is more dangerous than "will not answer":

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:9002/config
# 200

curl -s 'http://localhost:9002/relationships?urn=urn%3Ali%3AdataFlow%3A%28obsel%2Cx%2Cprod%29&direction=INCOMING&types=IsPartOf&start=0&count=10' | head -c 60
# <!DOCTYPE html>
# <html lang="en">
```

Both probes return **200**. An unknown path under a single-page app serves the app, so a health
check written against status codes passes twice over against a server that cannot answer a single
lineage question. Only reading the body distinguishes them.

### Consequence for obsel

A prerequisite check must exercise the call the product depends on, not a cheaper one that shares
a process with it. `checkDataHub` in `src/server/runner/preflight.ts` now asks `/config` first, to
separate "DataHub is not running" from "DataHub is running and cannot answer", and then makes the
exact `relationships()` call `readSnapshot` opens with. `relationships()` already validates the
body shape rather than the status, so the frontend's HTML fails it as an unusable response.

Both addresses are covered by `tests/live/preflight.live.test.ts` against the real servers. The
stopped-container case is not automated there, because reproducing it means stopping a container
the rest of the suite is using for the ~40 s it takes to return; it was reproduced by hand and
`docs/verification.md` records that run.

---

## 13. Lineage is recorded between datasets; the job that produced them usually is not

Measured 2026-07-26 against a live quickstart with `showcase-ecommerce` loaded, over
`GET /relationships` rather than the search-backed lineage surface (section 7).

This finding corrected a design rule before it was implemented, so it is recorded with the
correction it forced.

### The direction convention, stated because it is easy to get backwards

For `DownstreamOf` on a dataset URN:

- `direction=OUTGOING` returns that dataset's **upstreams** (the things it is downstream _of_)
- `direction=INCOMING` returns its **downstreams**

```bash
# dbt customers: 23 upstream edges (column-level, collapsing to 1 snowflake dataset), 1 downstream
curl -s ".../relationships?urn=<dbt customers>&direction=OUTGOING&types=DownstreamOf" # total 23
curl -s ".../relationships?urn=<dbt customers>&direction=INCOMING&types=DownstreamOf" # total 1
```

Edge counts are column-level and collapse to far fewer distinct datasets. Deduplicate by dataset
URN before treating a count as a fan-out.

### The finding

Walking downstream from `snowflake order_entry.customers` reaches **23 datasets over 3 hops across
5 platforms** (snowflake, dbt, powerbi, tableau, looker). The cross-platform graph is real.

**But almost nothing has a producing `DataJob`.** Across the instance, 45 of 73 datasets have none.
On the reachable set, 22 of 23 have none. Assets with zero producing jobs still carry rich upstream
lineage:

| Dataset                             | Upstream edges | Distinct upstream datasets | Producing jobs |
| ----------------------------------- | -------------- | -------------------------- | -------------- |
| `snowflake analytics.order_details` | 109            | 12                         | 0              |
| `looker view.order_details`         | 57             | 1                          | 0              |
| `powerbi ORDER_DETAILS`             | 58             | 1                          | 0              |
| `tableau f32082e5…`                 | 5              | 1                          | 0              |

The 23 `DATA_JOB` entities in the pack are all `spark` 1:1 table exports, sitting between S3 and
Snowflake. Nothing models the dbt run, the Looker view build, or the BI extract refresh.

### The correction it forced

An erasure-coverage rule that grants a derived asset coverage only when a producing `DataJob`
exists was measured at **1 of 23 coverable, 22 permanently unverifiable, 95.7%**. Rebinding the
same rule to _recorded upstream lineage_ rather than to a job entity, on the same graph, gives
**22 of 23 cross-checkable**.

Same assets, same catalog. The job entity was only ever a proxy for "something built this from
those inputs", and the lineage edges carry that directly. See `docs/erasure-coverage.md`.

### 13.1 Structured properties: definition creation and foreign-entity writes both work

Section 8 recorded this path as never exercised. It has now been exercised.

```bash
POST /openapi/v3/entity/structuredproperty?async=false   # create definition  -> 200
POST /openapi/v3/entity/dataset?async=false              # write value        -> 200
```

Both read back correctly. The write targeted a **foreign** showcase dataset obsel did not create.

**The write is additive.** After it, the target still carried all 18 of its aspects, including
`upstreamLineage` (109 edges intact), `schemaMetadata` (55 fields), `glossaryTerms` (4),
`ownership`, and `siblings`.

This matters because `updateTaskProperties` (`src/server/datahub/client.ts`) reconstructs
`dataJobInfo` from four fields and would destroy `externalUrl`, `created` and `flowUrn` on a real
entity. Writing the `structuredProperties` aspect directly does not go near that path, so it is the
safe way to mark an asset obsel does not own. Both writes were reverted afterwards and the target
was confirmed clean.

### 13.2 The evidence ledger belongs in `document`, not `dataProcessInstance`

An append-only ledger of attestations needs an entity type nothing sweeps. `dataProcessInstance` is
the wrong one and `document` is the right one.

**`dataProcessInstance` is swept by default.** DataHub's stock `datahub-gc` ingestion source ships
`dataprocess_cleanup` with `enabled: true`, `retention_days: 10`, `keep_last_n: 5`, targeting
`DataProcessInstance`. The default is a **soft** delete, and the graph index filters soft-deleted
entities out of relationship queries, so the chain does not 404 on day eleven: the edges simply stop
coming back while the aspects sit intact in storage. That is the same silent blindness section 7
exists to prevent, arriving by a different door.

**`document` is targeted by no cleanup module.** Of the six modules `datahub-gc` provides
(`truncate_indices`, `cleanup_expired_tokens`, `dataprocess_cleanup`, `execution_request_cleanup`,
`query_cleanup`, `soft_deleted_entities_cleanup`), none names `document`, including the
soft-deleted sweep, whose entity list covers twenty-three types and omits it.

**Verified writable on this instance.** The aspect shape is not obvious and a first attempt failed
validation, so the working form is recorded here:

```jsonc
{
  "urn": "urn:li:document:<id>",
  "documentInfo": {
    "value": {
      "status": { "state": "PUBLISHED" }, // required
      "contents": { "text": "..." }, // required
      "created": { "time": <ms>, "actor": "urn:li:corpuser:datahub" }, // required
      "lastModified": { "time": <ms>, "actor": "..." }, // required
      "title": "...",
      "source": { "sourceType": "EXTERNAL" },
      "customProperties": { "request": "...", "verdict": "..." }
    }
  }
}
```

`POST /openapi/v3/entity/document?async=false` returned 200 and the record read back with its
`customProperties` intact. `documentInfo` also carries `relatedAssets`, which is how an attestation
binds to the asset it is about. The probe was deleted afterwards.

### 13.3 Column-level lineage rides the same edge type as table lineage

`GET /relationships?types=DownstreamOf` does not return only datasets. On this instance,
`snowflake b2fd91.order_entry_db.analytics.order_details` answers `direction=OUTGOING` with **109
edges: 12 datasets and 97 `schemaField` URNs**, shaped like

```
urn:li:schemaField:(urn:li:dataset:(urn:li:dataPlatform:dbt,b2fd91.ORDER_ENTRY_DB.analytics.order_details,PROD),cust_first_name)
```

Column-level lineage is a genuine DataHub feature and a good one. The trap is that it arrives
unannounced down the edge type a caller asked table lineage for, and nothing in the shape of the
request suggests it will.

**Consequence for obsel, found by running it.** The erasure kernel cross-checks an attestor's
declared input set against these edges. Unfiltered, every rebuild claim on `order_details` would be
refused for failing to declare ninety-seven columns as though they were upstream tables — a page
red everywhere, for a reason that is nobody's fault and that no operator could act on. The filter
is `onlyDatasets` in `src/server/datahub/lineage.ts`, and `tests/live/lineage.live.test.ts` asserts
both halves: that the `schemaField` edges are really there, and that none of them reaches an input
set. Removing the filter fails that test by name.

**Also corrected here.** The showcase pack's dataset URNs carry a database segment that shorthand
labels elsewhere in these documents omit. The real URN is
`urn:li:dataset:(urn:li:dataPlatform:snowflake,b2fd91.order_entry_db.analytics.order_details,PROD)`,
not `…,analytics.order_details,PROD)`. A hand-typed URN of the shorter form returns `total=0` from
`/relationships` rather than an error, which reads exactly like an asset with no lineage. Section 1's
rule about fabricated existence has a sibling here: **a wrong URN on a traversal endpoint returns an
empty graph, not a 404.** Discover URNs from the graph; do not type them.

### 13.4 Writing a `document`, and why the ledger is never searched for

Two things about `document` entities that only running them revealed.

**`relatedAssets` takes `asset`, not `destinationUrn`.** A first attempt using the name every other
edge-shaped aspect uses returned a 400:

```
Failed to validate record with class com.linkedin.knowledge.DocumentInfo:
ERROR :: /relatedAssets/0/asset :: field is required but not found and has no default value
```

The field list, from the pinned SDK's `DocumentInfoClass`, is `status`, `contents`, `created`,
`lastModified`, `customProperties`, `title`, `source`, `relatedAssets`, `relatedDocuments`,
`parentDocument`, and `RelatedAssetClass` carries exactly one field, `asset`. Introspect the SDK
rather than pattern-matching from a neighbouring aspect.

**`relatedAssets` produced no traversable edge on this instance.** A probe document written with a
`relatedAssets` entry pointing at a real dataset returned nothing from `GET /relationships` in either
direction, so a ledger cannot be enumerated by walking from the asset it is about.

**Consequence: obsel's ledger is read by derived URN and never searched.** The first implementation
read it back over GraphQL `searchAcrossEntities`, and it did not work. A record written a moment
earlier was not yet indexed, so a freshly opened erasure request could not find its own opening
record and every read after it answered 404. That is section 7's warning arriving in a new place, and
it is worse here than in lineage: a coverage report that cannot see an attestation reports the asset
as unattested, which is indistinguishable from a real finding.

So `src/server/datahub/documents.ts` derives every URN from values the caller already holds —
`obsel.request.<id>`, `obsel.challenge.<nonce>`, `obsel.attestation.<request>.<assetSlug>.<n>` — and
enumerates attestations by counting up from one until a genuine 404. No search index sits anywhere in
the path that decides coverage. The sequence number is what keeps the ledger append-only: a second
attestation about one asset is a new record beside the first, never a write over it.

## 14. `mcp-server-datahub` blocks on telemetry it cannot reach, for two and a half minutes

Measured 2026-07-28. `uvx mcp-server-datahub==0.6.0` POSTs to `track.datahubproject.io` on startup,
at `/mp/engage` and then `/mp/track`. Where that host is unreachable, each POST times out after 10 s
and urllib3 retries it four times, and **the server does not answer `initialize` until all of it has
drained.** Nothing about it is obsel's, and it is invisible from the outside: the process is up, it
holds its stdio, and it is at 0% CPU the whole time.

Reproduce it directly, one JSON-RPC frame in, one variable changed between the two runs:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  | DATAHUB_GMS_URL=http://localhost:8080 uvx mcp-server-datahub==0.6.0
```

| `DATAHUB_TELEMETRY_ENABLED` | time to answer `initialize` |
| --------------------------- | --------------------------- |
| unset (the default)         | 162.5 s, at 0% CPU          |
| `false`                     | 2.5 s                       |

The stderr says what it is waiting for, and is the only place it is visible:

```
WARNING:urllib3.connectionpool:Retrying (Retry(total=3, …)) after connection broken by
'ConnectTimeoutError(…, 'Connection to track.datahubproject.io timed out. (connect timeout=10)')': /mp/engage
```

**Consequence: obsel published a measured number that was almost entirely this.** Every stale mark
obsel records goes through this client, so the cost landed on the one figure the page leads with. In
the 2026-07-28 Claude Code run, a cascade obsel decided in 105 ms was reported as **162.8 s end to
end**; with the variable set it was **1.9 s**. `pnpm test:live` paid it once per file, which turned a
266 s suite into one that had not finished a single file after fifteen minutes, and produced an
`MCP error -32001: Request timed out` against the 60 s call ceiling.

`src/server/datahub/mcp.ts` now sets `DATAHUB_TELEMETRY_ENABLED: "false"` in the subprocess
environment beside `TOOLS_IS_MUTATION_ENABLED`. It is reversible, DataHub documents the variable, and
obsel neither reads nor reports what the telemetry would have sent.

**Why this belongs here rather than in a performance note.** A timing that is dominated by a network
timeout is not a measurement of the thing being timed, and obsel's rule is that a figure is written
down only if it was measured. Every detection time recorded before 2026-07-28 was taken on a machine
that could reach that host, so those figures stand; anything measured on a machine that cannot, and
without this variable, is a measurement of the timeout.

---

## 15. The Agent Context Kit pins `acryl-datahub` away from the release obsel writes with

Measured 2026-08-09. `datahub-agent-context` is DataHub's Agent Context Kit: the same code as
`mcp-server-datahub`, published as a library so a Python agent can call the tools directly instead of
speaking MCP. obsel uses it to put a dataset's description and columns in front of a demo worker.

It pins its DataHub SDK exactly, and not to the release `agents/requirements.txt` pins:

```bash
unzip -p datahub_agent_context-1.7.0-py3-none-any.whl \
  datahub_agent_context-1.7.0.dist-info/METADATA | grep '^Requires-Dist: acryl-datahub'
# Requires-Dist: acryl-datahub[datahub-rest]==1.6.0.6
```

`agents/requirements.txt` pins `acryl-datahub==1.6.0.15`, the release `agents/graph.py`'s and
`agents/setup.py`'s writes were verified against on a live GMS. Installing the kit into `agents/.venv`
downgrades it.

**Three resolutions were tried, in separate throwaway environments so the working one was never at
risk.**

| Attempt                                       | `pip check`                      | acryl-datahub |
| --------------------------------------------- | -------------------------------- | ------------- |
| kit into the worker venv, letting the pin win | clean                            | 1.6.0.6       |
| kit with `--no-deps` alongside 1.6.0.15       | **reports the version conflict** | 1.6.0.15      |
| kit in its own venv, `agents/.venv-context`   | clean                            | 1.6.0.6       |

The first two both run. Every datahub symbol obsel imports resolves under 1.6.0.6
(`MetadataChangeProposalWrapper`, `DataHubGraph`, `DatahubClientConfig`, `DataJobInfoClass`,
`DataJobInputOutputClass`, `TagPropertiesClass`, `DataFlowInfoClass`), and the kit imports and enters
its context against 1.6.0.15.

**The resolution is the third, and the reason is what could not be measured rather than what could.**
Downgrading the worker venv replaces a pin verified against a live GMS with one that has not been,
and `pnpm test:python` cannot stand in for that check: it runs under the bare system interpreter and
never loads `agents/.venv` at all, so it would have gone green either way. A green suite would have
been evidence about nothing. The `--no-deps` variant keeps the verified pin but leaves `pip check`
permanently reporting a conflict, and `pip check` clean is the evidence `agents/requirements.txt`
already cites for `mcp==1.28.1`.

A second environment costs a directory and removes the question. The write path keeps the release it
was verified with, the kit keeps the release it pins, and neither is a claim about the other.

```bash
python3 -m venv agents/.venv-context
agents/.venv-context/bin/pip install "datahub-agent-context==1.7.0"
agents/.venv-context/bin/pip check          # No broken requirements found.
```

`agents/context.py` runs the kit in that interpreter as a subprocess and reads JSON back, so the
worker's own interpreter loads neither the kit nor acryl-datahub. That also keeps the rule
`agents/requirements.txt` states outright: a worker needs nothing beyond the standard library to talk
to the coordinator.

**Two further things the source settles, both contradicted by the kit's own docstrings.**

`DataHubContext` takes a `DataHubClient`, not a `DataHubGraph`. Several docstrings in the package show
`DataHubContext(client.graph)`, but `get_graph()` is `get_datahub_client()._graph` — handing it a
graph makes every tool fail on the attribute. `DataHubContext(DataHubClient(server=GMS_URL))` is
correct, and constructing the client contacts nothing.

**The kit does not fail fast against a DataHub that is down.** Measured 2026-08-09 on this machine
with nothing listening on 8080: a single `get_entities` call took **20.1 s** before giving up, because
acryl-datahub retries a refused connection rather than returning. A refused TCP connection is
normally instant, so the cost is entirely retry policy. Anything calling the kit in front of
user-visible work needs its own reachability check first — `agents/context.py` probes `GET /config`
with a 2 s timeout and spawns nothing when that fails, which takes the same case to 0 ms. This is the
same shape as section 14: a client library spending real time on a network it cannot reach, invisible
from the outside because the process is up and idle.

**`list_schema_fields` raises on a dataset that has no schema.** Measured 2026-08-09 against the live
stack, on `obsel_demo.clean_orders`:

```
AttributeError: 'NoneType' object has no attribute 'get'
  entities.py:211  total_fields = len(result.get("schemaMetadata", {}).get("fields", []))
```

The default in that `.get` never applies: the key is present with a null value, so `.get` is called on
`None`. Every dataset obsel registers is that shape, because obsel writes no `schemaMetadata` and no
`datasetProperties` for any of them — they appear nowhere in `src/server/` or `agents/` except in
`agents/context.py`, which reads them. The consequence is that the kit returns nothing for an
obsel-registered table however it is called, and any caller must wrap `list_schema_fields` in a
`try`/`except` rather than trusting the documented return shape.

`get_entities` on the same dataset does answer, with `urn`, `name`, `platform`, `health`, and a
`relatedDocuments` block that listed 10 of **210** obsel evidence-ledger documents. Anything reading
more of that response than a description and a field list should expect the ledger in it.

`get_entities` and `list_schema_fields` do not touch `searchAcrossLineage`; `get_lineage` does.
Section 7 is why obsel traverses with `GET /relationships`, and that ruling covers the kit: **the kit's
`get_lineage` must not be used, and `agents/context.py` says so at the top.** The two calls it does use
resolve one named URN each, and `get_entities` gates on `graph.exists()`, which section 1 endorses.

---

## 16. Native incidents are writable and confirmable on open-source DataHub; the agent registry is writable but has no UI

Measured 2026-08-09 on this machine. **The stack is no longer the `v1.5.0.6` the top of this file
names.** `GET /config` reports:

```json
{
  "versions": {
    "acryldata/datahub": {
      "version": "v1.7.0",
      "commit": "7f81ccbfe27b9acc947f5f600fcf9ddb72138a80"
    }
  },
  "datahub": { "serverEnv": "core", "serverType": "quickstart" }
}
```

Everything in this section was measured against that build, unauthenticated, exactly as section 4
describes. Nothing here has been checked on `v1.5.0.6`.

Every write below landed on scratch entities created for this measurement and on nothing else. They
are named here so a later reader can tell them apart from the demo:

| URN                                                                                        | What it is                                    |
| ------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `urn:li:dataFlow:(obsel,obsel_scratch_incident_spike,prod)`                                | scratch flow                                  |
| `urn:li:dataJob:(urn:li:dataFlow:(obsel,obsel_scratch_incident_spike,prod),probe_job)`     | scratch job                                   |
| `urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_scratch_incident_spike.probe_table,PROD)` | scratch dataset, the target                   |
| `urn:li:aiAgent:obsel-scratch-probe-20260809`                                              | scratch agent entity                          |
| `urn:li:agentSkill:obsel-scratch-skill-20260809`                                           | scratch skill entity                          |
| `urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_scratch.never_written_at_all,PROD)`       | see 16.3; created as a side effect of a raise |
| `urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_scratch.ghost_check_b,PROD)`              | see 16.3, the same thing reproduced           |

They are left in place rather than deleted, because obsel's writes are additive and reversible and a
delete of anything shared is the larger risk. All ten incidents raised during the measurement were
moved to `RESOLVED`, and all three scratch datasets read `health: PASS`.

### 16.1 `raiseIncident` works on open source, and the incident type needs no setup

```graphql
mutation r($i: RaiseIncidentInput!) {
  raiseIncident(input: $i)
}
```

```json
{
  "i": {
    "type": "OPERATIONAL",
    "title": "obsel scratch spike: upstream output changed",
    "description": "...",
    "resourceUrn": "urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_scratch_incident_spike.probe_table,PROD)",
    "startedAt": 1786325954566,
    "priority": "MEDIUM",
    "status": { "state": "ACTIVE", "stage": "TRIAGE", "message": "spike" },
    "source": { "type": "MANUAL" }
  }
}
```

It returns the new incident's URN as a bare string: `urn:li:incident:da3ddac3-74e0-4173-bda3-4e2737525b55`.

`IncidentType` is a GraphQL enum — `FRESHNESS`, `VOLUME`, `FIELD`, `SQL`, `DATA_SCHEMA`,
`OPERATIONAL`, `CUSTOM` — and `IncidentState` is `ACTIVE` or `RESOLVED`. `IncidentStage` is
`TRIAGE`, `INVESTIGATION`, `WORK_IN_PROGRESS`, `FIXED`, `NO_ACTION_REQUIRED`.

**`CUSTOM` with an arbitrary `customType` string is accepted with no prior registration.** A raise
carrying `"customType": "obsel Stale Downstream Work"`, a phrase written nowhere in DataHub before
that request, succeeded and read back with the string intact. This is the opposite of section 6.2:
a tag or glossary term has to exist before obsel can apply one, an incident type does not. Nothing
about incidents needs a setup step.

### 16.2 The read-back paths, and the two that do not lag

Four raises, each polled at 20–50 ms intervals from the instant the mutation returned:

| Read path                                  | Served from  | First correct answer                                |
| ------------------------------------------ | ------------ | --------------------------------------------------- |
| `GET /openapi/v3/entity/incident/<urn>`    | aspect store | 19, 24, 47, 48 ms — **always on the first attempt** |
| `GET /relationships?...types=IncidentOn`   | graph store  | 1587, 2477, 2583, 3423 ms                           |
| GraphQL `dataset(urn:).incidents`          | search index | 1791 ms                                             |
| GraphQL `entity(urn:) { ... on Incident }` | —            | **never; see 16.3**                                 |

The numbers in the first row are the elapsed time to complete one HTTP round trip, not a propagation
delay: the entity was already there when the first read left. `raiseIncident` itself took 112–269 ms.

This is the same split as section 11, with the same consequence for `confirmWrite`: poll the
OpenAPI v3 entity endpoint, never a relationship or a GraphQL list. The graph-store lag here
(1.6–3.4 s) is larger than the roughly one second section 11 measured for DataJob membership, so any
code that waits on the `IncidentOn` edge needs a window of several seconds and gains nothing by
waiting.

**The dataset carries its own incident summary, and that is the read worth having.** Raising an
incident writes an `incidentsSummary` aspect onto the target dataset:

```bash
curl -s 'http://localhost:8080/openapi/v3/entity/dataset/<encoded-urn>?aspects=incidentsSummary'
```

```json
{
  "incidentsSummary": {
    "value": {
      "activeIncidentDetails": [],
      "resolvedIncidentDetails": [
        {
          "urn": "urn:li:incident:da3ddac3-74e0-4173-bda3-4e2737525b55",
          "createdAt": 1786325954746,
          "resolvedAt": 1786326077589,
          "type": "OPERATIONAL",
          "priority": 2
        }
      ]
    }
  }
}
```

Active and resolved are separate arrays, each entry carrying the incident URN and both timestamps. It
is the aspect store, so it does not lag: measured over two raise-and-resolve cycles, a new incident
appeared in `activeIncidentDetails` **86 and 89 ms** after `raiseIncident` returned, and left it
**51 and 107 ms** after `updateIncidentStatus` returned. That answers "does this dataset have open
work" off one URN, with no search, no relationship traversal and no stored list of incident URNs to
keep in step.

### 16.3 Four traps

**GraphQL `entity(urn:)` cannot read an incident at all, and cannot tell you it failed.** For an
incident that genuinely exists and reads back fine over OpenAPI v3, `entity(urn:)` returns
`{"data":{"entity":null}}`. For an invented incident URN it returns exactly the same thing. The two
cases are indistinguishable. Section 1's ruling therefore extends: `entity(urn:)` fabricates datasets
(it returned a well-formed `DATASET` for
`urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_scratch.invented_never_written,PROD)`, which was
never written) and erases incidents. `GET /openapi/v3/entity/incident/<urn>` genuinely 404s for an
invented URN and 200s for a real one, which is what makes it usable.

**`raiseIncident` returns HTTP 200 when it fails.** A raise with no `resourceUrn` answers HTTP 200
with `{"errors":[{"message":"At least 1 resource urn must be defined to raise an incident.", ...}],
"data":{"raiseIncident":null}}`. A caller that checks the status code and not the body records a
success. The value of `data.raiseIncident` is the only signal that means anything.

**`raiseIncident` does not check that its target exists.** A raise against
`urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_scratch.never_written_at_all,PROD)` — a URN nothing
had ever written — succeeded and returned an incident URN. Any caller has to establish the dataset
exists itself, by section 1's rule, **before** raising, because of the next trap.

**Raising an incident on a dataset that does not exist creates that dataset.** This is the one to
watch, and it was reproduced deliberately on a second fresh URN
(`obsel_scratch.ghost_check_b`) rather than inferred from the first:

```
before raise:  GET /openapi/v3/entity/dataset/<urn>  ->  404
raiseIncident(resourceUrn: <urn>)                    ->  urn:li:incident:5ba8958a-...
+0.0 s:        GET /openapi/v3/entity/dataset/<urn>  ->  404
+0.5 s:        GET /openapi/v3/entity/dataset/<urn>  ->  200, with an incidentsSummary aspect
```

Writing `incidentsSummary` onto the target materializes the entity, so after about half a second the
URN answers 200 forever. The consequence is precise and unpleasant: **section 1's existence check
stops working for any dataset URN an incident has ever been raised against.** A typo in a URN passed
to `raiseIncident` does not fail, it creates a permanent dataset with no properties, no schema and no
lineage, which every later existence check then confirms. Establish existence first; the check is
worthless afterwards.

### 16.4 Resolving, and what resolving does not change

```graphql
mutation u($urn: String!, $i: IncidentStatusInput!) {
  updateIncidentStatus(urn: $urn, input: $i)
}
```

with `{"state":"RESOLVED","stage":"FIXED","message":"..."}` returns `true` in 57–321 ms, and the new
state reads back over OpenAPI v3 after 27–38 ms, again on the first attempt.

On an invented incident URN it fails properly: HTTP 200 with
`{"errors":[{"message":"Failed to update incident. Incident does not exist.", ...,
"extensions":{"code":404, ...}}],"data":{"updateIncidentStatus":null}}`. So the resolve path has a
real existence signal, unlike the raise path.

**Resolving does not remove the `IncidentOn` edge.** After both scratch incidents on the probe table
were resolved, `GET /relationships?urn=<dataset>&types=IncidentOn&direction=INCOMING` still returned
both. The edge records that an incident exists, not that one is open. Anything deciding whether a
dataset has open work must read each incident's `status.state` from the aspect store; enumerating the
edge and counting is wrong.

The direction convention matches the rest of this file and was checked rather than assumed:
`IncidentOn` is `OUTGOING` from the incident to the dataset and `INCOMING` on the dataset.

An `ACTIVE` incident does change `dataset.health`:

```json
{
  "health": [
    {
      "type": "INCIDENTS",
      "status": "FAIL",
      "message": "1 active incident",
      "causes": ["ACTIVE_INCIDENTS"]
    }
  ]
}
```

`health` and `dataset.incidents` are both served from the search index. After a resolve,
`incidents(state: ACTIVE)` stopped listing the incident after 1420 ms. Neither is a write
confirmation.

**What this settles for obsel.** Both mutations work on this open-source build, both are confirmable
from the aspect store within one round trip, and neither needs a setup step. The async-write rule is
satisfied: `confirmWrite` on `GET /openapi/v3/entity/incident/<urn>` for a raise, and on the target
dataset's `incidentsSummary` for either direction. The GraphQL read ban in `CLAUDE.md` is about
`searchAcrossLineage` being served from a lagging index, and every reason it gives applies here too —
`dataset(urn:).incidents` lags by 1.4–1.8 s and returns an empty list rather than an error. A
_mutation_ is a different thing: it is the only way to raise an incident at all, it returns the new
URN synchronously, and nothing about it is served from an index. Reading back over GraphQL is what
stays banned.

### 16.5 The `aiAgent` and `agentSkill` entity types exist, accept writes, and appear nowhere a person can look

`aiAgent` and `agentSkill` are both in the entity registry on `v1.7.0`. The check that distinguishes
a registered type from an unregistered one is the status code, and it is unambiguous:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  'http://localhost:8080/openapi/v3/entity/aiAgent/urn%3Ali%3AaiAgent%3Aobsel-invented-agent-0001'   # 404
curl -s 'http://localhost:8080/openapi/v3/entity/notAnEntityType/urn%3Ali%3AnotAnEntityType%3Ax'
# {"error":"Failed to find entity with name notAnEntityType in EntityRegistry"}  HTTP 400
```

A 404 means the type is registered and this URN is not there. A 400 with that message means the type
does not exist. `incident`, `aiAgent` and `agentSkill` all answer 404.

The aspects are `aiAgentInfo` (`name`, `tagline`, `description`, `instructions`, `source`, `created`,
`lastModified`), `aiAgentDependencies` (`skills`, `tools`, `models`, all arrays of URNs), and
`agentSkillInfo` (`name`, `description`, `instructions`, `sourceRepository`, `requiredTools`). The
`sourceRepository` schema's own description names the "git as source of truth" pattern and the
`agentskills.io` standard, and `instructions` is documented as the markdown body of a `SKILL.md`
minus its frontmatter.

A write of both, over `POST /openapi/v3/entity/aiAgent?async=false` and
`.../entity/agentSkill?async=false`, succeeded in 112 ms and read back on the first attempt 13 ms
later. `GET /openapi/v3/entity/aiAgent?count=10` lists it.

**There is no GraphQL surface for either type.** The GMS GraphQL schema contains no `AIAgent`,
`AgentSkill` or any type whose name includes `Agent` or `Skill`, and the `EntityType` enum — 54
values, including `INCIDENT` — has no agent or skill value. `searchAcrossEntities` for the scratch
agent's exact name returned zero results. The DataHub UI is driven by that GraphQL schema, so an
entity written here is not browsable, not searchable, and not linkable.

`aiAgentDependencies` stored the skill URN and read it back, but no relationship edge appeared for
it. `GET /relationships` from the agent returned an empty list for every name tried
(`AgentUsesSkill`, `UsesSkill`, `AdoptsSkill`, `HasSkill`, `AgentSkill`, `Uses`, `SkillOf`). The
aspect read is the only confirmed way to recover what an agent depends on; the real edge name, if
there is one, was not found within the time budget for this measurement.

**What this settles for obsel.** Registering the demo workers as `aiAgent` entities is possible and
confirmable. It is also invisible: nobody opening DataHub would see it, because the surface that
renders entities does not know these types exist. That is the fact, recorded; whether it is worth
building is a separate decision.

### 16.6 A DataJob's lineage edge does not create the dataset it points at

Measured 2026-08-09 on the same `v1.7.0` build, and recorded here because 16.3 makes it decide
something: obsel establishes a dataset exists before raising an incident on it, so whether obsel's
own writes bring a dataset into existence is the difference between raising and skipping.

They do not. `registerTask` writes `dataJobInputOutput` naming the datasets a task reads and
writes, and those edges are queryable over `GET /relationships` — but the datasets themselves are
not entities:

```
obsel_demo.clean_orders    GET /openapi/v3/entity/dataset/<urn>  ->  200
obsel_demo.side_table      GET /openapi/v3/entity/dataset/<urn>  ->  404
obsel_demo.audit_report    GET /openapi/v3/entity/dataset/<urn>  ->  404
obsel_demo.raw_orders      GET /openapi/v3/entity/dataset/<urn>  ->  404
```

`side_table` and `audit_report` are outputs of tasks registered in the integration flow, so both
have carried a `Produces` edge for weeks. The four demo tables that do answer 200 carry
`datasetProperties`, which nothing in this repository writes, so something outside obsel created
them; the point here is only that the lineage edge is not what did.

The consequence for obsel: a change to a table DataHub has no entity for is flagged on the board as
usual and raises no incident, with the skip traced. `tests/live/incidents.live.test.ts` creates its
own dataset entities for exactly this reason, and asserts the skip on a table name unique to each
run — a fixed one would be created permanently by the very regression that test exists to catch.
