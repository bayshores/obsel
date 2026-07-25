# Where the committed seed tables came from

The scale swarm starts from two committed JSON files in this directory. Both are
derived from public NYC Taxi and Limousine Commission data by
[`extract_taxi.py`](extract_taxi.py), run once on 2026-07-24. A judge running the
demo needs only the committed files; the 64 MB source is never downloaded at
demo time.

## Sources

| File                              | URL                                                                             | sha256                                                             |
| --------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `yellow_tripdata_2026-01.parquet` | https://d37ci6vzurychx.cloudfront.net/trip-data/yellow_tripdata_2026-01.parquet | `8b3933fe6f0d7b6d8826613c0dd724edc680ff7c49e2bd4c7635c05102728637` |
| `taxi+_zone_lookup.csv`           | https://d37ci6vzurychx.cloudfront.net/misc/taxi+_zone_lookup.csv                | `1a99e105092230f8620f301edcca7f80d3080642ff404d28ed957d3fa222c8ed` |

Trip records are published by the NYC TLC under their open data terms. The
attribution entry lives in `THIRD_PARTY_NOTICES.md` at the repository root.

## Derivation, in full

`extract_taxi.py` holds the rules; the short version: rows are read in file
order, and the first 300 qualifying rows of each day from 2026-01-05 through
2026-01-11 (one full Monday-to-Sunday week) are kept. A row qualifies when its
passenger count, trip distance, fare and total are all positive, both zone ids
are present, and the payment type is one of the four real codes. No sampling
and no randomness anywhere, so the same source bytes always produce the same
extract. Values are written as parsed; cleaning is the agents' job, not this
script's.

## Outputs

| File             | Rows                       | sha256                                                             |
| ---------------- | -------------------------- | ------------------------------------------------------------------ |
| `raw_trips.json` | 2100 (300 per day, 7 days) | `069e0b07b85d8d9899bca94bf0e62c4469169c3d9a59791b61c6c5127a0a7eec` |
| `raw_zones.json` | 265                        | `c9dc0caa7e7076b3620ee3d1702a237841b99d31854fbf3daf0fe6d7cae939bf` |

The same two output hashes are pinned as constants in `agents/scale.py`, and its
self-check recomputes them from the committed bytes, so an edited seed fails
`pnpm verify` rather than quietly shifting every fingerprint downstream.

To re-derive: download both sources, confirm their hashes above, then

```bash
python agents/seeds/extract_taxi.py yellow_tripdata_2026-01.parquet taxi+_zone_lookup.csv agents/seeds
```

using any environment with `pyarrow` installed. The agents' own environment
deliberately does not carry it.
