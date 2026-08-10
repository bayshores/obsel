"""The raw table the demo swarm starts from.

Synthetic, and generated from a fixed seed so every run of the demo -- on any
machine, in front of any judge -- starts from byte-identical input. That matters
more here than it usually would: obsel's central claim is that an identical
re-run marks nothing stale, and that claim is only testable if "identical" is
reproducible.

The rows are deliberately dirty in ordinary ways -- inconsistent capitalization,
stray whitespace, a few missing or non-positive totals, timestamps where a date
belongs. The first agent has to make real decisions about them rather than copy
a clean table across.
"""

from __future__ import annotations

import random
from typing import Any

SEED = 20260721

COLUMNS = ["order_id", "customer", "order_total", "order_date"]

# Names are invented. Written in mixed case on purpose; normalizing them is part
# of the cleaning agent's job.
_CUSTOMERS = [
    "ada okafor",
    "Ben RUIZ",
    "cai zhou",
    "  Dara Lindqvist",
    "eli nakamura  ",
    "Fen Abara",
    "gus MARCHETTI",
    "Hana Sorensen",
    "iris kovac",
    "Joss Adeyemi",
    "kit ferreira",
    "Lena Bhattacharya",
]

_DATES = [
    "2026-07-13",
    "2026-07-14",
    "2026-07-15",
    "2026-07-16",
    "2026-07-17",
]


def raw_orders(row_count: int = 50, seed: int = SEED) -> dict[str, Any]:
    """A table in the on-disk shape the agents exchange: columns plus rows.

    `random.Random(seed)` is the Mersenne Twister, whose sequence for a given
    integer seed is fixed across CPython versions, so this is reproducible rather
    than merely repeatable within one process.
    """
    rng = random.Random(seed)
    rows: list[dict[str, Any]] = []

    for index in range(row_count):
        order_id = 1000 + index
        customer = rng.choice(_CUSTOMERS)
        date = rng.choice(_DATES)

        # A timestamp where the column is called order_date: common, and the
        # cleaning agent has to decide what to do about it.
        order_date: str = date
        if index % 7 == 3:
            order_date = f"{date}T{rng.randrange(0, 24):02d}:{rng.randrange(0, 60):02d}:00Z"

        total: Any = round(rng.uniform(8.0, 240.0), 2)
        if index % 11 == 5:
            total = None  # missing
        elif index % 13 == 4:
            total = 0.0  # a cancelled order that was never removed
        elif index % 17 == 9:
            total = -round(rng.uniform(5.0, 60.0), 2)  # a refund recorded as an order

        rows.append(
            {
                "order_id": order_id,
                "customer": customer,
                "order_total": total,
                "order_date": order_date,
            }
        )

    return {"columns": list(COLUMNS), "rows": rows}


if __name__ == "__main__":
    import json

    table = raw_orders()
    bad = sum(
        1
        for row in table["rows"]
        if row["order_total"] is None or float(row["order_total"]) <= 0
    )
    print(f"{len(table['rows'])} rows, {bad} of them missing or non-positive totals")
    print(json.dumps(table["rows"][:3], indent=2))
