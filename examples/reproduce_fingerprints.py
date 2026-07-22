"""Recompute every fingerprint in `examples/` and check the JSON files against it.

Run it:

    python3 examples/reproduce_fingerprints.py

It prints each digest and then compares it to the value stored in
`swarm-before.json`, `swarm-after.json` and `coordination-result.json`. Exit code 0
means every digest in those files came out of `agents/fingerprint.py` over the table
printed here. Any edit to a digest in the JSON, or to a table here, makes it fail.

What this does and does not prove
---------------------------------
It proves the digests are genuine sha256 output of the real fingerprinting code over
the tables below. It does not prove those tables are what a live run produced -- the
demo has not been run end to end against a real model, so the row values here are
written by hand to be a plausible small pipeline, not captured.

Two of the four column sets are fixed by code and would come out this way from any
run:

  revenue_report and pipeline_docs -- `worker.apply_write` hardcodes
  ["section", "heading", "text"] for both write tasks, so both tables must carry the
  same schema digest no matter what the model returns. Only their content differs.

The other two are chosen by the model at run time, inside limits the instruction in
`agents/pipeline.py` sets:

  clean_orders -- the instruction names all four columns explicitly ("named exactly
  order_id, customer, order_total and order_date"), so a plan that obeys it gives the
  columns used here. The row values are invented.

  daily_revenue -- the instruction pins only the day column ("Name the day column
  order_date"). The other three names are the model's choice, so the schema digest
  here is one plausible outcome rather than a fixed one. A real run may well name
  them differently and produce a different digest.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent

# The same import path a reader would use by hand from the repository root.
sys.path.insert(0, str(REPO_ROOT / "agents"))

from fingerprint import fingerprint  # noqa: E402

Table = dict[str, Any]


# --------------------------------------------------------------------------
# The tables the digests are taken over
# --------------------------------------------------------------------------

# clean_orders, as `clean_orders` writes it. Three rows is enough to show the shape;
# the demo's seed table is larger.
CLEAN_ORDERS: Table = {
    "columns": ["order_id", "customer", "order_total", "order_date"],
    "rows": [
        {"order_id": 7001, "customer": "Ada Okafor", "order_total": 42.5, "order_date": "2026-07-20"},
        {"order_id": 7002, "customer": "Ben Ruiz", "order_total": 18.0, "order_date": "2026-07-20"},
        {"order_id": 7003, "customer": "Cai Zhou", "order_total": 99.99, "order_date": "2026-07-21"},
    ],
}

# The same table after the demo's change: order_total becomes order_total_usd, and
# nothing else moves. This is the rename the whole cascade hangs off.
CLEAN_ORDERS_RENAMED: Table = {
    "columns": ["order_id", "customer", "order_total_usd", "order_date"],
    "rows": [
        {"order_id": 7001, "customer": "Ada Okafor", "order_total_usd": 42.5, "order_date": "2026-07-20"},
        {"order_id": 7002, "customer": "Ben Ruiz", "order_total_usd": 18.0, "order_date": "2026-07-20"},
        {"order_id": 7003, "customer": "Cai Zhou", "order_total_usd": 99.99, "order_date": "2026-07-21"},
    ],
}

# daily_revenue, as `build_revenue` writes it: one row per calendar day, the group-by
# column first and then the aggregations, which is the order `worker.apply_aggregate`
# builds. Values are what its sum/count/mean operations give over CLEAN_ORDERS.
DAILY_REVENUE: Table = {
    "columns": ["order_date", "revenue", "order_count", "average_order_value"],
    "rows": [
        {"order_date": "2026-07-20", "revenue": 60.5, "order_count": 2, "average_order_value": 30.25},
        {"order_date": "2026-07-21", "revenue": 99.99, "order_count": 1, "average_order_value": 99.99},
    ],
}

# revenue_report, as `write_report` writes it. Columns are hardcoded by
# `worker.apply_write`; the model supplies one entry per section.
REVENUE_REPORT: Table = {
    "columns": ["section", "heading", "text"],
    "rows": [
        {
            "section": "period_total",
            "heading": "Period total",
            "text": "The table covers 2026-07-20 to 2026-07-21 and totals 160.49 across 3 orders.",
        },
        {
            "section": "strongest_and_weakest",
            "heading": "Strongest and weakest day",
            "text": "2026-07-21 took 99.99 from 1 order. 2026-07-20 took 60.5 from 2 orders.",
        },
        {
            "section": "what_explains_it",
            "heading": "What explains the difference",
            "text": (
                "Order size, not order volume. The stronger day had half the orders and an "
                "average order value of 99.99 against 30.25."
            ),
        },
        {
            "section": "bottom_line",
            "heading": "Bottom line",
            "text": "One large order carried 2026-07-21; two days is too short a period to read a trend from.",
        },
    ],
}

# pipeline_docs, as `write_docs` writes it. Same hardcoded columns as revenue_report,
# which is why the two share a schema digest.
PIPELINE_DOCS: Table = {
    "columns": ["section", "heading", "text"],
    "rows": [
        {
            "section": "order_date",
            "heading": "order_date",
            "text": "Calendar day, ISO 8601. Taken from the cleaned orders' order_date, which is a date and not a timestamp.",
        },
        {
            "section": "revenue",
            "heading": "revenue",
            "text": "Sum of order_total for that day, rounded to two decimal places. Same currency as the source.",
        },
        {
            "section": "order_count",
            "heading": "order_count",
            "text": "How many orders make up that day's revenue. Counts rows with a value, so it never counts a null.",
        },
        {
            "section": "average_order_value",
            "heading": "average_order_value",
            "text": "Mean of order_total for that day, rounded to two decimal places. Not revenue divided by a rounded count.",
        },
        {
            "section": "exclusions",
            "heading": "What this table leaves out",
            "text": (
                "Rows whose order_total was missing or not greater than zero were dropped upstream as "
                "cancellations and refunds, so this is gross takings on completed orders only."
            ),
        },
    ],
}


def digests() -> dict[str, dict[str, str]]:
    """Every digest the example files quote, keyed by the label used in the README."""
    return {
        "clean_orders (before the rename)": fingerprint(
            CLEAN_ORDERS["rows"], CLEAN_ORDERS["columns"]
        ),
        "clean_orders (after the rename)": fingerprint(
            CLEAN_ORDERS_RENAMED["rows"], CLEAN_ORDERS_RENAMED["columns"]
        ),
        "daily_revenue": fingerprint(DAILY_REVENUE["rows"], DAILY_REVENUE["columns"]),
        "revenue_report": fingerprint(REVENUE_REPORT["rows"], REVENUE_REPORT["columns"]),
        "pipeline_docs": fingerprint(PIPELINE_DOCS["rows"], PIPELINE_DOCS["columns"]),
    }


# --------------------------------------------------------------------------
# Checking the JSON files against them
# --------------------------------------------------------------------------

DATASET = "urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.{name},PROD)".format


def _load(name: str) -> Any:
    return json.loads((HERE / name).read_text(encoding="utf-8"))


def _fingerprints_in(document: Any) -> list[tuple[str, str, dict[str, str]]]:
    """Every (file location, dataset urn, fingerprint) triple in one example file."""
    found: list[tuple[str, str, dict[str, str]]] = []

    def walk(node: Any, path: str) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                if key == "fingerprints" and isinstance(value, dict):
                    for urn, printed in value.items():
                        found.append((path, urn, printed))
                else:
                    walk(value, f"{path}.{key}")
        elif isinstance(node, list):
            for index, value in enumerate(node):
                walk(value, f"{path}[{index}]")

    walk(document, "$")
    return found


def main() -> int:
    computed = digests()

    print("digests from agents/fingerprint.py")
    for label, printed in computed.items():
        print(f"\n  {label}")
        print(f"    schema  {printed['schema']}")
        print(f"    content {printed['content']}")

    print("\nproperties this demonstrates")
    before = computed["clean_orders (before the rename)"]
    after = computed["clean_orders (after the rename)"]
    report = computed["revenue_report"]
    docs = computed["pipeline_docs"]

    failures: list[str] = []

    def check(name: str, condition: bool, detail: str) -> None:
        print(f"  {'pass' if condition else 'FAIL'}  {name}: {detail}")
        if not condition:
            failures.append(name)

    check(
        "the rename moves schema only",
        after["schema"] != before["schema"] and after["content"] == before["content"],
        "which is why the mark can say 'its columns changed'",
    )
    check(
        "both write tasks share a schema digest",
        report["schema"] == docs["schema"],
        "worker.apply_write hardcodes the same three columns for both",
    )
    check(
        "the two write tasks differ in content",
        report["content"] != docs["content"],
        "same shape, different document",
    )

    # Which digest each dataset should be carrying, per file. clean_orders is the only
    # one that differs between before and after, because it is the only thing that ran
    # again.
    expected = {
        "swarm-before.json": {
            DATASET(name="clean_orders"): before,
            DATASET(name="daily_revenue"): computed["daily_revenue"],
            DATASET(name="revenue_report"): report,
            DATASET(name="pipeline_docs"): docs,
        },
        "swarm-after.json": {
            DATASET(name="clean_orders"): after,
            DATASET(name="daily_revenue"): computed["daily_revenue"],
            DATASET(name="revenue_report"): report,
            DATASET(name="pipeline_docs"): docs,
        },
        "coordination-result.json": {
            DATASET(name="daily_revenue"): computed["daily_revenue"],
            DATASET(name="revenue_report"): report,
            DATASET(name="pipeline_docs"): docs,
        },
    }

    print("\nexample files")
    for filename, wanted in expected.items():
        found = _fingerprints_in(_load(filename))
        if not found:
            check(filename, False, "no fingerprints found in the file at all")
            continue
        for path, urn, printed in found:
            want = wanted.get(urn)
            if want is None:
                check(f"{filename} {path}", False, f"unexpected dataset {urn}")
                continue
            check(
                f"{filename} {path}",
                printed == want,
                "matches" if printed == want else f"stored {printed}, computed {want}",
            )
        missing = sorted(set(wanted) - {urn for _, urn, _ in found})
        for urn in missing:
            check(f"{filename} {urn}", False, "expected a fingerprint for this dataset, found none")

    print()
    if failures:
        print(f"FAILED: {len(failures)} check(s)")
        return 1
    print("every digest in examples/ is reproduced by agents/fingerprint.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
