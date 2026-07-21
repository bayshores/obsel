"""obsel's connection to DataHub: register an agent task, and find what a change breaks.

Both halves are verified against a live DataHub (GMS v1.5.0.6, quickstart) on
2026-07-21. See docs/environment-findings.md sections 7 and 8.

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
import urllib.parse
import urllib.request
from dataclasses import dataclass

GMS_URL = os.environ.get("DATAHUB_GMS_URL", "http://localhost:8080")
PLATFORM = "obsel"

# DataHub's own edge names on the dataJobInputOutput aspect.
READS = "Consumes"
WRITES = "Produces"


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
    if not graph.exists(urn):
        raise RuntimeError(f"task {task} did not land in DataHub")

    return urn


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
