"""obsel's MCP server: the door an outside agent walks through to join a swarm.

obsel already speaks MCP in the other direction -- `src/server/datahub/mcp.ts` is
a client of DataHub's MCP server, which is how the `obsel-stale` tag is written.
This is the reverse. Any MCP-capable agent (Claude Code, Cursor, Codex) can now
register the work it is about to do, ask whether its inputs are already known to
be out of date, and report what it produced, without knowing anything about
obsel's HTTP API or DataHub's URN shapes.

The tools:

  check_freshness   before you work: are the tables you are about to read still
                    trustworthy, or has something upstream already invalidated them
  register_task     declare what you read and what you write, once
  announce_start    say you have begun, so obsel does not mark work that is in flight
  report_complete   say what you produced; obsel answers with what it invalidated
  abandon_task      hand a start announcement back after a failure
  read_board        who else is here and what state they are in

Two boundaries, both deliberate:

**Every mutation goes through obsel's HTTP API.** This module does not import
DataHub's SDK and holds no credentials. It cannot write a tag, mark a task, or
touch an entity except by asking obsel to, which means the rules in
`src/server/coordinator/staleness.ts` are the only way anything is ever marked --
there is no second path for an agent to talk itself onto the graph.

**There is no tool that marks or unmarks staleness.** A tool to declare something
fresh would be a tool to silence obsel, and the thing obsel is for is telling you
what you would not otherwise have been told. Staleness is decided by comparing
fingerprints, and the way to clear a mark is to redo the work and report it.

Agents do not compute fingerprints. `report_complete` takes the rows and columns
themselves and hashes them here, on the same `canonicalise_numbers` ->
`fingerprint` path the demo workers use. An agent that handed obsel a hash would
be an agent that could hand obsel the *previous* hash, and obsel would believe it.

Coverage: the decisions live in `agents/mcp_core.py`, checked by
`python3 -m agents.mcp_core` under `pnpm verify`. This file is the wiring, and it
is covered by `tests/live/obsel-mcp.live.test.ts`, which drives a real MCP client
over stdio into a real obsel backed by a real DataHub.

Run it:

    agents/.venv/bin/python -m agents.mcp_server

from the repository root, with `OBSEL_URL` pointing at a running obsel
(default http://localhost:3000).
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Importable from anywhere. An MCP client launches this with whatever working
# directory it happens to have, and `from agents import ...` has to resolve
# regardless -- a server that only starts from one directory is a server that
# fails in a client's config with an import error nobody can read.
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from agents import mcp_core, worker  # noqa: E402 -- must follow the sys.path line

SERVER_NAME = "obsel"
SERVER_VERSION = "0.1.0"

#: Where obsel is listening. Read once at start, like `worker.OBSEL_URL`, so a
#: server and the agents beside it cannot disagree about which obsel they mean.
OBSEL_URL = os.environ.get("OBSEL_URL", "http://localhost:3000")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def build_server(obsel_url: str = OBSEL_URL) -> Any:
    """Wire the six tools. Imported here so the module loads without the SDK.

    The server builds and lists its tools whether or not obsel is reachable.
    Failing at startup would hand the calling agent's MCP client a mute
    connection error with no cause in it; a per-call failure carries
    `worker._send`'s message, which names the URL and how to start obsel.
    """
    from mcp.server.fastmcp import FastMCP

    server = FastMCP(SERVER_NAME)

    @server.tool()
    def check_freshness(reads: list[str]) -> dict[str, Any]:
        """Ask whether the tables you are about to read are still trustworthy.

        Call this before doing any work. Each table gets one of five verdicts:
        `fresh`, `stale` (something upstream changed after its producer finished
        -- the reason is carried verbatim), `in-flight` (a producer is running
        now), `not-yet-produced`, or `no-registered-producer` (nothing in the
        swarm claims to write it: usually a seed table, sometimes a typo, never
        an assurance that it is fine).

        `staleInputs` and `inFlightInputs` name the tables that are a problem. If
        `staleInputs` is not empty, tell your operator which table and why rather
        than silently building on it.

        Args:
            reads: short table names you intend to read, e.g. ["clean_orders"].
        """
        if not reads:
            raise mcp_core.ToolInputError(
                "name at least one table to check. Asking about nothing returns "
                "nothing, which reads like an all-clear."
            )
        swarm = worker.read_swarm(obsel_url)
        tasks = mcp_core.required_list(swarm["snapshot"], "tasks", "a board read")
        return mcp_core.freshness_verdicts(tasks, reads)

    @server.tool()
    def register_task(
        name: str,
        reads: list[str],
        writes: list[str],
        title: str | None = None,
        description: str | None = None,
    ) -> dict[str, Any]:
        """Declare the work you are about to do, and what it is built on.

        obsel creates a real DataJob in DataHub with lineage edges to the tables
        you name, which is what later lets a change upstream find you.

        Use SHORT table names, never URNs. obsel builds the URNs itself so the
        naming convention lives in one place.

        Registering is a one-time declaration, not a way to start a run. If a
        task with this name and exactly this lineage already exists, this returns
        it with `alreadyRegistered: true` and changes nothing -- re-registering
        would clear the recorded fingerprints, and the next completion would then
        look like a first version and mark nothing downstream. To run again,
        call `announce_start` and then `report_complete`.

        A consequence worth knowing: since nothing is written when the task
        already exists, `title` and `description` take effect on the FIRST
        registration only, and a later call carrying a new title returns the
        existing task unchanged. That is the right trade -- both are cosmetic and
        neither enters the staleness decision, while the fingerprints the guard
        protects are the entire basis of it -- but it does mean there is no way to
        rename a task through this tool.

        Args:
            name: a code identifier for this task, e.g. "clean_orders_job".
            reads: short names of the tables this task reads.
            writes: short names of the tables this task writes.
            title: a short human name for the board (60 characters).
            description: this task's standing job in one sentence (300 characters).
        """
        if not name:
            raise mcp_core.ToolInputError("a task needs a name")
        if not writes:
            raise mcp_core.ToolInputError(
                "a task that writes nothing has no output to fingerprint, so "
                "nothing downstream could ever depend on it. Register the table "
                "you produce."
            )

        swarm = worker.read_swarm(obsel_url)
        tasks = mcp_core.required_list(swarm["snapshot"], "tasks", "a board read")
        existing = mcp_core.find_task_by_name(tasks, name)
        if existing is not None and mcp_core.lineage_matches(existing, reads, writes):
            return {"task": existing, "alreadyRegistered": True}

        body: dict[str, Any] = {"name": name, "reads": list(reads), "writes": list(writes)}
        if title:
            body["title"] = title
        if description:
            body["description"] = description

        reply = worker.post_json(f"{obsel_url}/api/tasks/register", body)
        if not isinstance(reply, dict) or "urn" not in reply:
            raise mcp_core.ObselReplyError(
                f"obsel's reply to registering {name!r} carries no task urn: {reply!r:.300}"
            )
        return {"task": reply, "alreadyRegistered": False}

    @server.tool()
    def announce_start(taskUrn: str) -> dict[str, Any]:
        """Tell obsel you have begun, before you write anything.

        Work in flight is never marked stale -- a task that is running will pick
        up its own inputs, so marking it would be a false alarm. Announcing is
        also what lets a person watching the board see that you are working.

        An "already running" error means another agent may hold this task. Stop
        and ask your operator rather than racing it.

        Args:
            taskUrn: the `urn` from `register_task`.
        """
        return {"task": worker.announce_start(taskUrn, obsel_url)}

    @server.tool()
    def report_complete(
        taskUrn: str,
        outputs: dict[str, Any],
        runner: str | None = None,
        ms: float | None = None,
    ) -> dict[str, Any]:
        """Report what you produced. This is what triggers everything obsel does.

        Pass the real rows and columns you wrote. obsel hashes them here, on the
        same path its own workers use -- do not hash anything yourself.

        Report even when you believe nothing changed. An identical result returns
        an empty `changedOutputs` and marks nothing, and that quiet answer is what
        makes the loud ones trustworthy.

        The reply's `affected` lists finished work your completion just
        invalidated, each with the reason and how many hops away it was. Tell
        your operator about it. Do not go and "fix" another agent's work uninvited.

        Args:
            taskUrn: the `urn` from `register_task`.
            outputs: one entry per table you wrote, keyed by SHORT table name:
                {"clean_orders": {"columns": ["id", "total"], "rows": [{"id": 1, "total": 10}]}}
                Every table must be one this task declared it writes.
            runner: optionally, what did the work, e.g. "claude-code 2.1".
            ms: optionally, how long your run took in milliseconds, measured by you.
        """
        record = worker.obsel_task(taskUrn, obsel_url)
        body, fingerprints = mcp_core.completion_body(
            record, outputs, _now(), runner=runner, ms=ms
        )
        coordination = worker.post_json(f"{obsel_url}/api/tasks/complete", body)
        # Read the lists before returning: a reply that lost `affected` must not
        # reach the agent looking like "nothing was invalidated".
        summary = mcp_core.summarise_coordination(coordination)
        return {
            "coordination": coordination,
            "computedFingerprints": fingerprints,
            "summary": summary,
        }

    @server.tool()
    def abandon_task(taskUrn: str) -> dict[str, Any]:
        """Give a start announcement back, because the work behind it died.

        Call this if you announced and then failed. obsel skips running work when
        it walks the graph, so a task left at `running` by a dead agent is
        invisible to every later traversal while the board still shows a healthy
        swarm. That is a false negative, which is the one answer obsel must never
        give.

        `reverted` is false when the task was not running -- abandoning something that
        never announced is not an error, because the caller is already on a failure path
        and a second error there would bury the first.

        Args:
            taskUrn: the `urn` you announced.
        """
        reply = worker.abandon_run(taskUrn, obsel_url)
        # Returned as obsel shaped it: `{task, reverted}` already. Wrapping it again in
        # a `task` key put the record one level deeper than the docstring above promised.
        return {
            "task": mcp_core.required_dict(reply, "task", "abandoning a task"),
            "reverted": mcp_core.required(reply, "reverted", "abandoning a task"),
        }

    @server.tool()
    def read_board() -> dict[str, Any]:
        """The swarm as obsel currently holds it: who is here and what state they are in.

        Orientation, not a decision. Use `check_freshness` to decide whether it is
        safe to build on a table; this is for seeing the shape of the swarm.
        Fingerprints are omitted deliberately -- a hash tells you nothing you can act on.
        """
        return mcp_core.board_summary(worker.read_swarm(obsel_url))

    return server


def main() -> int:
    build_server().run(transport="stdio")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
