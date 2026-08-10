"""What a produced table looked like, reduced to two hashes.

obsel decides staleness by comparing an output's fingerprint against the one
recorded last time that output was written. That comparison is the only thing
standing between a useful tool and one that screams at everything downstream
every time a scheduled job re-runs, so the hashes have to be stable across runs,
across processes, and across dict insertion order.

Two hashes rather than one, because the split is what makes a stale mark
readable. `schema` moves when the columns move; `content` moves when the values
move. A column rename is then reported as "its columns changed" rather than the
useless "something changed" -- see `src/server/coordinator/types.ts`.

Two deliberate invariances, both chosen in the direction of fewer false alarms:

- Renaming a column does not touch `content`. Rows are hashed as their values in
  the table's declared column order, with the names left out; the names are
  already covered by `schema`.
- Reordering rows does not touch `content`. The serialized rows are sorted before
  hashing, so a task that emits the same rows in a different order is correctly
  treated as having produced the same table. The cost is that a pure reordering
  of a table where order carries meaning goes unreported; put an explicit
  ordering column in such a table rather than relying on position.

A pure column reorder does move `content`, since it moves the value layout. It is
reported as a change, which is right; only the explanation is coarser.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Mapping, Sequence

# Unit separator: cannot occur in a column name that any of these tools would
# accept, so joined names cannot collide the way "a,b" + "c" and "a" + "b,c" would.
COLUMN_SEPARATOR = "\x1f"

Row = Mapping[str, Any]


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _serialise_row(row: Row, columns: Sequence[str]) -> str:
    """One row as a JSON array of values, positionally aligned to `columns`.

    Values only. A missing key becomes null rather than raising, so a ragged row
    is fingerprinted as what it is instead of crashing the agent that produced it.
    `default=str` keeps dates and Decimals hashable without silently reordering
    anything.
    """
    values = [row.get(column) for column in columns]
    return json.dumps(values, separators=(",", ":"), ensure_ascii=False, default=str)


def schema_fingerprint(columns: Sequence[str]) -> str:
    """sha256 over the sorted column names."""
    return _sha256(COLUMN_SEPARATOR.join(sorted(columns)))


def content_fingerprint(
    rows: Sequence[Row],
    columns: Sequence[str],
    exclude: Sequence[str] = (),
) -> str:
    """sha256 over the rows' values, independent of column names and row order.

    `exclude` drops columns from the VALUES before hashing, and nothing else.
    It is how a task says "this column moves on every run and means nothing":
    a load timestamp, a batch id, a row number. Without it such a column moves
    the content hash every time, obsel reports a change nobody made, and the
    marks become noise people mute -- the exact failure the first correctness
    rule exists to prevent, arriving through the data instead of through the
    comparison.

    Deliberately not applied to `schema_fingerprint`. The NAME of a volatile
    column is still part of the table's shape, so renaming or dropping
    `loaded_at` is still a schema change and still reported. What is excluded
    is the claim that its values mean something.

    The exclusion list is declared once at registration and recorded on the
    task, so it is auditable and cannot vary per run. `agents/mcp_core.py`
    threads it here; nothing invents one.
    """
    kept = [column for column in columns if column not in set(exclude)]
    if not kept:
        raise ValueError(
            "every column was excluded as volatile, so the content hash would be a hash of "
            "nothing and could never report a change. Exclude fewer columns, or if the whole "
            "table is genuinely volatile, do not register it as an output obsel watches."
        )
    serialized = sorted(_serialise_row(row, kept) for row in rows)
    return _sha256("\n".join(serialized))


def fingerprint(
    rows: Sequence[Row],
    columns: Sequence[str],
    exclude: Sequence[str] = (),
) -> dict[str, str]:
    """The pair obsel stores and compares. Keys match `OutputFingerprint`."""
    return {
        "schema": schema_fingerprint(columns),
        "content": content_fingerprint(rows, columns, exclude),
    }


# --------------------------------------------------------------------------
# Self-check
# --------------------------------------------------------------------------


def _self_check() -> int:
    """Prove the properties the staleness engine depends on, and print the hashes.

    Run directly: `python agents/fingerprint.py`
    """
    import os
    import subprocess
    import sys

    columns = ["order_id", "customer", "order_total", "order_date"]
    rows = [
        {"order_id": 1, "customer": "Ada Okafor", "order_total": 42.50, "order_date": "2026-07-01"},
        {"order_id": 2, "customer": "Ben Ruiz", "order_total": 17.00, "order_date": "2026-07-01"},
        {"order_id": 3, "customer": "Cai Zhou", "order_total": 88.25, "order_date": "2026-07-02"},
    ]

    base = fingerprint(rows, columns)
    failures: list[str] = []

    def check(name: str, condition: bool, detail: str) -> None:
        print(f"  {'pass' if condition else 'FAIL'}  {name}: {detail}")
        if not condition:
            failures.append(name)

    print("baseline")
    print(f"  schema  {base['schema']}")
    print(f"  content {base['content']}")
    print()
    print("properties")

    repeat = fingerprint(rows, columns)
    check("same input twice", repeat == base, "both halves identical")

    # Insertion order of the row dicts must not leak into the hash.
    shuffled_keys = [
        {"order_date": r["order_date"], "order_total": r["order_total"], "customer": r["customer"], "order_id": r["order_id"]}
        for r in rows
    ]
    check(
        "dict insertion order ignored",
        fingerprint(shuffled_keys, columns) == base,
        "same keys written in reverse order hash identically",
    )

    check(
        "row order ignored",
        fingerprint(list(reversed(rows)), columns) == base,
        "reversed rows hash identically",
    )

    # The demo's money moment: order_total -> order_total_usd.
    renamed_columns = ["order_id", "customer", "order_total_usd", "order_date"]
    renamed_rows = [
        {"order_id": r["order_id"], "customer": r["customer"], "order_total_usd": r["order_total"], "order_date": r["order_date"]}
        for r in rows
    ]
    renamed = fingerprint(renamed_rows, renamed_columns)
    check(
        "rename moves schema only",
        renamed["schema"] != base["schema"] and renamed["content"] == base["content"],
        f"schema {base['schema'][:12]} -> {renamed['schema'][:12]}, content unchanged",
    )

    edited = [dict(r) for r in rows]
    edited[0]["order_total"] = 43.50
    changed = fingerprint(edited, columns)
    check(
        "edited value moves content only",
        changed["content"] != base["content"] and changed["schema"] == base["schema"],
        f"content {base['content'][:12]} -> {changed['content'][:12]}, schema unchanged",
    )

    added = fingerprint(rows, columns + ["currency"])
    check(
        "added column moves both",
        added["schema"] != base["schema"] and added["content"] != base["content"],
        "a new column changes the shape and adds a null to every row",
    )

    # Volatile columns: declared once at registration, excluded from the values
    # and from nothing else.
    stamped_columns = columns + ["loaded_at"]
    stamped = [{**r, "loaded_at": "2026-07-29T01:00:00Z"} for r in rows]
    restamped = [{**r, "loaded_at": "2026-07-29T02:00:00Z"} for r in rows]
    check(
        "a volatile column's value does not move content",
        fingerprint(stamped, stamped_columns, exclude=["loaded_at"])["content"]
        == fingerprint(restamped, stamped_columns, exclude=["loaded_at"])["content"],
        "a load timestamp that moves every run would otherwise report a change nobody made",
    )
    check(
        "and excluding it does not hide a real change beside it",
        fingerprint(stamped, stamped_columns, exclude=["loaded_at"])["content"]
        != fingerprint(
            [{**r, "loaded_at": "x", "order_total": 99.0} for r in rows],
            stamped_columns,
            exclude=["loaded_at"],
        )["content"],
        "only the named column is excluded; every other value still counts",
    )
    check(
        "a volatile column still counts toward the schema",
        fingerprint(stamped, stamped_columns, exclude=["loaded_at"])["schema"]
        != fingerprint(rows, columns, exclude=["loaded_at"])["schema"],
        "renaming or dropping it is still a change to the table's shape",
    )
    check(
        "excluding a column that is not there changes nothing",
        fingerprint(rows, columns, exclude=["not_a_column"]) == base,
        "a declared exclusion for a column that arrives later is not an error",
    )
    excluded_everything = False
    try:
        content_fingerprint(rows, columns, exclude=columns)
    except ValueError:
        excluded_everything = True
    check(
        "excluding every column is refused",
        excluded_everything,
        "a hash of nothing is identical forever, which reads as 'nothing ever changed'",
    )

    # Cross-process stability, run under a different string-hash seed so a
    # dependence on set or dict ordering would show up rather than pass by luck.
    script = (
        "import json,sys;"
        "sys.path.insert(0, sys.argv[1]);"
        "from fingerprint import fingerprint;"
        "print(json.dumps(fingerprint(json.loads(sys.argv[3]), json.loads(sys.argv[2]))))"
    )
    here = os.path.dirname(os.path.abspath(__file__))
    environment = {**os.environ, "PYTHONHASHSEED": "12345"}
    out = subprocess.run(
        [sys.executable, "-c", script, here, json.dumps(columns), json.dumps(rows)],
        capture_output=True,
        text=True,
        env=environment,
        check=True,
    )
    check(
        "stable across processes",
        json.loads(out.stdout) == base,
        "separate process, PYTHONHASHSEED=12345, identical hashes",
    )

    print()
    if failures:
        print(f"FAILED: {', '.join(failures)}")
        return 1
    print("all properties hold")
    return 0


if __name__ == "__main__":
    raise SystemExit(_self_check())
