"""The Python reference implementation of obsel's two DataHub operations.

Both halves were verified against a live DataHub (GMS v1.5.0.6, quickstart) on
2026-07-21. See docs/environment-findings.md sections 7 and 8.

Which of them the demo actually runs is different, and worth being plain about:

- `downstream_of` is the traversal, and it is the proof of the core mechanism.
- `register_task` is **not** how the demo registers anything. `agents/run.py
  register` posts to obsel's `/api/tasks/register`, so one implementation owns
  registration and every later write to the same task. `register_task` is kept as
  the reference implementation the architecture doc points at.

The traversal deliberately uses GET /relationships rather than GraphQL's
searchAcrossLineage. searchAcrossLineage is served from a search index that lags
by minutes, and obsel reasons about tasks registered seconds ago -- it would
return an empty list, indistinguishable from "nothing is affected". /relationships
reads the graph store and is immediate. It is one hop per call, so the cascade is
walked here.
"""

from __future__ import annotations

import json
import os
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass

GMS_URL = os.environ.get("DATAHUB_GMS_URL", "http://localhost:8080")
PLATFORM = "obsel"

# DataHub's own edge names on the dataJobInputOutput aspect.
READS = "Consumes"
WRITES = "Produces"

# How long to wait for an asynchronous write to become readable before calling it a
# failure. Matches `agents/setup.py`, which polls the same way for the same reason:
# a single immediate read-back reports failures that are only delays, and retrying
# the write on that false failure writes twice. See environment-findings.md 6.1.
CONFIRM_TIMEOUT_SECONDS = 60.0
CONFIRM_POLL_SECONDS = 0.5


# --------------------------------------------------------------------------
# URNs
# --------------------------------------------------------------------------


def dataset_urn(name: str) -> str:
    return f"urn:li:dataset:(urn:li:dataPlatform:{PLATFORM},{name},PROD)"


def task_urn(flow: str, task: str) -> str:
    return f"urn:li:dataJob:(urn:li:dataFlow:({PLATFORM},{flow},prod),{task})"


def task_name(urn: str) -> str:
    """A dataJob urn nests a dataFlow urn, so the task id is the LAST
    comma-separated segment, not the second to last."""
    return urn.split(",")[-1].rstrip(")")


# --------------------------------------------------------------------------
# Registering a task
# --------------------------------------------------------------------------


def register_task(flow: str, task: str, reads: list[str], writes: list[str]) -> str:
    """Put an agent task into DataHub, wired to the data it reads and writes.

    No MCP tool creates entities, so this goes through the Python SDK emitter.
    Returns the task's urn.

    **Not the path the demo takes.** `agents/run.py register` posts to obsel's own
    `/api/tasks/register`, so registration and every later status write go through
    one implementation and cannot drift on URN shape or on which aspects get set.
    This function is the Python reference implementation that was verified against a
    live DataHub on 2026-07-21 and is what `docs/architecture.md` points at; it is
    kept runnable rather than deleted so that verification stays reproducible.
    """
    from datahub.emitter.mcp import MetadataChangeProposalWrapper
    from datahub.ingestion.graph.client import DataHubGraph, DatahubClientConfig
    from datahub.metadata.schema_classes import (
        DataJobInfoClass,
        DataJobInputOutputClass,
    )

    graph = DataHubGraph(DatahubClientConfig(server=GMS_URL))
    urn = task_urn(flow, task)

    graph.emit(
        MetadataChangeProposalWrapper(
            entityUrn=urn,
            aspect=DataJobInfoClass(name=task, type="COMMAND", description="obsel agent task"),
        )
    )
    graph.emit(
        MetadataChangeProposalWrapper(
            entityUrn=urn,
            aspect=DataJobInputOutputClass(inputDatasets=reads, outputDatasets=writes),
        )
    )

    # A rejected (entityType, aspectName) pair can be dropped silently, so confirm
    # rather than trusting the emit. See environment-findings.md section 8 item 5.
    #
    # Confirmed by polling, never by one immediate read. DataHub applies these
    # writes asynchronously (section 6.1), so a single `exists()` here returns false
    # for a write that is merely still settling -- and the natural response to that
    # false failure is to emit again, which writes the entity twice.
    confirm_exists(
        graph,
        urn,
        f"task {task} was emitted but was still not readable after "
        f"{CONFIRM_TIMEOUT_SECONDS:.0f}s, so it is not in the lineage graph and a "
        f"change upstream of it would traverse straight past it",
    )

    return urn


def confirm_exists(
    graph,
    urn: str,
    failure_message: str,
    timeout: float = CONFIRM_TIMEOUT_SECONDS,
    poll: float = CONFIRM_POLL_SECONDS,
) -> float:
    """Poll `graph.exists(urn)` until it is true. Returns seconds waited.

    `exists()` rather than `GET /entities/<urn>`: that endpoint fabricates a
    well-formed response for any syntactically valid URN, including invented ones,
    so it can never return false (environment-findings.md section 1).
    """
    started = time.perf_counter()
    deadline = started + timeout
    while True:
        if graph.exists(urn):
            return time.perf_counter() - started
        if time.perf_counter() >= deadline:
            raise RuntimeError(failure_message)
        time.sleep(poll)


# --------------------------------------------------------------------------
# Finding what a change breaks
# --------------------------------------------------------------------------


def _related(urn: str, direction: str, edge: str) -> list[str]:
    query = urllib.parse.urlencode({"urn": urn, "direction": direction, "types": edge})
    with urllib.request.urlopen(f"{GMS_URL}/relationships?{query}", timeout=20) as response:
        payload = json.loads(response.read())
    return [edge["entity"] for edge in payload.get("relationships", [])]


@dataclass(frozen=True)
class Affected:
    """A task reached by walking downstream from a change."""

    task: str
    hops: int

    @property
    def direct(self) -> bool:
        return self.hops == 1


def downstream_of(changed_dataset: str) -> list[Affected]:
    """Every task transitively affected by a change to `changed_dataset`.

    Alternates direction by entity type, because that is how the lineage is shaped:

        dataset --(incoming Consumes)--> tasks that read it
        task    --(outgoing Produces)--> datasets it wrote  ->  repeat

    Nearest first. Carries a visited set, so a cyclic graph terminates rather
    than hanging -- and so a task reached by two different paths is reported once,
    at its shortest distance from the change.
    """
    affected: list[Affected] = []
    seen: set[str] = {changed_dataset}
    frontier = [changed_dataset]
    hops = 0

    while frontier:
        hops += 1
        next_frontier: list[str] = []

        for dataset in frontier:
            for task in _related(dataset, "INCOMING", READS):
                if task in seen:
                    continue
                seen.add(task)
                affected.append(Affected(task=task, hops=hops))

                for produced in _related(task, "OUTGOING", WRITES):
                    if produced not in seen:
                        seen.add(produced)
                        next_frontier.append(produced)

        frontier = next_frontier

    return affected
