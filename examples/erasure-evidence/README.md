# One erasure request's evidence, captured off a real run

`bundle.json` is what `GET /api/erasure/<id>/evidence` returned for one request against a live
DataHub. Check it without starting anything:

```
node scripts/verify-erasure-evidence.mjs examples/erasure-evidence/bundle.json
```

Exit 0 means every signature in the file verified against the registry in the file, and the coverage
answer obsel recorded is the one the evidence supports. Change any byte of any envelope, any key
status, or any lineage edge, and it exits 1 naming the record and what failed. Node 24 or newer, no
install step, no network.

Without a checkout, the same check runs in a browser at
[bayshores.github.io/obsel](https://bayshores.github.io/obsel/), over this same file, with buttons
that make those edits for you. `docs/verification.md` records what that page substitutes and what
holds the two to the same answers.

## What this capture is

|              |                                                                               |
| ------------ | ----------------------------------------------------------------------------- |
| Request      | `dsr-20260810-erasure-evidence`                                               |
| Opened       | `2026-08-10T01:49:57.091Z`                                                    |
| Captured     | `2026-08-10T01:50:03.302Z`                                                    |
| Seed         | `snowflake … order_entry.customers`, walked 2 hops                            |
| Reached      | 18 assets across five platforms: snowflake, dbt, looker, powerbi, tableau     |
| Attestations | 2, both by `warehouse-adapter@order-entry` on key `warehouse-adapter-2026-08` |
| Answer       | **2 of 18 assets covered, 16 unattested, 0 contradicted**                     |

The two attestations are deliberately of different kinds, because they are checked by different
halves of the rule:

- a **direct** attestation over `snowflake … customers` at version `snapshot-20260810-1`, whole
  table, reporting the subject absent;
- a **rebuild** attestation over `dbt … customers` at version `dbt-run-20260810`, declaring a full
  rewrite by a sole producer from exactly one input, the snowflake table at the version above.

The second is covered only because the first is. Delete the first attestation from the file and both
assets fall to unattested — the second has nothing left to inherit from, and the verifier's least
fixpoint never promotes it.

The other 16 assets are what obsel exists to report. Nobody has spoken for them, so they read
`UNPROVEN` and their versions read `unknown`, because a version is warehouse-native and obsel does
not invent one.

## What is real in here, and what is not

**Real.** The signatures are Ed25519 over DSSE Pre-Authentication Encoding, made by a keypair
generated during that run. The challenges are the ones obsel issued, with the nonces and the
fifteen-minute windows it minted. The 18 assets and every lineage edge in `upstreamOf` came out of
DataHub's `GET /relationships` on the `showcase-ecommerce` sample catalog. The `report` block is
obsel's own answer, returned by the same server in the same call.

**Not real.** The subject is invented: `cust_88213` is nobody, and the versions
(`snapshot-20260810-1`, `dbt-run-20260810`) are strings the run made up, because obsel holds no
warehouse credentials and nothing here read a warehouse. An attestation says a named operator looked
and reported; in this capture nobody looked, and what is being demonstrated is the accounting around
such a claim rather than the claim.

**Gone for good.** The private key existed only inside the capturing process and was never written
anywhere. So these signatures cannot be re-minted, by anyone, including the person who made them.

## Where the subject's identifiers went

`request.identifiers` is not in the bundle. In its place is `identifierDigests`, the SHA-256 of each
identifier — which is everything the coverage rule needs, since it asks only whether each identifier
the request covers was among those searched for, and set membership survives digesting.

**One copy could not be removed.** A direct attestation's `predicate` records the query the attestor
executed, identifiers included, and those bytes are inside what was signed. Removing them destroys
the signature the file exists to have checked. So a bundle is evidence handed to a named recipient
rather than something to publish, which is why the route that serves it requires the API token while
the coverage report beside it does not.

That is also why the subject here is invented. A capture from a real request would carry a real
person's key values in `predicate.identifiers`, and this directory is public.

## The format

`formatVersion: 1`. Fields:

| Field          | What it is                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `request`      | The request, minus identifiers, plus their digests                                                 |
| `reachable`    | Every asset the lineage walk found, sorted                                                         |
| `upstreamOf`   | DataHub's recorded upstream edges per asset — what a rebuild's declared inputs are checked against |
| `keys`         | The attestor registry, public material only                                                        |
| `challenges`   | Every challenge answered by a record below, as it was issued                                       |
| `attestations` | The ledger records: `{asset, sequence, at, body: {envelope, keyId, nonce}}`                        |
| `report`       | obsel's own answer, for the verifier to disagree with                                              |

`report` is the claim, not an input. The verifier recomputes coverage from the fields above it and
then compares, so an edit that changes what the evidence supports is reported as a disagreement
rather than absorbed.

## What the verifier does not establish

It re-runs obsel's own `attestation.ts` and `erasure.ts` over the bytes, so it checks that the
signatures hold, that each record answered a challenge obsel issued inside that challenge's window,
that no nonce was used twice, that each attestor was in scope for the asset it spoke for, and that
the coverage answer follows.

It cannot establish that anybody actually looked in a table. obsel holds no warehouse credentials
and reads no warehouse data; an attestation is a signed claim by a named party, and what obsel adds
is that the claim is attributable, scoped, bound to a version, and revocable. The verifier prints
that limit under every run rather than leaving it here.
