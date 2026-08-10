"""Report a table to obsel on behalf of a person, not an agent.

The page's bench lets somebody edit a table by hand and hand it to obsel.
This is the process that does it, spawned by `POST /api/tasks/report` exactly
the way `src/server/runner/launcher.ts` spawns a demo step.

**This module exists so that the browser never hashes anything.** obsel decides
staleness by comparing fingerprints, so a second implementation of the
fingerprint would be a second answer to the only question obsel exists to
answer -- `agents/mcp_core.py` says so at the top of the file, and a TypeScript
port for the browser's convenience would be exactly the drift it warns about.
So the bench's table takes the same road every agent's table takes:
`mcp_core.completion_body`, which canonicalizes the numbers and calls
`agents/fingerprint.py`, and then obsel's own `POST /api/tasks/complete`.

There is nothing here that an agent could not do, and nothing an agent can do
that is missing. In particular there is **no way to clear a flag**: this reports
work, and what obsel does about that report is obsel's decision. A person at the
bench is standing in for the agent, and stands under the same rules.

JSON in on stdin, JSON out on stdout, one object each way. stdin rather than
argv because a table is not small and argv is; and it means no shell, no
quoting, and no table content on a process list.

    {"taskUrn": "...", "outputs": {"clean_expenses": {"columns": [...], "rows": [...]}},
     "announce": true, "obselUrl": "http://localhost:3000"}

Every failure prints `{"ok": false, "error": ...}` and exits 1, because the
caller is a route that has to put a sentence on screen. A traceback on stderr
would reach the browser as "obsel answered 500".
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Importable however this is spawned. The route sets cwd to the repository root,
# but a module that only imports from one directory is a module that fails with
# an import error nobody can read -- `agents/mcp_server.py` says the same.
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from agents import mcp_core, worker  # noqa: E402


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def report(request: Any) -> dict[str, Any]:
    """Announce, hash, post, and hand back obsel's own answer.

    `announce` defaults true and the default is the honest one. A person editing
    a table at the bench IS the agent for that task, and obsel's rule is that
    work in flight is never marked -- so the task passes through `running` the
    way any other agent's would. Skipping it would record a completion for work
    obsel was never told had begun.

    The reply carries obsel's `coordination` verbatim. Nothing here summarizes
    what was invalidated, because the board reads that off the swarm a second
    later and a paraphrase would be a second account of it.
    """
    if not isinstance(request, dict):
        raise mcp_core.ToolInputError("expected one JSON object on stdin")

    task_urn = request.get("taskUrn")
    if not isinstance(task_urn, str) or not task_urn:
        raise mcp_core.ToolInputError("taskUrn is required and must be a string")

    outputs = request.get("outputs")
    if not isinstance(outputs, dict):
        raise mcp_core.ToolInputError("outputs must be an object keyed by short table name")

    obsel_url = request.get("obselUrl") or worker.OBSEL_URL
    if not isinstance(obsel_url, str):
        raise mcp_core.ToolInputError("obselUrl must be a string")

    # One board read: the task's own record, and the volatile declarations every
    # table's producer made. A table typed by hand has to hash the same way the
    # agent that owns it would hash it, or the two disagree about one table.
    swarm = worker.read_swarm(obsel_url)
    tasks = mcp_core.required_list(swarm["snapshot"], "tasks", "a board read")
    record = next(
        (entry for entry in tasks if isinstance(entry, dict) and entry.get("urn") == task_urn),
        None,
    )
    if record is None:
        raise mcp_core.ToolInputError(
            f"obsel has no task {task_urn}. Register it before reporting a table for it."
        )

    if request.get("announce", True):
        worker.announce_start(task_urn, obsel_url)

    # `runner` and `ms` are deliberately not sent. They are display material for
    # a run somebody measured, and nobody measured this one: the person typed a
    # table. Inventing a duration would put a number on the board that was never
    # taken, which is the one thing this repository's copy rules forbid outright.
    body, fingerprints = mcp_core.completion_body(
        record, outputs, _now(), volatile=mcp_core.volatile_by_dataset(tasks)
    )

    # The token comes from the environment alone, never from the stdin request.
    # `obselUrl` rides stdin because the origin is per-request; the token is not,
    # and `reporter.ts` already spreads the server's own environment into this
    # process, so a second transport for a secret would add surface and no reach.
    coordination = worker.post_json(
        f"{obsel_url}/api/tasks/complete", body, timeout=worker.MUTATION_TIMEOUT,
        headers=worker.auth_headers(),
    )
    return {"ok": True, "coordination": coordination, "computedFingerprints": fingerprints}


def main(stdin: Any = None, stdout: Any = None) -> int:
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    try:
        request = json.loads(stdin.read())
    except json.JSONDecodeError as error:
        print(json.dumps({"ok": False, "error": f"stdin is not valid JSON: {error}"}), file=stdout)
        return 1

    try:
        print(json.dumps(report(request)), file=stdout)
        return 0
    except mcp_core.ToolInputError as error:
        # The caller's own mistake, phrased for the person who made it: every
        # ToolInputError in mcp_core names the table and what to do instead.
        print(json.dumps({"ok": False, "error": str(error)}), file=stdout)
        return 1
    except (RuntimeError, OSError, ValueError) as error:
        print(json.dumps({"ok": False, "error": str(error)}), file=stdout)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
