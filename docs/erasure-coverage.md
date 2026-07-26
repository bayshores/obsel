# Erasure coverage: the rule, and what it survives

This is the specification obsel's erasure kernel implements, written before the code because two
earlier attempts at this rule were unsound and both were caught only after being written down as
prose. Every case in the table below is walked by hand here and becomes a named test in
`tests/erasure.test.ts`.

## Why there is a third draft

**Draft 1.** _"A byte-identical rebuild proves the erased rows contributed nothing."_ Killed by
collision: Alice contributes 10, others 90, total 100. Alice is erased, an unrelated 10 arrives,
total is 100 again. Identical bytes, and Alice contributed.

**Draft 2.** _"If every declared input was proven clean, the output is clean."_ Killed twice. First
by MERGE semantics, where the real transformation is `out = merge(prior_version(out), f(inputs))`
and the prior version is a hidden input carrying the subject that no catalog records as an edge.
Second, and worse, by measurement: every analytics aggregate in `showcase-ecommerce` has **zero**
producing DataJobs, verified live with `GET /relationships?types=Produces&direction=INCOMING`
returning `total=0`. A universal quantifier over an empty input set is vacuously true, so the rule
certified a table having examined nothing.

Both drafts made the same mistake one level apart: **they tried to establish a property of a
table's contents using only the graph of how tables connect.** No property of the edges witnesses
absence in the node. The graph can _propagate_ a conclusion. It can never _establish_ one.

## What obsel claims, and what it does not

obsel **derives the causal chain** deterministically from graph structure, with no attestor in the
loop, and **verifies attestations about absence**, each one local, signed, and scoped to one asset at
one version. Composing independently signed local claims into a global picture no single attestor is
positioned to assert is the contribution.

obsel never reads warehouse data. It holds no warehouse credentials. It therefore cannot and does
not prove absence. It records who attested what, over which version, under which predicate, and it
is loud about everything nobody attested to.

| Never say    | Say                                          |
| ------------ | -------------------------------------------- |
| proven clean | attested absent over version V by attestor A |
| proof        | evidence, attestation                        |
| complete     | N of M assets covered, K unattested          |

## The rule

For an erasure request `R`, a subject identifier set `K`, and an asset `A` at version `V`:

`State(R, A, V) ∈ { ATTESTED, UNPROVEN, CONTRADICTED }`

**The default is `UNPROVEN`.** State is computed as a _least_ fixpoint: begin with nothing attested
and promote only on evidence. Never begin with an assumption of cleanliness and look for
contradictions, which is what admits the self-certifying cycle in case 5.

`ATTESTED(R, A, V)` holds if and only if `residue(R, A, V) = ∅`.

`residue` is the portion of `V` not covered by an **explanation**. An explanation is one of:

**Direct check.** An attestation `D` where all of the following hold:

- `D.request = R` and `D.asset = A`
- `D.version = V` exactly, not a predecessor
- `D.predicate` covers the whole of `K`
- `D.scope` is the whole of `V`, not a partition or filtered subset
- `D.result = absent`

**Derived coverage.** A rebuild attestation `P` where all of the following hold:

- `P` solely produced version `V` of `A`. Not "was one of the producers of".
- **TOTAL**: `P` rewrote the entirety of `A`. Not a merge, not an append, not a partition overwrite.
- **CLOSED**: `P` declares its complete input set, and that set **matches the upstream lineage
  DataHub records for `A`**. A declared set narrower than the recorded lineage is a detectable
  inconsistency and is refused. An empty recorded lineage means there is nothing to cross-check
  against, so no rebuild attestation can be accepted for `A`.
- **ATTRIBUTED**: bound to an identified attestor with a valid signature over defined bytes.
- every input `I ∈ P.inputs` satisfies `ATTESTED(R, I, P.input_version[I])`.

**Coverage binds to recorded lineage, not to a `DataJob` entity.** This is a correction forced by
Phase 0b measurement, recorded in full below. An earlier form of this rule required a producing
`DataJob`, which fails on real catalogs: DataHub records dataset-to-dataset lineage richly and
rarely records the job. `snowflake analytics.order_details` has **109 upstream edges resolving to 12
distinct upstream datasets and zero producing jobs**. The job was only ever a proxy for "something
built this from those inputs", and the lineage edges carry that directly.

The cross-check is what makes this stronger than draft 2 rather than weaker. Draft 2 took the input
set from whatever the catalog happened to record and quantified over it, so an empty set was
vacuously satisfied. Here the input set is declared by the attestor and **verified against an
independent source**, so under-declaring to dodge an unclean upstream is detectable.

`CONTRADICTED` when any valid attestation reports the subject present.

**Version identity is not fingerprint identity.** A version is a warehouse-native commit identifier
(Iceberg snapshot id, Delta commit version, table revision), never a content hash. Two versions with
identical bytes are still two versions. This is what makes case 7 come out right, and it inverts
`CLAUDE.md`'s first correctness rule for this kernel only — see "The inverted write rule" below.

## The inverted write rule

`CLAUDE.md` rule 1 says a task that re-runs and produces the same output must not mark anything
stale, and `compareFingerprints` ([staleness.ts:45](../src/server/coordinator/staleness.ts#L45))
returns `null` on identical content so no change is emitted.

**For erasure this is inverted.** Any write to an asset carrying an open obligation reopens it,
whether or not the fingerprint changed. An attestation is bound to a version; a new version has no
attestation regardless of its bytes.

This inversion is written down here because it looks like a bug to anyone who knows the staleness
rule, and the next reader will otherwise "fix" it back into unsoundness.

## The default flip

[staleness.ts:492](../src/server/coordinator/staleness.ts#L492) and
[staleness.ts:556](../src/server/coordinator/staleness.ts#L556) both `return true` for an input with
no known producer, described in the code as "supplied from outside the swarm", and
`tests/staleness.test.ts:711` locks that in as "treats a dataset nothing in the swarm produces as
stable ground".

That is correct for staleness: with no recorded claim about a dataset, there is nothing to
contradict. It is catastrophic for erasure, where it converts absence of information into an
affirmative certificate. **The erasure kernel gets its own default and must never import that one.**

## The counterexample table, walked

| #   | Case                                                     | Required     | Rule gives   | Why                                                                   |
| --- | -------------------------------------------------------- | ------------ | ------------ | --------------------------------------------------------------------- |
| 1   | MERGE / dbt incremental over prior version               | UNPROVEN     | UNPROVEN     | not TOTAL; prior version is an unexplained portion of `V`             |
| 2   | Partition overwrite, 3 of 730                            | UNPROVEN     | UNPROVEN     | not TOTAL; residue = 727 partitions                                   |
| 3   | SCD2 snapshot                                            | UNPROVEN     | UNPROVEN     | not TOTAL, it appends; retention is its correct behaviour             |
| 4   | Asset with no attestation of any kind                    | UNPROVEN     | UNPROVEN     | no explanation exists, so residue is all of `V`                       |
| 4b  | Asset with no recorded upstream lineage, rebuild claimed | UNPROVEN     | UNPROVEN     | nothing to cross-check CLOSED against, so the claim is refused        |
| 5   | Cyclic lineage A→B→A                                     | UNPROVEN     | UNPROVEN     | least fixpoint never promotes either without a grounding direct check |
| 6   | Two writers, one clean run                               | UNPROVEN     | UNPROVEN     | no single `P` solely produced `V`, so no `P` is TOTAL w.r.t. `V`      |
| 7   | Unproven write, identical fingerprint                    | reopens      | reopens      | attestation binds to the old version; the new version has none        |
| 8   | Full rebuild: total, closed, attributed, inputs attested | ATTESTED     | ATTESTED     | derived coverage satisfied                                            |
| 9   | Direct check against current version                     | ATTESTED     | ATTESTED     | direct explanation covers all of `V`                                  |
| 10  | Attestation reports subject present                      | CONTRADICTED | CONTRADICTED | by definition                                                         |

### Cases 1 and 2 in detail

Both reduce to TOTAL. The residue concept gives graded output for free: case 2 reports "3 of 730
partitions covered, 727 unexplained" rather than a bare red, which is more useful to an operator and
costs nothing extra.

### Case 5 in detail

Under a _greatest_ fixpoint, B is attested because A was and A is attested because B was, with no
direct check anywhere. A memoised traversal with a visited set that returns "attested" on revisit
computes exactly this, and a visited set is the repo's existing termination idiom
([staleness.ts:304](../src/server/coordinator/staleness.ts#L304)). The least-fixpoint requirement
above exists specifically to forbid it. On revisit the kernel must return the current value, which
starts at `UNPROVEN`, never a provisional `ATTESTED`.

### Case 6 in detail

If `P1` truly rewrote the whole of `A` after `P2`'s last write, then `P2`'s rows are not in `V` and
`V` is explained. If both contributed to `V`, then no single run rewrote all of it and TOTAL fails.
The two-writer problem therefore falls out of totality, provided "produced the current version" is
read as _solely_ produced. This is also why the plan's Phase 1 fixes the existing producer-collapse
defect, where [staleness.ts:320](../src/server/coordinator/staleness.ts#L320) takes the last writer
and `engine.ts:324` takes the first.

### Snapshot isolation, not in the required table but worth recording

A proof adapter opens a session at 02:58 and, under snapshot isolation, pins snapshot `S7` for its
lifetime. It counts zero and signs `version = S7`. A backfill commits `S8` at 03:00 reintroducing 12
rows. The adapter's evidence arrives at 03:05.

The attestation for `S7` stands and is correct: `S7` really was clean. But the asset's current
version is `S8`, which has no explanation, so `State(R, A, S8) = UNPROVEN`. Version-keyed state gets
this right without a special case, and it is the reason state is keyed to a version rather than to an
asset.

## What the rule does not catch, stated rather than hidden

**Undeclared inputs.** CLOSED is asserted by the attestor, not verified by obsel. A min-max scaler
fitted on the subject's largest purchase, a lookup cache, a seed file, or a warm-started model
checkpoint are all inputs no `Consumes` edge records. The rule accepts a run as closed because the
attestor said so. This does not make the rule sound against that case; it makes the failure
**attributable**, because the closure assertion is signed and recorded. Attribution is the honest
ceiling here, not detection.

**Logical absence, not physical.** A direct check certifies what the query interface returns. On a
Delta table with deletion vectors, `DELETE` marks rows in an auxiliary file without rewriting the
Parquet, so the count is zero while the bytes remain on disk. Backups, WAL, and time-travel
snapshots are the same class. Physical erasure is a separate obligation and obsel does not speak to
it.

**Subject-identifier resolution.** Everything downstream of resolving a person into concrete key
values is unsigned and unverifiable by obsel. If the organization resolves the subject to one
`customer_id` while guest-checkout rows sit under an email hash, every subsequent attestation is
structurally valid and wrong, and their completeness is what makes them persuasive. The attestation
record therefore carries the **identifier set, the executed predicate, and the columns searched**, so
that two attestors answering different questions can at least be detected. Recording the question is
the only defence available to a system that cannot ask it itself.

**Differencing.** A total, honest, correctly attested rebuild can still leave the subject
recoverable by comparing published aggregates across time. This sits outside the tool entirely.

**Coverage is over the lineage DataHub records, as of a stated graph snapshot.** An uncatalogued
export, spreadsheet, or shadow pipeline is invisible. Missing lineage is reported as an assurance
gap rather than silently treated as absence of risk.

## Phase 0b: the coverage measurement that corrected the rule

Measured 2026-07-26 against a live `datahub docker quickstart` with `showcase-ecommerce` loaded,
using `GET /relationships` over the graph store rather than the search-backed lineage surface, for
the freshness reason in `environment-findings.md` §7.

**Graph shape.** Walking downstream from `snowflake order_entry.customers`, a PII-bearing source
table, reaches **23 datasets over 3 hops across 5 platforms**: snowflake → dbt →
powerbi / tableau / looker. The cross-platform lineage is real and rich, which is the thing worth
demonstrating.

**The first census said the product was unusable.** Classifying by "does a producing `DataJob`
exist", the answer was 1 of 23 coverable and **22 of 23 permanently red, 95.7%**. Across the whole
instance, 45 of 73 datasets have no producing job.

**The second census, after binding coverage to recorded lineage instead, said the opposite:**

| Classification                              | Count | Share |
| ------------------------------------------- | ----- | ----- |
| Cross-checkable (upstream lineage recorded) | 22    | 95.7% |
| Source table, direct check                  | 1     | 4.3%  |
| Unattestable                                | 0     | 0%    |

Same graph, same assets. The difference is entirely which artifact the rule binds to. Assets with
zero producing jobs carry 58, 57, 5 and 109 upstream edges respectively, so the evidence for
cross-checking a rebuild claim was there the whole time; the rule was looking for the wrong thing.

This is the measurement earning its place: the rule as written on paper in the morning would have
produced a board that was 96% red on DataHub's own showcase catalog, and no amount of engineering
downstream would have fixed it.

**A caveat that must travel with these numbers.** "Cross-checkable" means an attestation _could_ be
verified against recorded lineage. It does not mean an owner exists who will produce one. The share
of assets with a willing, capable attestor is not measured here and cannot be measured from a
catalog alone.

**Also recorded:** the instance currently carries 52 `urn:li:tag:obsel-stale` tags and 51 DataJobs
in a `review_probe` flow, left by an audit agent earlier in this work. They are isolated from
`orders_pipeline` and do not affect these counts, which are dataset-scoped.

## Result of Phase 0

All ten required cases come out right on paper, the snapshot-isolation case comes out right without
a special rule, and Phase 0b corrected the derived-coverage branch from an artifact that barely
exists in real catalogs to one that is present on 96% of the reachable graph.

Three classes are not caught, and each is recorded above with its reason and mitigation rather than
left for a reviewer to find.

The rule is sound enough to build. It is not a proof of erasure and this document does not claim to
be one.
