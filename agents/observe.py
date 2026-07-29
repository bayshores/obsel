"""Tell obsel what a table holds right now, without being an agent.

obsel learns about a change when the task that made it reports, or when the next
instrumented task READS the changed table and reports what it saw. Between a
write nobody reported and that next read, obsel is blind. This closes that
window: it hashes a table as it stands on disk and posts the fingerprint to
`POST /api/datasets/observe`, which compares it against what the producer
recorded writing and cascades if they disagree.

**obsel still subscribes to nothing.** This is a thing reporting TO obsel, which
is the only way anything in obsel has ever happened. What runs it is somebody
else's business: a cron entry, a change-data-capture bridge, a file watcher, or
a person after editing a table by hand.

It is deliberately not an MCP tool. Agents already send `inputs` with every
completion, which is the same evidence by a better route -- they were reading the
table anyway. This is for the things that are not agents.

The exclusions are read off the board, not declared here. A table's producer
registers which of its columns are volatile, and an observer that ignored that
would hash the table differently from the task that wrote it -- reporting a
change that is only the two sides disagreeing about method.

JSON in on stdin, JSON out on stdout:

    {"table": "clean_orders", "path": "data/clean_orders.json",
     "obselUrl": "http://localhost:3000"}

`path` is optional; without it the table is read from obsel's own data directory
by short name, which is where the demo's tables live.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

# Importable however this is spawned, the same rule `agents/report.py` follows.
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from agents import mcp_core, worker  # noqa: E402
from agents.fingerprint import fingerprint  # noqa: E402
from agents.tables import canonicalise_numbers, load_table  # noqa: E402


def observe(request: Any) -> dict[str, Any]:
    """Hash the table as it stands, post it, and hand back obsel's verdict.

    The verdict is returned verbatim. Nothing here interprets it: obsel decides
    whether the bytes contradict what a producer recorded, and a paraphrase would
    be a second account of that decision.
    """
    if not isinstance(request, dict):
        raise mcp_core.ToolInputError("expected one JSON object on stdin")

    table_name = request.get("table")
    if not isinstance(table_name, str) or not table_name:
        raise mcp_core.ToolInputError("table is required and must be a short table name")

    obsel_url = request.get("obselUrl") or worker.OBSEL_URL
    if not isinstance(obsel_url, str):
        raise mcp_core.ToolInputError("obselUrl must be a string")

    path = request.get("path")
    if path is not None and not isinstance(path, str):
        raise mcp_core.ToolInputError("path must be a string when given")

    if path:
        file = Path(path)
        if not file.is_absolute():
            file = REPO_ROOT / file
        try:
            table = json.loads(file.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise mcp_core.ToolInputError(
                f"no file at {file}. The observer reports what is actually on disk, so a "
                "path that is not there is nothing to report."
            ) from None
        except json.JSONDecodeError as error:
            raise mcp_core.ToolInputError(f"{file} is not valid JSON: {error}") from None
    else:
        table = load_table(table_name)

    if not isinstance(table, dict) or not isinstance(table.get("columns"), list):
        raise mcp_core.ToolInputError(
            f"{table_name} is not a table: expected an object with 'columns' and 'rows'"
        )

    # The producer's own declaration, read off the board exactly as a reading
    # agent reads it. An observer applying its own idea of what is meaningless
    # would produce a fingerprint the producer never could.
    swarm = worker.read_swarm(obsel_url)
    tasks = mcp_core.required_list(swarm["snapshot"], "tasks", "a board read")
    volatile = mcp_core.volatile_by_dataset(tasks)
    dataset_urn = _urn_for(tasks, table_name)

    canonical = canonicalise_numbers(table)
    hashes = fingerprint(
        canonical["rows"],
        canonical["columns"],
        exclude=volatile.get(dataset_urn, []) if dataset_urn else [],
    )

    verdict = worker.post_json(
        f"{obsel_url}/api/datasets/observe",
        {
            "dataset": table_name,
            "fingerprint": hashes,
            "columns": list(canonical["columns"]),
        },
        timeout=worker.MUTATION_TIMEOUT,
        headers=worker.auth_headers(),
    )
    return {"ok": True, "observation": verdict, "computedFingerprint": hashes}


def _urn_for(tasks: Any, table_name: str) -> str | None:
    """The dataset URN for a short name, from any task that mentions it.

    Read off the board rather than built here, for the reason `mcp_core` records:
    obsel constructs URNs so the convention lives in one place, and this module
    only ever parses them back. A table nothing mentions has no exclusions to
    apply, which is the honest answer for a table obsel does not know.
    """
    for record in tasks:
        if not isinstance(record, dict):
            continue
        for urn in list(record.get("writes") or []) + list(record.get("reads") or []):
            if isinstance(urn, str) and mcp_core.dataset_short_name(urn) == table_name:
                return urn
    return None


def main(stdin: Any = None, stdout: Any = None) -> int:
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    try:
        request = json.loads(stdin.read())
    except json.JSONDecodeError as error:
        print(json.dumps({"ok": False, "error": f"stdin is not valid JSON: {error}"}), file=stdout)
        return 1

    try:
        print(json.dumps(observe(request)), file=stdout)
        return 0
    except (mcp_core.ToolInputError, RuntimeError, OSError, ValueError) as error:
        print(json.dumps({"ok": False, "error": str(error)}), file=stdout)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
