"""The scale swarm: forty agent tasks over one week of real NYC taxi trips.

Data only, like `pipeline.py`: importing this module reads nothing, writes
nothing, and calls no model. The runner in `run.py` executes it, the same way it
executes the four-agent demo, and both swarms hang off the same DataFlow, so the
board shows whichever one is registered.

This said "Reset, then register the other, to switch" until 2026-07-28, and that
was wrong in a way worth recording: `reset` puts every task back to registered
and removes its tags, and deletes nothing. Nothing in obsel deletes a DataJob.
So registering the other swarm onto a board that already holds one gives a board
holding both, and the way to a board with only this swarm on it is a different
DataFlow: set `OBSEL_FLOW_ID` and start obsel again. The board's own header says
so, under the flow name.

The shape, by layer:

    seeds      raw_trips, raw_zones          committed extracts, see seeds/PROVENANCE.md
    clean      clean_trips, clean_zones
    enrich     label_trips                   joins trips to zone names and boroughs
    marts      daily_trips, payment_mix, hourly_profile, trip_lengths
    boroughs   five marts, five weekly rollups, one five-way city summary
    rollups    city_week, fare_summary, tips_by_payment, revenue_overview
    movement   cross_borough, zone_leaders, movement_summary
    riders     weekday_profile, rider_overview
    airport    airport_trips, airport_daily, airport_week
    leaves     four reports, four docs tables

Forty tasks, diamonds and six-way fan-ins included, every one a real Codex
session at run time.

The change the scale demo makes lands on `daily_trips`: its passenger column is
renamed `riders` to `passenger_total`. Nine downstream tasks descend from that
table, out to three hops; the other thirty tasks descend from other ground and
stand. That ratio is the demonstration: at this size nobody can eyeball what a
change reaches, and obsel names the exact nine.

Instructions are built from templates, one per kind of work, each pinning what
live runs have proven cannot be left to a model's judgment: exact output
columns in order, two decimal places on money, four on shares, explicit sort
orders, explicit tie-breaks. Tasks that read `daily_trips` refer to its
passenger column by role rather than by name, because the rename is the demo
and a redo that hard-coded the old name would fail against the new table
instead of absorbing it.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from dataclasses import dataclass
from pathlib import Path

from agents import graph
from agents.pipeline import AgentTask, task_urn as _task_urn

# Dataset namespace for the scale swarm's tables. Distinct from the demo's
# `obsel_demo` so the two swarms can never collide on a table name in DataHub.
NAMESPACE = "obsel_taxi"

SEED_TABLES = ("raw_trips", "raw_zones")

# sha256 of the committed seed files, byte for byte. Pinned here and re-checked
# by the self-check, so a quiet edit to a seed fails `pnpm verify` instead of
# shifting every fingerprint downstream. The derivation and source hashes are
# in seeds/PROVENANCE.md.
SEED_SHA256 = {
    "raw_trips": "069e0b07b85d8d9899bca94bf0e62c4469169c3d9a59791b61c6c5127a0a7eec",
    "raw_zones": "c9dc0caa7e7076b3620ee3d1702a237841b99d31854fbf3daf0fe6d7cae939bf",
}

# The boroughs that get their own mart. Derived from the committed extract's
# own facts, not from the map: the first run of this swarm carried a Staten
# Island mart, and it failed live, because yellow-taxi pickups in Staten Island
# are so rare that 2,100 real trips contain none at all — the mart produced a
# legitimately empty table and the runner's no-empty-tables guard rightly
# refused it. The shape now follows the data (Manhattan 1740, Queens 336,
# Brooklyn 20, Bronx 2 pickups in the pinned extract), everything else folds
# into the `other` mart, and the self-check recomputes every filter against
# the committed seeds so an unfillable task cannot come back quietly.
BOROUGHS = ("bronx", "brooklyn", "manhattan", "queens")

_BOROUGH_LABELS = {
    "bronx": "Bronx",
    "brooklyn": "Brooklyn",
    "manhattan": "Manhattan",
    "queens": "Queens",
}

# One prose contract sentence shared by every table-producing instruction, so
# the requirement live runs keep proving necessary is stated identically
# everywhere: exact names, exact order, pinned number forms.
_FORM = (
    "Money is a number rounded to two decimal places. A share is a fraction "
    "between 0 and 1 rounded to four decimal places. Counts are whole numbers. "
    "Produce exactly the columns named, in that order, and no others."
)

_REPORT_FORM = (
    "Produce a table with exactly three columns named section, heading and text, "
    "in that order. One row per section, in the order the sections are named "
    "here. section is a short lowercase identifier, heading is a short title, "
    "and text is one to three plain sentences. Quote figures exactly as they "
    "appear in the input tables; never estimate, extrapolate, or invent a "
    "comparison that is not in the data."
)


def _task(kind: str, name: str, title: str, summary: str, reads: tuple[str, ...],
          writes: str, columns: tuple[str, ...], instruction: str) -> AgentTask:
    return AgentTask(
        name=name,
        kind=kind,
        title=title,
        summary=summary,
        reads=reads,
        writes=writes,
        output_columns=columns,
        instruction=instruction,
        namespace=NAMESPACE,
    )


def _build_tasks() -> tuple[AgentTask, ...]:
    tasks: list[AgentTask] = []

    # ------------------------------------------------------------------ clean
    tasks.append(_task(
        "clean", "clean_trips", "Trip cleaner",
        "cleans the raw taxi trips into a tidy typed table",
        ("raw_trips",), "clean_trips",
        ("trip_id", "pickup_date", "pickup_hour", "pickup_zone_id", "dropoff_zone_id",
         "passenger_count", "trip_distance", "fare_amount", "tip_amount",
         "total_amount", "payment_label"),
        "You are cleaning one week of raw taxi trips before anyone reports on "
        "them. Keep one row per trip. Split pickup_datetime into pickup_date, a "
        "calendar date, and pickup_hour, a whole number 0 through 23. Drop any "
        "row whose dropoff_datetime is not after its pickup_datetime; those are "
        "meter errors, not trips. Map payment_type to a payment_label word: 1 is "
        "card, 2 is cash, 3 is no_charge, 4 is dispute. Carry trip_id, "
        "pickup_zone_id, dropoff_zone_id, passenger_count, trip_distance, "
        "fare_amount, tip_amount and total_amount through unchanged except that "
        "distances and money are rounded to two decimal places. Sort by trip_id "
        f"ascending. {_FORM}",
    ))

    tasks.append(_task(
        "clean", "clean_zones", "Zone cleaner",
        "cleans the zone lookup into id, name and borough",
        ("raw_zones",), "clean_zones",
        ("zone_id", "zone_name", "borough"),
        "You are cleaning the taxi zone lookup. Keep zone_id, zone_name and "
        "borough, dropping service_zone. Trim whitespace from both ends of every "
        "name. Keep every row, including boroughs like EWR and Unknown, because "
        "downstream joins must be able to resolve every id they meet. Sort by "
        f"zone_id ascending. {_FORM}",
    ))

    # ----------------------------------------------------------------- enrich
    tasks.append(_task(
        "join", "label_trips", "Trip labeller",
        "attaches zone names and boroughs to every trip",
        ("clean_trips", "clean_zones"), "labeled_trips",
        ("trip_id", "pickup_date", "pickup_hour", "pickup_borough", "pickup_zone",
         "dropoff_borough", "dropoff_zone", "passenger_count", "trip_distance",
         "fare_amount", "tip_amount", "total_amount", "payment_label"),
        "Attach zone names to the cleaned trips. For each trip, look up its "
        "pickup_zone_id and dropoff_zone_id in the zones table: pickup_borough "
        "and pickup_zone are that zone's borough and zone_name, and likewise for "
        "the dropoff side. A zone id with no row in the zones table gets the "
        "word Unknown for both its borough and its zone name. Keep every trip "
        "and carry the remaining trip columns through unchanged. Sort by trip_id "
        f"ascending. {_FORM}",
    ))

    # ------------------------------------------------------------ base marts
    tasks.append(_task(
        "aggregate", "daily_trips", "Daily totals",
        "totals the cleaned trips into one row per day",
        ("clean_trips",), "daily_trips",
        ("pickup_date", "trips", "riders", "total_distance", "total_fares"),
        "Turn the cleaned trips into one row per pickup_date. trips counts the "
        "rows that day. riders sums passenger_count. total_distance sums "
        "trip_distance, rounded to two decimal places. total_fares sums "
        "fare_amount, rounded to two decimal places. Sort by pickup_date "
        f"ascending. {_FORM}",
    ))

    tasks.append(_task(
        "aggregate", "payment_mix", "Payment mix",
        "breaks each day down by how riders paid",
        ("clean_trips",), "payment_mix",
        ("pickup_date", "payment_label", "trips", "fare_total", "tip_total"),
        "Break each day down by payment_label. One row per pickup_date and "
        "payment_label pair that actually occurs. trips counts the rows in the "
        "pair. fare_total sums fare_amount and tip_total sums tip_amount, each "
        "rounded to two decimal places. Sort by pickup_date ascending, then "
        f"payment_label ascending. {_FORM}",
    ))

    tasks.append(_task(
        "aggregate", "hourly_profile", "Hourly profile",
        "profiles the week by hour of day",
        ("clean_trips",), "hourly_profile",
        ("pickup_hour", "trips", "average_fare"),
        "Profile the whole week by hour of day. One row per pickup_hour that "
        "occurs. trips counts the rows in that hour across all days. "
        "average_fare is the mean fare_amount in that hour, rounded to two "
        f"decimal places. Sort by pickup_hour ascending. {_FORM}",
    ))

    tasks.append(_task(
        "aggregate", "trip_lengths", "Trip lengths",
        "buckets each day's trips by distance",
        ("clean_trips",), "trip_lengths",
        ("pickup_date", "bucket", "trips", "average_distance"),
        "Bucket each day's trips by distance: short is under 2 miles, medium is "
        "2 to 6 miles inclusive, long is over 6 miles. One row per pickup_date "
        "and bucket pair that occurs, with bucket holding the words short, "
        "medium or long. trips counts the rows in the pair. average_distance is "
        "the mean trip_distance in the pair, rounded to two decimal places. Sort "
        "by pickup_date ascending, then bucket in the order short, medium, "
        f"long. {_FORM}",
    ))

    # -------------------------------------------------------- borough branch
    for key in BOROUGHS:
        label = _BOROUGH_LABELS[key]
        tasks.append(_task(
            "aggregate", f"mart_{key}", f"{label} daily mart",
            f"totals {label} pickups into one row per day",
            ("labeled_trips",), f"borough_mart_{key}",
            ("pickup_date", "trips", "fares_total", "tips_total"),
            f"Keep only trips whose pickup_borough is exactly {label}. Total "
            "them into one row per pickup_date: trips counts the rows, "
            "fares_total sums fare_amount, tips_total sums tip_amount, money "
            "rounded to two decimal places. A day with no such trips gets no "
            f"row. Sort by pickup_date ascending. {_FORM}",
        ))

    tasks.append(_task(
        "aggregate", "mart_other", "Outside-borough mart",
        "totals pickups outside the four mart boroughs into one row per day",
        ("labeled_trips",), "borough_mart_other",
        ("pickup_date", "trips", "fares_total", "tips_total"),
        "Keep only trips whose pickup_borough is none of Bronx, Brooklyn, "
        "Manhattan or Queens; that leaves Staten Island, airports outside the "
        "city, and unknown zones. Total them into one row per pickup_date: trips "
        "counts the rows, fares_total sums fare_amount, tips_total sums "
        "tip_amount, money rounded to two decimal places. A day with no such "
        f"trips gets no row. Sort by pickup_date ascending. {_FORM}",
    ))

    for key in (*BOROUGHS, "other"):
        label = _BOROUGH_LABELS.get(key, "outside the boroughs")
        tasks.append(_task(
            "rollup", f"week_{key}", f"{_BOROUGH_LABELS.get(key, 'Outside-borough')} week",
            f"rolls the {label} daily mart up to one weekly row",
            (f"borough_mart_{key}",), f"borough_week_{key}",
            ("borough", "trips", "fares_total", "tips_total", "busiest_date"),
            "Roll the daily mart you are given up to exactly one row for the "
            "whole week. borough repeats the name used in this mart, spelled "
            f"{_BOROUGH_LABELS.get(key, 'Other')}. trips, fares_total and "
            "tips_total sum their daily columns, money rounded to two decimal "
            "places. busiest_date is the pickup_date with the most trips; on a "
            f"tie take the earliest date. {_FORM}",
        ))

    tasks.append(_task(
        "rollup", "city_boroughs", "Borough summary",
        "lines the five weekly borough rollups up side by side",
        tuple(f"borough_week_{key}" for key in (*BOROUGHS, "other")),
        "city_borough_summary",
        ("borough", "trips", "fares_total", "tips_total", "busiest_date"),
        "You are given five one-row weekly borough tables. Stack them into one "
        "table with one row per borough, carrying each row through unchanged. "
        f"Sort by borough ascending. {_FORM}",
    ))

    # ------------------------------------------------------------ city rollups
    tasks.append(_task(
        "rollup", "city_week", "City week",
        "rolls the whole week up into one city-wide row",
        ("daily_trips", "trip_lengths"), "city_week",
        ("trips", "riders", "total_distance", "total_fares", "long_trip_share"),
        "Roll the whole week up into exactly one row. From the daily totals "
        "table: trips sums its trips column, riders sums its passenger total "
        "column whatever that column is named, total_distance and total_fares "
        "sum their columns, money and distance rounded to two decimal places. "
        "From the trip lengths table: long_trip_share is the week's long-bucket "
        "trips divided by all its trips, a share rounded to four decimal "
        f"places. {_FORM}",
    ))

    tasks.append(_task(
        "rollup", "fare_summary", "Fare summary",
        "joins daily fares with how much of each day was paid by card",
        ("daily_trips", "payment_mix"), "fare_summary",
        ("pickup_date", "total_fares", "card_share"),
        "One row per pickup_date. total_fares comes from the daily totals "
        "table's total_fares column. card_share is that day's card fare_total "
        "from the payment mix divided by the sum of that day's fare_total over "
        "all payment labels, a share rounded to four decimal places. Sort by "
        f"pickup_date ascending. {_FORM}",
    ))

    tasks.append(_task(
        "rollup", "tips_by_payment", "Tips by payment",
        "compares tipping across the four payment types",
        ("payment_mix",), "tips_by_payment",
        ("payment_label", "trips", "fare_total", "tip_total", "tip_rate"),
        "Roll the payment mix up across the week to one row per payment_label. "
        "trips, fare_total and tip_total sum their columns, money rounded to "
        "two decimal places. tip_rate is tip_total divided by fare_total, a "
        "share rounded to four decimal places; if fare_total is zero the rate "
        f"is 0. Sort by payment_label ascending. {_FORM}",
    ))

    tasks.append(_task(
        "rollup", "revenue_overview", "Revenue overview",
        "condenses the week's money story into one row",
        ("fare_summary", "tips_by_payment"), "revenue_overview",
        ("total_fares_week", "card_share_week", "best_tip_payment", "best_tip_rate"),
        "Condense the money story into exactly one row. total_fares_week sums "
        "the fare summary's total_fares, rounded to two decimal places. "
        "card_share_week is the mean of its card_share values, a share rounded "
        "to four decimal places. best_tip_payment is the payment_label with the "
        "highest tip_rate in the tips table, and best_tip_rate is that rate; on "
        f"a tie take the alphabetically first label. {_FORM}",
    ))

    # ---------------------------------------------------------------- movement
    tasks.append(_task(
        "aggregate", "cross_borough", "Borough flows",
        "counts trips between every pair of boroughs",
        ("labeled_trips",), "cross_borough",
        ("pickup_borough", "dropoff_borough", "trips"),
        "Count trips between boroughs. One row per pickup_borough and "
        "dropoff_borough pair that occurs, with trips counting the rows. Sort "
        "by pickup_borough ascending, then dropoff_borough ascending. "
        f"{_FORM}",
    ))

    tasks.append(_task(
        "aggregate", "dropoff_mix", "Dropoff mix",
        "counts where the week's trips ended, by borough",
        ("labeled_trips",), "dropoff_borough_mix",
        ("dropoff_borough", "trips"),
        "Count where trips ended. One row per dropoff_borough that occurs, with "
        "trips counting the rows across the whole week. Every trip has a "
        "dropoff, so every borough that appears gets its real count. Sort by "
        f"trips descending, then dropoff_borough ascending. {_FORM}",
    ))

    tasks.append(_task(
        "aggregate", "zone_leaders", "Zone leaders",
        "ranks the fifteen busiest pickup zones",
        ("labeled_trips",), "zone_leaders",
        ("rank", "zone_name", "borough", "trips"),
        "Rank pickup zones by how many trips started there, using pickup_zone "
        "and pickup_borough. Keep the top fifteen. rank runs 1 through 15. On a "
        "tie in trips, the alphabetically earlier zone_name ranks higher. Sort "
        f"by rank ascending. {_FORM}",
    ))

    tasks.append(_task(
        "rollup", "movement_summary", "Movement summary",
        "condenses where the city moved into one row",
        ("cross_borough", "zone_leaders", "dropoff_borough_mix"), "movement_summary",
        ("top_flow_pickup", "top_flow_dropoff", "top_flow_trips",
         "busiest_zone", "busiest_zone_trips", "top_dropoff_borough"),
        "Condense movement into exactly one row. The top flow is the "
        "cross-borough row with the most trips; on a tie take the row whose "
        "pickup_borough, then dropoff_borough, sorts first. busiest_zone and "
        "busiest_zone_trips come from the rank 1 row of the zone leaders. "
        "top_dropoff_borough is the dropoff mix's first row's borough. "
        f"{_FORM}",
    ))

    # ------------------------------------------------------------------ riders
    tasks.append(_task(
        "aggregate", "weekday_profile", "Weekday profile",
        "profiles the week by day of the week",
        ("daily_trips",), "weekday_profile",
        ("weekday", "trips", "riders"),
        "Profile the daily totals by day of the week. One row per calendar day, "
        "since this week holds each weekday once. weekday is the English day "
        "name of pickup_date, Monday through Sunday. trips carries that day's "
        "trips. riders carries that day's passenger total, whatever that column "
        "is named in the table you receive. Sort in weekday order Monday "
        f"first. {_FORM}",
    ))

    tasks.append(_task(
        "rollup", "weekend_summary", "Weekend summary",
        "compares the week's working days against its weekend",
        ("daily_trips",), "weekend_summary",
        ("weekday_trips", "weekend_trips", "weekday_riders", "weekend_riders"),
        "Compare working days against the weekend, in exactly one row. Monday "
        "through Friday are working days; Saturday and Sunday are the weekend, "
        "judged from each pickup_date. weekday_trips and weekend_trips sum the "
        "trips column on each side. weekday_riders and weekend_riders sum the "
        "passenger total column on each side, whatever that column is named in "
        f"the table you receive. {_FORM}",
    ))

    tasks.append(_task(
        "rollup", "rider_overview", "Rider overview",
        "condenses when the city rode into one row",
        ("weekday_profile", "hourly_profile"), "rider_overview",
        ("busiest_weekday", "busiest_hour", "trips_at_peak_hour", "riders_week"),
        "Condense ridership into exactly one row. busiest_weekday is the "
        "weekday with the most trips; on a tie the earlier day of the week "
        "wins. busiest_hour is the pickup_hour with the most trips and "
        "trips_at_peak_hour is that count; on a tie the earlier hour wins. "
        "riders_week sums the weekday profile's riders column. "
        f"{_FORM}",
    ))

    # ----------------------------------------------------------------- airport
    tasks.append(_task(
        "join", "airport_trips", "Airport filter",
        "keeps the trips that touched an airport",
        ("labeled_trips",), "airport_trips",
        ("trip_id", "pickup_date", "pickup_zone", "dropoff_zone", "fare_amount",
         "total_amount"),
        "Keep only trips where the word Airport appears in pickup_zone or "
        "dropoff_zone. Carry trip_id, pickup_date, pickup_zone, dropoff_zone, "
        "fare_amount and total_amount through unchanged. Sort by trip_id "
        f"ascending. {_FORM}",
    ))

    tasks.append(_task(
        "aggregate", "airport_daily", "Airport daily",
        "totals the airport trips into one row per day",
        ("airport_trips",), "airport_daily",
        ("pickup_date", "trips", "fares_total"),
        "Total the airport trips into one row per pickup_date: trips counts the "
        "rows, fares_total sums fare_amount rounded to two decimal places. A "
        "day with no airport trips gets no row. Sort by pickup_date ascending. "
        f"{_FORM}",
    ))

    tasks.append(_task(
        "rollup", "airport_week", "Airport week",
        "rolls the airport story up to one weekly row",
        ("airport_daily",), "airport_week",
        ("trips", "fares_total", "busiest_date"),
        "Roll the airport dailies up to exactly one row: trips and fares_total "
        "sum their columns, money rounded to two decimal places, and "
        "busiest_date is the pickup_date with the most trips, the earliest date "
        f"winning a tie. {_FORM}",
    ))

    # ------------------------------------------------------------------ leaves
    tasks.append(_task(
        "report", "report_city", "City report",
        "writes the citywide weekly report an operations lead reads",
        ("city_week", "revenue_overview"), "city_report",
        ("section", "heading", "text"),
        "Write the citywide weekly report for an operations lead who has ninety "
        "seconds, from the city week row and the revenue overview row. Sections "
        "in order: volume, covering trips and riders; money, covering total "
        "fares and the card share; tipping, covering which payment type tips "
        f"best and at what rate. {_REPORT_FORM}",
    ))

    tasks.append(_task(
        "report", "report_boroughs", "Borough report",
        "writes the borough comparison report",
        ("city_borough_summary", "movement_summary"), "borough_report",
        ("section", "heading", "text"),
        "Write the borough comparison report from the borough summary and the "
        "movement summary. Sections in order: leaders, naming the borough with "
        "the most trips and the one with the most fare money; flows, covering "
        "the single biggest borough-to-borough flow; zones, covering the "
        f"busiest single pickup zone. {_REPORT_FORM}",
    ))

    tasks.append(_task(
        "report", "report_riders", "Rider report",
        "writes the when-do-people-ride report",
        ("rider_overview",), "rider_report",
        ("section", "heading", "text"),
        "Write the ridership report from the rider overview row. Sections in "
        "order: peak, covering the busiest weekday and the busiest hour with "
        "its trip count; volume, covering the week's total riders. "
        f"{_REPORT_FORM}",
    ))

    tasks.append(_task(
        "report", "report_airport", "Airport report",
        "writes the airport traffic report",
        ("airport_week",), "airport_report",
        ("section", "heading", "text"),
        "Write the airport traffic report from the airport week row. Sections "
        "in order: volume, covering how many trips touched an airport and what "
        "they paid in fares; peak, covering the busiest airport date. "
        f"{_REPORT_FORM}",
    ))

    tasks.append(_task(
        "docs", "docs_marts", "Mart docs",
        "documents the four base marts for the next engineer",
        ("daily_trips", "payment_mix", "hourly_profile", "trip_lengths"),
        "marts_docs",
        ("section", "heading", "text"),
        "Document the four mart tables you are given, for the next engineer. "
        "One section per table, named after the table, describing each of its "
        "columns with units and how it was derived. Describe only columns "
        f"actually present in the tables you receive. {_REPORT_FORM}",
    ))

    tasks.append(_task(
        "docs", "docs_boroughs", "Borough docs",
        "documents the borough summary table",
        ("city_borough_summary",), "borough_docs",
        ("section", "heading", "text"),
        "Document the borough summary table for the next engineer. One section "
        "per column, describing what it holds, its units, and how it was "
        f"derived. Describe only columns actually present. {_REPORT_FORM}",
    ))

    tasks.append(_task(
        "docs", "docs_movement", "Movement docs",
        "documents the two movement tables",
        ("cross_borough", "zone_leaders"), "movement_docs",
        ("section", "heading", "text"),
        "Document the cross-borough flows table and the zone leaders table for "
        "the next engineer. One section per table, describing its grain, each "
        "column with units, and its sort order. Describe only columns actually "
        f"present. {_REPORT_FORM}",
    ))

    tasks.append(_task(
        "docs", "docs_zones", "Zone docs",
        "documents the cleaned zone lookup",
        ("clean_zones",), "zone_docs",
        ("section", "heading", "text"),
        "Document the cleaned zone lookup for the next engineer. One section "
        "per column, describing what it holds and where it came from, and one "
        "final section named coverage describing how many zones there are and "
        f"which boroughs appear. {_REPORT_FORM}",
    ))

    return tuple(tasks)


TASKS: tuple[AgentTask, ...] = _build_tasks()

# ---------------------------------------------------------------------------
# The change the scale demo makes
# ---------------------------------------------------------------------------

# The task that re-runs with one changed requirement, mid-swarm.
CHANGE_TASK = "daily_trips"


@dataclass(frozen=True)
class ColumnRename:
    """One direction of the demo's rename, spelled out for the worker."""

    instruction: str
    columns: tuple[str, ...]
    removed: str
    added: str


def _rename(base: tuple[str, ...], old: str, new: str, why: str) -> ColumnRename:
    if old not in base or new in base:
        raise AssertionError(f"cannot rename {old!r} to {new!r} in {base!r}")
    return ColumnRename(
        instruction=next(t for t in TASKS if t.name == CHANGE_TASK).instruction + (
            f" One change from last time: the passenger column must now be named "
            f"{new} rather than {old}{why} Everything else about the totals "
            "stays the same."
        ),
        columns=tuple(new if column == old else column for column in base),
        removed=old,
        added=new,
    )


_ORIGINAL_COLUMNS = next(t for t in TASKS if t.name == CHANGE_TASK).output_columns

CHANGE_FORWARD = _rename(
    _ORIGINAL_COLUMNS, "riders", "passenger_total",
    ", so nobody mistakes it for a count of distinct people.",
)
CHANGE_REVERSE = _rename(CHANGE_FORWARD.columns, "passenger_total", "riders", ".")


def change_for(current_columns: tuple[str, ...] | list[str] | None) -> ColumnRename:
    """Which way the rename goes today, decided by where the board sits.

    Found by pressing the board's own button twice in one session. The change
    used to be one hard-coded direction, and a repair never touches the task
    that caused the cascade, so after `change` then `repair` the column was
    already renamed: the agent reproduced the table byte for byte, obsel
    correctly marked nothing, and the step failed its own descendant assertion.
    obsel was right every time; the demo was wrong. The engine has been proven
    indifferent to direction (the reverse rename marks the same nine tasks at
    the same hops), so the step now renames away from wherever the recorded
    run says the column currently sits, and the button can be pressed forever.

    Unknown columns fall back to the forward direction, which is exactly the
    old behaviour: a board with no recorded run is a board the change has
    never touched.
    """
    if current_columns is not None and CHANGE_FORWARD.added in current_columns:
        return CHANGE_REVERSE
    return CHANGE_FORWARD


# The mid-swarm form (`scale-run --change-during`) is always the forward
# direction: it lands on a board every task of which just ran from the original
# instructions, so the column it renames is always the original one.
CHANGE_INSTRUCTION = CHANGE_FORWARD.instruction

CHANGE_COLUMNS: tuple[str, ...] = CHANGE_FORWARD.columns

# ---------------------------------------------------------------------------
# Derived structure, shared by the runner and by every assertion
# ---------------------------------------------------------------------------


def dataset_urn(short_name: str) -> str:
    return graph.dataset_urn(f"{NAMESPACE}.{short_name}")


def task_urn(task_name: str) -> str:
    """Same flow as the demo, so the board shows whichever swarm is registered."""
    return _task_urn(task_name)


def by_name(task_name: str) -> AgentTask:
    for task in TASKS:
        if task.name == task_name:
            return task
    raise KeyError(f"no scale task named {task_name!r}")


def producer_of() -> dict[str, str]:
    """Which task writes each table. Seeds appear in nobody's values."""
    return {task.writes: task.name for task in TASKS}


def in_dependency_order() -> tuple[AgentTask, ...]:
    """Kahn topological order over who-writes-what-this-reads, ties by name."""
    producers = producer_of()
    pending = {task.name: task for task in TASKS}
    ordered: list[AgentTask] = []
    while pending:
        ready = [
            task for task in pending.values()
            if all(
                producers.get(source) is None or producers[source] not in pending
                for source in task.reads
            )
        ]
        if not ready:
            raise ValueError(f"scale tasks form a cycle: {sorted(pending)}")
        for task in sorted(ready, key=lambda t: t.name):
            ordered.append(task)
            del pending[task.name]
    return tuple(ordered)


def downstream_hops(changed_table: str) -> dict[str, int]:
    """Every task downstream of a table, with its distance in hops.

    The same walk obsel performs over DataHub's lineage graph, done over the
    declared shape, so the runner's assertions cannot quietly stop describing
    the pipeline they are asserted against.
    """
    readers: dict[str, list[str]] = {}
    for task in TASKS:
        for source in task.reads:
            readers.setdefault(source, []).append(task.name)

    hops: dict[str, int] = {}
    frontier = [(changed_table, 0)]
    while frontier:
        table, depth = frontier.pop(0)
        for name in sorted(readers.get(table, [])):
            if name in hops:
                continue
            hops[name] = depth + 1
            frontier.append((by_name(name).writes, depth + 1))
    return hops


# The eight tasks the change reaches, written out by hand and checked against
# the derived walk by the self-check, the same double-entry the demo's
# EXPECTED_CASCADE uses: the assertion must fail if the shape drifts.
EXPECTED_CHANGE_DESCENDANTS = {
    "city_week": 1,
    "fare_summary": 1,
    "weekday_profile": 1,
    "weekend_summary": 1,
    "docs_marts": 1,
    "revenue_overview": 2,
    "rider_overview": 2,
    "report_city": 2,
    "report_riders": 3,
}


# ---------------------------------------------------------------------------
# Seeds
# ---------------------------------------------------------------------------


def seeds_dir() -> Path:
    return Path(__file__).resolve().parent / "seeds"


def verify_seed_bytes(short_name: str) -> bytes:
    """The committed seed's bytes, after checking them against the pinned hash.

    Refusing on a mismatch is the point: a drifted seed silently moves every
    fingerprint downstream, and the demo's identical-redo beat would then fail
    in a way that looks like obsel being wrong rather than the ground moving.
    """
    path = seeds_dir() / f"{short_name}.json"
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    expected = SEED_SHA256[short_name]
    if digest != expected:
        raise RuntimeError(
            f"{path} does not match the pinned extract: sha256 {digest}, "
            f"expected {expected}. See agents/seeds/PROVENANCE.md; either "
            "restore the committed file or re-derive it and update the pin."
        )
    return data


def install_seeds(root: Path) -> list[str]:
    """Copy the committed seeds into the run's data directory, verified first.

    Returns the names it wrote. Existing files are left alone, matching the
    demo's `ensure_seed`: re-seeding mid-run would change an input under
    agents that already read it.
    """
    from agents import worker

    written: list[str] = []
    for short_name in SEED_TABLES:
        target = worker.table_path(short_name, root)
        if target.exists():
            continue
        data = verify_seed_bytes(short_name)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        written.append(short_name)
    return written


# ---------------------------------------------------------------------------
# Self-check
# ---------------------------------------------------------------------------


def _self_check() -> int:
    """Prove the structural properties every scale assertion rests on.

    Run directly: `python -m agents.scale`
    Deterministic and offline, except that the seed checks read the real
    committed files, because a hash check against remembered bytes proves
    nothing about the repository a judge actually cloned.
    """
    failures: list[str] = []

    def check(name: str, condition: bool, detail: str) -> None:
        print(f"  {'pass' if condition else 'FAIL'}  {name}: {detail}")
        if not condition:
            failures.append(name)

    print("shape")
    check("forty tasks", len(TASKS) == 40, f"{len(TASKS)} tasks defined")
    names = [task.name for task in TASKS]
    check("task names unique", len(set(names)) == len(names), "every name is one task")
    outputs = [task.writes for task in TASKS]
    check("one producer per table", len(set(outputs)) == len(outputs),
          "two tasks writing one table would make lineage ambiguous")
    check(
        "every read is produced or a seed",
        all(
            source in set(outputs) or source in SEED_TABLES
            for task in TASKS for source in task.reads
        ),
        "an unproduced non-seed input would block forever",
    )
    check(
        "seeds are produced by nothing",
        all(task.writes not in SEED_TABLES for task in TASKS),
        "a task writing a seed would let the swarm move its own ground",
    )
    check(
        "every task carries the scale namespace",
        all(task.namespace == NAMESPACE for task in TASKS),
        f"dataset URNs must all live under {NAMESPACE}",
    )
    check(
        "every task has an output contract",
        all(len(task.output_columns) > 0 for task in TASKS),
        "an uncontracted output drifts between runs and cries wolf",
    )
    prose_kinds = {"report", "docs"}
    check(
        "every numeric instruction pins its precision",
        all(
            "decimal places" in task.instruction
            for task in TASKS if task.kind not in prose_kinds
        ),
        "unpinned precision is the third live instability, see pipeline.py",
    )
    check(
        "every prose instruction pins quoting",
        all(
            "Quote figures exactly" in task.instruction
            for task in TASKS if task.kind in prose_kinds
        ),
        "a report that estimates is a report the numbers on screen disagree with",
    )

    try:
        order = in_dependency_order()
        check("no cycles", len(order) == 40, "Kahn ordered all forty")
    except ValueError as error:
        check("no cycles", False, str(error))

    print()
    print("the change")
    changed = by_name(CHANGE_TASK)
    check(
        "the changed contract differs by exactly the rename",
        set(changed.output_columns) - set(CHANGE_COLUMNS) == {"riders"}
        and set(CHANGE_COLUMNS) - set(changed.output_columns) == {"passenger_total"},
        "riders leaves, passenger_total arrives, nothing else moves",
    )
    check(
        "the two directions are exact mirrors of each other",
        CHANGE_REVERSE.columns == changed.output_columns
        and CHANGE_FORWARD.columns == CHANGE_COLUMNS
        and (CHANGE_FORWARD.removed, CHANGE_FORWARD.added)
        == (CHANGE_REVERSE.added, CHANGE_REVERSE.removed)
        and len(CHANGE_FORWARD.columns) == len(CHANGE_REVERSE.columns),
        "the reverse rename lands back on the original contract, nothing else moves",
    )
    check(
        "column order survives both renames",
        [c for c in CHANGE_FORWARD.columns if c != "passenger_total"]
        == [c for c in changed.output_columns if c != "riders"],
        "a rename must not quietly reorder the table",
    )
    check(
        "the chooser renames away from wherever the board sits",
        change_for(changed.output_columns) is CHANGE_FORWARD
        and change_for(CHANGE_FORWARD.columns) is CHANGE_REVERSE
        and change_for(list(CHANGE_FORWARD.columns)) is CHANGE_REVERSE
        and change_for(None) is CHANGE_FORWARD
        and change_for(()) is CHANGE_FORWARD,
        "riders means forward, passenger_total means reverse, unknown means forward",
    )
    check(
        "each instruction names its own rename, in words the agent acts on",
        "passenger_total rather than riders" in CHANGE_FORWARD.instruction
        and "riders rather than passenger_total" in CHANGE_REVERSE.instruction,
        "the 'rather than' pair is the sentence the rename hangs on",
    )
    derived = downstream_hops(changed.writes)
    check(
        "the hand-written descendant map matches the derived walk",
        derived == EXPECTED_CHANGE_DESCENDANTS,
        f"walked from {changed.writes}: {len(derived)} descendants",
    )
    check(
        "the change reaches three hops",
        max(EXPECTED_CHANGE_DESCENDANTS.values()) == 3,
        "report_riders is reached through two intermediate tables",
    )
    untouched = set(names) - set(EXPECTED_CHANGE_DESCENDANTS) - {CHANGE_TASK}
    check(
        "thirty tasks stand outside the change",
        len(untouched) == 30,
        "the precision claim: the flag set is a strict, nameable subset",
    )
    check(
        "an untouched branch reaches a leaf",
        "docs_zones" in untouched and "report_airport" in untouched,
        "whole branches, not stragglers, stand outside the change",
    )
    deep_readers = {
        name for name, hops in EXPECTED_CHANGE_DESCENDANTS.items()
        if hops > 1 and changed.writes not in by_name(name).reads
    }
    check(
        "the deep descendants never read the changed table",
        deep_readers == {n for n, h in EXPECTED_CHANGE_DESCENDANTS.items() if h > 1},
        "reached through what they did read, which is the whole point of lineage",
    )

    print()
    print("the data can fill every filter")
    # A filtering task whose filter matches nothing in the pinned extract
    # produces a legitimately empty table, and the runner's no-empty-tables
    # guard rightly refuses it — which is how the Staten Island mart failed
    # live before this section existed. The shape's viability is a fact of the
    # committed seeds, so it is checked against them, not remembered.
    from collections import Counter
    from datetime import date as _date

    trips = json.loads(verify_seed_bytes("raw_trips"))
    zones = json.loads(verify_seed_bytes("raw_zones"))
    borough_of = {row["zone_id"]: row["borough"] for row in zones["rows"]}
    zone_name_of = {row["zone_id"]: row["zone_name"] for row in zones["rows"]}

    pickup_counts = Counter(
        borough_of.get(row["pickup_zone_id"], "Unknown") for row in trips["rows"]
    )
    for key in BOROUGHS:
        label = _BOROUGH_LABELS[key]
        check(
            f"the {label} mart has rows to keep",
            pickup_counts.get(label, 0) > 0,
            f"{pickup_counts.get(label, 0)} pickups in the pinned extract",
        )
    other = sum(
        count for name, count in pickup_counts.items() if name not in _BOROUGH_LABELS.values()
    )
    check(
        "the other mart has rows to keep",
        other > 0,
        f"{other} pickups outside the four mart boroughs",
    )
    airport = sum(
        1
        for row in trips["rows"]
        if "Airport"
        in (zone_name_of.get(row["pickup_zone_id"], "") + zone_name_of.get(row["dropoff_zone_id"], ""))
    )
    check(
        "the airport filter has rows to keep",
        airport > 0,
        f"{airport} trips touch a zone named Airport",
    )
    weekend = sum(
        1
        for row in trips["rows"]
        if _date.fromisoformat(row["pickup_datetime"][:10]).weekday() >= 5
    )
    check(
        "both sides of the weekend split have rows",
        0 < weekend < len(trips["rows"]),
        f"{weekend} weekend trips, {len(trips['rows']) - weekend} working-day trips",
    )

    print()
    print("the seeds")
    for short_name in SEED_TABLES:
        try:
            data = verify_seed_bytes(short_name)
            table = json.loads(data)
            check(
                f"{short_name} matches its pin and parses",
                isinstance(table.get("rows"), list) and len(table["rows"]) > 0,
                f"{len(table['rows'])} rows, sha256 pinned",
            )
        except (RuntimeError, KeyError, json.JSONDecodeError) as error:
            check(f"{short_name} matches its pin and parses", False, str(error)[:120])

    with_quota = json.loads(verify_seed_bytes("raw_trips"))
    days = {row["pickup_datetime"][:10] for row in with_quota["rows"]}
    check(
        "the trips cover a full week",
        len(days) == 7,
        f"{min(days)} through {max(days)}, one Monday-to-Sunday week",
    )

    print()
    if failures:
        print(f"FAILED: {', '.join(failures)}")
        return 1
    print("the scale shape holds")
    return 0


if __name__ == "__main__":
    import sys

    if "--shape" in sys.argv:
        for step in in_dependency_order():
            reads = ", ".join(step.reads)
            print(f"{step.name:<18} {step.kind:<10} reads {reads:<50} writes {step.writes}")
    else:
        raise SystemExit(_self_check())
