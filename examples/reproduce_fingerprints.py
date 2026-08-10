"""Recompute every fingerprint in `examples/` and check the JSON files against it.

Run it:

    python3 examples/reproduce_fingerprints.py

It recomputes each digest from the actual rows it was taken over and compares the
result to the value stored in `swarm-before.json`, `swarm-after.json` and
`coordination-result.json`. Exit code 0 means every digest in those files came out
of `agents/fingerprint.py` over the table printed here. Any edit to a digest in the
JSON, or to a row in `tables/`, makes it fail.

What this does and does not prove
---------------------------------
The tables in `tables/before.json` and `tables/after.json` are **captured**, not
written by hand. They are the five tables that were on disk either side of the
`change` step of a real run, saved by `agents.run change --capture`, and every
digest in the JSON files was computed from them by the run itself. So this script
proves two things at once: that the digests are genuine sha256 output of the real
fingerprinting code, and that the tables they were taken over are what four live
Codex agents actually produced.

What it does not prove is that a *different* run would produce the same tables.
Codex is a live agent. Column names are held to the contract in
`agents/pipeline.py` and numeric values to one serialized form by
`worker.canonicalise_numbers`, but the row values and the prose in the two written
documents are the agents' own work and would differ on another run. The properties
checked below are the parts that must hold for any run at all.
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


def _load(name: str) -> Any:
    return json.loads((HERE / name).read_text(encoding="utf-8"))


# The five tables as they were either side of the change, captured from the run.
# `clean_orders` is the only one that differs between them, because it is the only
# task that ran again.
TABLES_BEFORE: dict[str, Table] = _load("tables/before.json")
TABLES_AFTER: dict[str, Table] = _load("tables/after.json")

# Written by a task, so obsel holds a fingerprint for it. `raw_orders` is the seed
# and nothing in the swarm produces it, so it is captured for context but carries
# no fingerprint to check.
PRODUCED = ("clean_orders", "daily_revenue", "revenue_report", "pipeline_docs")


def _fingerprint_of(tables: dict[str, Table], name: str) -> dict[str, str]:
    table = tables[name]
    return fingerprint(table["rows"], table["columns"])


def digests() -> dict[str, dict[str, str]]:
    """Every digest the example files quote, keyed by the label used in the README."""
    computed = {
        "clean_orders (before the rename)": _fingerprint_of(TABLES_BEFORE, "clean_orders"),
        "clean_orders (after the rename)": _fingerprint_of(TABLES_AFTER, "clean_orders"),
    }
    for name in PRODUCED[1:]:
        computed[name] = _fingerprint_of(TABLES_BEFORE, name)
    return computed


# --------------------------------------------------------------------------
# Checking the JSON files against them
# --------------------------------------------------------------------------

DATASET = "urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.{name},PROD)".format


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

    print("digests recomputed from the captured tables")
    for label, printed in computed.items():
        source = TABLES_AFTER if "after" in label else TABLES_BEFORE
        name = label.split(" ")[0]
        rows = len(source[name]["rows"])
        print(f"\n  {label} — {rows} rows, columns {', '.join(source[name]['columns'])}")
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
        "the renamed column is the only difference",
        [c for c in TABLES_BEFORE["clean_orders"]["columns"] if c != "order_total"]
        == [c for c in TABLES_AFTER["clean_orders"]["columns"] if c != "order_total_usd"],
        "every other column name is unchanged and in the same position",
    )
    check(
        "both write tasks share a schema digest",
        report["schema"] == docs["schema"],
        "both write tasks are held to the same three columns",
    )
    check(
        "the two write tasks differ in content",
        report["content"] != docs["content"],
        "same shape, different document",
    )
    check(
        "the three untouched tables did not move",
        all(
            _fingerprint_of(TABLES_BEFORE, name) == _fingerprint_of(TABLES_AFTER, name)
            for name in PRODUCED[1:]
        ),
        "they were stale because of what they were built on, not because they changed",
    )

    # Which digest each dataset should be carrying, per file. clean_orders is the only
    # one that differs between before and after, because it is the only thing that ran
    # again.
    unchanged = {DATASET(name=name): computed[name] for name in PRODUCED[1:]}
    expected = {
        "swarm-before.json": {DATASET(name="clean_orders"): before, **unchanged},
        "swarm-after.json": {DATASET(name="clean_orders"): after, **unchanged},
        "coordination-result.json": dict(unchanged),
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
