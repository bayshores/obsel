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


def _is_whole(value: Any) -> bool:
    """True for a number with nothing after the decimal point. Ints without a
    float round-trip, so a large id cannot lose precision on the way through."""
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and value.is_integer()


def _is_number(value: Any) -> bool:
    # bool is a subclass of int in Python, and a True/False column is not numeric.
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def canonicalise_numbers(table: Table) -> Table:
    """Put each numeric column into one serialised form, decided by its own values.

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

    The rule is per column and derived from the data, never declared: if every
    value in a column is a whole number it is written as an integer, and
    otherwise every value in that column is written as a float. Both spellings of
    the run above therefore land on floats, because `233.08` sits in the same
    column and forces it.

    Derived rather than declared on purpose. A declaration would have to be
    restated for `change`, which renames `order_total` to `order_total_usd` --
    and a contract that has to be edited in step with the thing it constrains is
    a contract that will be forgotten in exactly the step that matters.

    **This does not weaken what obsel treats as evidence.** obsel still hashes
    bytes and still calls two different byte sequences different. What changed is
    upstream of it: the agent's output is now written down one way, so a genuine
    change in the data is the only thing that can move the hash. A column that
    really does gain a fractional value still flips to float and is still
    reported, because that is a real change to the data.
    """
    columns = list(table["columns"])
    rows = [dict(row) for row in table["rows"]]

    for column in columns:
        present = [row[column] for row in rows if row.get(column) is not None]
        if not present or not all(_is_number(value) for value in present):
            continue

        whole = all(_is_whole(value) for value in present)
        for row in rows:
            value = row.get(column)
            if value is None:
                continue
            row[column] = int(value) if whole else float(value)

    return {**table, "columns": columns, "rows": rows}


def save_table(short_name: str, table: Table, root: Path = REPO_ROOT) -> Path:
    path = table_path(short_name, root)
    path.parent.mkdir(parents=True, exist_ok=True)
    # sort_keys for a byte-stable file; the fingerprint does not depend on it,
    # but a diffable artifact is worth having when something looks wrong.
    path.write_text(json.dumps(table, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path
