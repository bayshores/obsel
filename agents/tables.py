"""The pipeline's tables on disk, and the one rule that makes them hashable.

Every table is `{"columns": [...], "rows": [{...}, ...]}` in `.obsel/data/`.

`canonicalise_numbers` is why a re-run can mark nothing. The agent decides what
the numbers are; this module decides how they are written down, so the same
table twice hashes the same twice. Measured 2026-07-22 across four live runs
over the identical seed: one wrote a money value `217` where the others wrote
`217.0`.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent

Table = dict[str, Any]  # {"columns": [...], "rows": [...]}



def data_dir(root: Path = REPO_ROOT) -> Path:
    return root / ".obsel" / "data"


def table_path(short_name: str, root: Path = REPO_ROOT) -> Path:
    return data_dir(root) / f"{short_name}.json"


def load_table(short_name: str, root: Path = REPO_ROOT) -> Table:
    path = table_path(short_name, root)
    if not path.exists():
        raise FileNotFoundError(
            f"{short_name} has not been produced yet (expected {path}). "
            "Run the agents in dependency order, or `python -m agents.run reset` "
            "to start over."
        )
    table = json.loads(path.read_text(encoding="utf-8"))
    if "columns" not in table or "rows" not in table:
        raise ValueError(f"{path} is not a table: expected 'columns' and 'rows' keys")
    return table


# Above this magnitude a float no longer holds every integer, so two distinct
# ints can share one float. Only below it does int(float) return the integer the
# float was written from.
EXACT_INTEGER_LIMIT = 2**53


def _canonical_number(value: Any) -> Any:
    """The one serialized form of a single value. Anything else is returned as it
    came in, so a sentinel string or a bool changes nothing about its neighbors.

    - A bool is not a number here. `bool` is a subclass of `int` in Python, and
      writing `True` as `1` would report a real difference as none.
    - An int is left alone at any magnitude. No float round trip, so a large id
      cannot lose precision on the way through.
    - A whole float below `EXACT_INTEGER_LIMIT` becomes that int, which is what
      makes `217` and `217.0` one value. Above the limit, and for any fractional
      float, the float is kept: converting it would claim a precision the float
      does not carry.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer() and abs(value) <= EXACT_INTEGER_LIMIT:
        return int(value)
    return value


def canonicalise_numbers(table: Table) -> Table:
    """Put every number into one serialized form, decided value by value.

    Part of the contract the worker holds the agent to, alongside the column
    names. The agent decides *what* the numbers are; this decides how they are
    written down, because otherwise the same number written two ways hashes two
    ways.

    Measured on 2026-07-22, and the reason this exists: across four live runs of
    `clean_orders` over the identical seed, `order_id` 1012's money value came out
    as `217` three times and `217.0` once. Same value, different bytes, so the
    content fingerprint moved and obsel correctly reported a change nobody made.
    It broke two demo steps at once -- `rerun-same` saw a re-run that was not
    identical, and `change`'s pure column rename reported `both` instead of
    `schema` because the values appeared to have moved too.

    The rule is per VALUE, and derived from the value, never declared: a whole
    number is written as an integer, a fractional one as a float, and anything
    that is not a number is written as it arrived. Both spellings of the run
    above therefore land on the integer `217`, and the `233.08` beside it decides
    nothing about them.

    Per value rather than per column, and each half of that is a defect this file
    used to have. The rule was once "canonicalize a column only if every value in
    it is a number, and float the whole column unless every value is whole", so:

    - one `"N/A"` anywhere in the column switched canonicalization off for the
      column, and `217` against `217.0` hashed differently again -- a change
      nobody made, reported against every finished task downstream; and
    - in a column holding one fractional value, every int in it went through
      `float()`, so two distinct ids above `EXACT_INTEGER_LIMIT` collapsed to one
      value and a real change carried an identical content hash. That is the
      direction that must never happen.

    Derived rather than declared on purpose. A declaration would have to be
    restated for `change`, which renames `order_total` to `order_total_usd` --
    and a contract that has to be edited in step with the thing it constrains is
    a contract that will be forgotten in exactly the step that matters.

    **This does not weaken what obsel treats as evidence.** obsel still hashes
    bytes and still calls two different byte sequences different. What changed is
    upstream of it: the agent's output is now written down one way, so a genuine
    change in the data is the only thing that can move the hash. A value that
    really does gain a fraction is still written as a float and is still
    reported, because that is a real change to the data.

    One migration consequence, in the over-marking direction. A column that used
    to canonicalize through the all-numeric float branch -- ints beside floats --
    now keeps its ints as ints, so its content hash differs from one recorded
    before this change. The first re-run against such a fingerprint reports a
    change once and marks the finished work below it stale. Those flags clear the
    only way any flag clears: through the redo.
    """
    columns = list(table["columns"])
    rows = [dict(row) for row in table["rows"]]

    # Declared columns only. A key a row carries that the table does not declare
    # is not hashed and is not this function's to rewrite.
    for row in rows:
        for column in columns:
            if column in row:
                row[column] = _canonical_number(row[column])

    return {**table, "columns": columns, "rows": rows}


def save_table(short_name: str, table: Table, root: Path = REPO_ROOT) -> Path:
    path = table_path(short_name, root)
    path.parent.mkdir(parents=True, exist_ok=True)
    # sort_keys for a byte-stable file; the fingerprint does not depend on it,
    # but a diffable artifact is worth having when something looks wrong.
    path.write_text(json.dumps(table, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path
