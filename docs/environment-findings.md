# Environment findings

Findings measured directly against a real local DataHub, recorded because several of them contradict
the documentation and would make obsel report confident wrong answers.

These were gathered on 2026-07-21 during an earlier design for this project (an ML lineage auditor,
since abandoned — see `docs/concept.md` §8). The DataHub behavior is independent of that design and
carries over unchanged; where the original rationale was specific to the old concept, it has been
rewritten for obsel.

Every claim here was measured on this machine against GMS `v1.5.0.6` (`serverEnv: core`,
`serverType: quickstart`) with `showcase-ecommerce` loaded. Commands are given so each is
reproducible rather than asserted.

Sections 1 to 9 were measured on 2026-07-21. Sections 10 and 11 were measured on 2026-07-23 and say
so, so a reader can tell how old any given claim is rather than trusting one date for all of them.

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
staleness verdict about a task that does not exist — or, worse, silently mask one that does.

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

`src/server/datahub/client.ts` uses this — `readTaskEntity` treats a 404 as "no such task" and
anything else non-2xx as an error, so `taskExists` is a predicate that can genuinely return false
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

### Confirmed present — and which of them obsel actually uses

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
  verdict came from — a second query could disagree with the first.
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
  "tag_urns": ["urn:li:tag:b2fd91.PII_Data"], // required
  "entity_urns": ["urn:li:dataset:(...)"], // required
  "column_paths": ["email_address"], // optional, same length as entity_urns
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

| Surface                         | Backed by    | Sees data written seconds ago | Hops                        |
| ------------------------------- | ------------ | ----------------------------- | --------------------------- |
| `searchAcrossLineage` (GraphQL) | search index | **No** — lagged by minutes    | multi-hop, returns `degree` |
| `GET /relationships` (REST)     | graph store  | **Yes** — immediate           | one hop per call            |

Three agent tasks were registered, then queried immediately. `searchAcrossLineage` returned **0
results for over 90 seconds** while `/relationships` returned the edges correctly the whole time.
The same query against entities written ~15 minutes earlier returned results on the first attempt.
The index caught up during the session (0 → 6 results), confirming lag rather than failure.

The data itself was never in doubt: `graph.exists()` was true for every entity, and
`get_aspect(..., DataJobInputOutputClass)` returned the correct inputs and outputs throughout.

**Why this decides the design.** obsel coordinates a swarm that is working _right now_, so the tasks
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
   not yet been exercised here. **obsel routed around this rather than resolving it:** a mark's
   reason is carried in `dataJobInfo.customProperties`, which need no definition. The question stays
   open because it is what a typed, attributable mark would need.
2. **Attribution on structured properties.** `upsertStructuredProperties` reportedly calls
   `removeAttribution()`, so DataHub's native attribution metadata may not survive an MCP write.
   obsel's reason and source-change data live _inside_ the property values, so this is expected to
   be tolerable, but it has not been verified.
3. **Durability across re-ingestion** — whether written values survive a later ingestion run — is
   untested, and decides whether a mark from one run is still there for the next.
4. **Whether the MCP filter DSL accepts `entity_type = dataJob`.** Still unknown, and no longer on
   obsel's path: the swarm is enumerated from the flow's `IsPartOf` edges instead, which is
   immediate rather than index-backed. See section 9.
5. **Client/server version skew.** CLI `1.6.0.15` against GMS `v1.5.0.6`. Aspect rejection
   (`422 ValidationException`) is the likely failure mode when emitting `dataJobInputOutput`, and a
   rejected `(entityType, aspectName)` pair can be dropped silently — so registration must verify
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
what was asked for — `start=4&count=2` answers `count: 0`. Reading it as the request echo would make
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

So the path is `/tasks/<urn>`, not `/dataJob/<urn>` — `dataJob` is the graph name, not the route.

And **`encodeURIComponent` is the wrong function here**, which is the trap. DataHub escapes exactly
six characters and leaves `:` `(` `)` `,` raw, so a fully percent-encoded URN hands its matching
decoder `%` sequences it will transform again. A percent sign becomes the literal
`{{encoded_percent}}` rather than `%25`, which looks like a bug and is how DataHub avoids
double-decoding its own escapes.

obsel reproduces the rule in `src/features/cockpit/datahub-link.ts` so the href is byte-identical to
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
and a named failure. `agents/graph.py`'s `register_task` has the same gap — its comment
already names the exact risk, "so it is not in the lineage graph and a change upstream of
it would traverse straight past it", while `confirm_exists` only checks entity existence.
That path is the Python reference implementation and not what the demo runs, which posts
to obsel's own `/api/tasks/register`; it is recorded here as a known difference rather
than quietly matched.

**This could not have been found against a stand-in.** obsel had an in-memory GMS for one
commit, and it derived relationship answers from its own entity map, so its edges were
never late and this behaviour did not exist in it. The fake was deleted and the suite runs
against a real DataHub, which is what surfaced this within one run.
