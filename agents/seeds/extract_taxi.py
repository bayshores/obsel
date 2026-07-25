"""Build-time derivation of the scale swarm's two seed tables. Not agent code.

Turns one month of the public NYC TLC yellow-taxi trip records into the small,
committed, byte-stable extract the scale demo starts from. Run once by a person,
never by an agent, and never at demo time: the demo reads the committed JSON,
so a judge needs neither this script nor the 64 MB source file.

    python agents/seeds/extract_taxi.py <trips.parquet> <zones.csv> <out_dir>

Everything about the derivation is fixed so the output is reproducible from the
same source bytes:

- Rows are considered in file order, and the FIRST `ROWS_PER_DAY` qualifying
  rows of each day in the window are kept. No sampling, no randomness. The
  per-day quota exists because the source file is roughly chronological and one
  day of yellow-taxi data fills any flat quota on its own; a first cut of this
  script did exactly that and produced a "week" that was entirely Monday.
- A row qualifies when its pickup falls inside `WINDOW` (one full Monday-to-
  Sunday week), its passenger count, distance, fare and total are all positive,
  both zone ids are present, and the payment type is one of the four real ones.
- Values are written as parsed. The cleaning agents, not this script, decide
  about form; the seed's job is to be genuinely raw and genuinely stable.

The source file and its sha256 are recorded in PROVENANCE.md beside the output,
and `pnpm test:python` re-checks the committed extract's own hash, so a quiet
edit to the seed cannot survive verification.

Requires pyarrow, which the agents' environment deliberately does not carry.
Use a throwaway environment: this is a build tool, not a dependency.
"""

from __future__ import annotations

import csv
import hashlib
import json
import sys
from datetime import date, datetime
from pathlib import Path

# One full Monday-to-Sunday week, so the daily and weekday aggregations have a
# natural frame with every weekday present exactly once.
WINDOW = (date(2026, 1, 5), date(2026, 1, 11))

ROWS_PER_DAY = 300

# The TLC dictionary's real payment codes: 1 credit card, 2 cash, 3 no charge,
# 4 dispute. 0, 5 and 6 exist in the data as unknown/voided and are excluded.
PAYMENT_TYPES = {1, 2, 3, 4}

TRIP_COLUMNS = [
    "trip_id",
    "pickup_datetime",
    "dropoff_datetime",
    "passenger_count",
    "trip_distance",
    "fare_amount",
    "tip_amount",
    "total_amount",
    "payment_type",
    "pickup_zone_id",
    "dropoff_zone_id",
]

ZONE_COLUMNS = ["zone_id", "zone_name", "borough", "service_zone"]


def extract_trips(parquet_path: Path) -> dict:
    import pyarrow.parquet as pq

    table = pq.read_table(
        parquet_path,
        columns=[
            "tpep_pickup_datetime",
            "tpep_dropoff_datetime",
            "passenger_count",
            "trip_distance",
            "fare_amount",
            "tip_amount",
            "total_amount",
            "payment_type",
            "PULocationID",
            "DOLocationID",
        ],
    )
    rows: list[dict] = []
    start, end = WINDOW
    day_count = (end - start).days + 1
    per_day: dict[str, int] = {}

    for batch in table.to_batches():
        records = batch.to_pylist()
        for record in records:
            pickup: datetime | None = record["tpep_pickup_datetime"]
            dropoff: datetime | None = record["tpep_dropoff_datetime"]
            if pickup is None or dropoff is None:
                continue
            if not (start <= pickup.date() <= end):
                continue
            day = pickup.date().isoformat()
            if per_day.get(day, 0) >= ROWS_PER_DAY:
                continue

            passengers = record["passenger_count"]
            distance = record["trip_distance"]
            fare = record["fare_amount"]
            tip = record["tip_amount"]
            total = record["total_amount"]
            payment = record["payment_type"]
            pickup_zone = record["PULocationID"]
            dropoff_zone = record["DOLocationID"]

            if passengers is None or int(passengers) <= 0:
                continue
            if distance is None or float(distance) <= 0:
                continue
            if fare is None or float(fare) <= 0:
                continue
            if total is None or float(total) <= 0:
                continue
            if tip is None:
                continue
            if pickup_zone is None or dropoff_zone is None:
                continue
            if payment is None or int(payment) not in PAYMENT_TYPES:
                continue

            per_day[day] = per_day.get(day, 0) + 1
            rows.append(
                {
                    "trip_id": len(rows) + 1,
                    "pickup_datetime": pickup.isoformat(),
                    "dropoff_datetime": dropoff.isoformat(),
                    "passenger_count": int(passengers),
                    "trip_distance": float(distance),
                    "fare_amount": float(fare),
                    "tip_amount": float(tip),
                    "total_amount": float(total),
                    "payment_type": int(payment),
                    "pickup_zone_id": int(pickup_zone),
                    "dropoff_zone_id": int(dropoff_zone),
                }
            )
            if len(per_day) == day_count and all(
                count >= ROWS_PER_DAY for count in per_day.values()
            ):
                return {"columns": list(TRIP_COLUMNS), "rows": rows}

    raise SystemExit(
        f"the window is short: {per_day} qualifying rows per day in "
        f"{parquet_path.name}; wanted {ROWS_PER_DAY} on each of {day_count} days."
    )


def extract_zones(csv_path: Path) -> dict:
    rows: list[dict] = []
    with csv_path.open(newline="", encoding="utf-8") as handle:
        for record in csv.DictReader(handle):
            zone_id = record.get("LocationID")
            if zone_id is None or not zone_id.strip().isdigit():
                continue
            rows.append(
                {
                    "zone_id": int(zone_id),
                    # As published, untouched. The zone cleaner's whole job is
                    # deciding what to do about these strings.
                    "zone_name": record.get("Zone") or "",
                    "borough": record.get("Borough") or "",
                    "service_zone": record.get("service_zone") or "",
                }
            )
    if not rows:
        raise SystemExit(f"no zone rows parsed from {csv_path.name}")
    return {"columns": list(ZONE_COLUMNS), "rows": rows}


def write_table(table: dict, path: Path) -> str:
    # Minified plus one trailing newline: byte-stable, and small enough to
    # commit. The seeds directory is excluded from Prettier, which would
    # otherwise reflow a two-thousand-row file into a diff nobody can read.
    text = json.dumps(table, separators=(",", ":"), ensure_ascii=False) + "\n"
    path.write_text(text, encoding="utf-8")
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__)
        return 2
    parquet_path, zones_path, out_dir = (Path(argument) for argument in sys.argv[1:])
    out_dir.mkdir(parents=True, exist_ok=True)

    source_hashes = {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in (parquet_path, zones_path)
    }

    trips = extract_trips(parquet_path)
    zones = extract_zones(zones_path)

    trips_hash = write_table(trips, out_dir / "raw_trips.json")
    zones_hash = write_table(zones, out_dir / "raw_zones.json")

    print(f"raw_trips.json  {len(trips['rows'])} rows  sha256 {trips_hash}")
    print(f"raw_zones.json  {len(zones['rows'])} rows  sha256 {zones_hash}")
    for name, digest in source_hashes.items():
        print(f"source {name}  sha256 {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
