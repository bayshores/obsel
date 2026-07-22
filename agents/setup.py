"""One-time setup: put obsel's vocabulary into DataHub before the demo runs.

This file exists because of a hard limit measured on a live instance and written
up in `docs/environment-findings.md` section 6.2: **obsel cannot mint a tag at
runtime.** Open-source DataHub's MCP surface has `add_tags` but no `create_tag`,
and applying a tag URN that is not already an entity is rejected. So if
`urn:li:tag:obsel-stale` does not exist before the swarm runs, obsel detects
staleness correctly and then fails to record any of it -- the exact silent
failure the whole project is trying to prevent.

Creating entities needs the Python SDK, which MCP cannot do, so setup runs here
rather than through an agent.

Two further things this file is careful about:

- DataHub writes are asynchronous (section 6.1). A single read-back immediately
  after an emit returns false failures, and retrying on a false failure
  double-writes. Each write is confirmed by polling `graph.exists()` with a
  bounded timeout instead.
- `GET /entities/<urn>` fabricates a well-formed response for any syntactically
  valid URN, including invented ones (section 1). `graph.exists()` is the only
  existence predicate here that can return false.

Run: `python -m agents.setup`
"""

from __future__ import annotations

import time

from agents import graph, pipeline

STALE_TAG_URN = "urn:li:tag:obsel-stale"

STALE_TAG_NAME = "obsel-stale"

STALE_TAG_DESCRIPTION = (
    "Applied by obsel to an agent task that finished successfully and was then "
    "invalidated by a later change to something it was built on. The task is not "
    "failed and its output is not corrupt -- it is answering a question about data "
    "that has since moved. The dataset whose change caused it, the task that "
    "produced that dataset, the distance in hops, whether the columns or the rows "
    "moved, and a plain-English reason are all recorded on the task itself under "
    "the obsel.stale.* custom properties. Removing this tag by hand is safe; obsel "
    "reapplies it only if the same output changes again."
)

FLOW_DESCRIPTION = (
    "A swarm of AI agents building a small orders pipeline, coordinated by obsel. "
    "Each task in this flow is one agent; its Consumes and Produces edges are the "
    "data it actually read and wrote."
)

# How long to wait for an asynchronous write to become readable before calling it
# a failure. Round-trips measured on this stack land well inside this; the budget
# is deliberately generous because the alternative -- declaring failure early --
# leads to a retry that writes twice.
CONFIRM_TIMEOUT_SECONDS = 60.0
CONFIRM_POLL_SECONDS = 0.5


def _client():
    from datahub.ingestion.graph.client import DataHubGraph, DatahubClientConfig

    return DataHubGraph(DatahubClientConfig(server=graph.GMS_URL))


def confirm_landed(client, urn: str, timeout: float = CONFIRM_TIMEOUT_SECONDS) -> float:
    """Poll until `urn` is readable. Returns seconds waited. Raises on timeout."""
    started = time.perf_counter()
    deadline = started + timeout
    while True:
        if client.exists(urn):
            return time.perf_counter() - started
        if time.perf_counter() >= deadline:
            raise RuntimeError(
                f"{urn} was written but was still not readable after {timeout:.0f}s. "
                "Setup is incomplete; do not run the demo, because obsel would detect "
                "staleness and silently fail to record it."
            )
        time.sleep(CONFIRM_POLL_SECONDS)


def ensure_stale_tag(client) -> tuple[bool, float]:
    """Create the obsel-stale tag if it is not already there.

    Returns (was_already_present, seconds_waited_for_confirmation).
    """
    from datahub.emitter.mcp import MetadataChangeProposalWrapper
    from datahub.metadata.schema_classes import TagPropertiesClass

    already = client.exists(STALE_TAG_URN)

    # Emitted even when it already exists, so an edited description reaches
    # DataHub on a re-run. The write is additive and idempotent.
    client.emit(
        MetadataChangeProposalWrapper(
            entityUrn=STALE_TAG_URN,
            aspect=TagPropertiesClass(
                name=STALE_TAG_NAME,
                description=STALE_TAG_DESCRIPTION,
            ),
        )
    )
    return already, confirm_landed(client, STALE_TAG_URN)


def ensure_flow(client) -> tuple[bool, float]:
    """Create the DataFlow the four agent tasks nest inside."""
    from datahub.emitter.mcp import MetadataChangeProposalWrapper
    from datahub.metadata.schema_classes import DataFlowInfoClass

    urn = pipeline.flow_urn()
    already = client.exists(urn)

    client.emit(
        MetadataChangeProposalWrapper(
            entityUrn=urn,
            aspect=DataFlowInfoClass(
                name=pipeline.FLOW,
                description=FLOW_DESCRIPTION,
                project="obsel",
            ),
        )
    )
    return already, confirm_landed(client, urn)


def main() -> int:
    print(f"obsel setup against {graph.GMS_URL}")
    print()

    client = _client()
    failures: list[str] = []

    steps = (
        ("tag", STALE_TAG_URN, ensure_stale_tag),
        ("flow", pipeline.flow_urn(), ensure_flow),
    )

    for label, urn, step in steps:
        try:
            already, waited = step(client)
        except Exception as error:  # noqa: BLE001 - the message is the whole point
            print(f"  FAILED  {label}  {urn}")
            print(f"          {error}")
            failures.append(label)
            continue
        state = "already present, description refreshed" if already else "created"
        print(f"  ok      {label}  {urn}")
        print(f"          {state}, confirmed readable after {waited * 1000:.0f} ms")

    print()
    if failures:
        # Loud on purpose. A missing tag does not break anything visibly at run
        # time -- it just means every stale mark is quietly dropped.
        print(f"SETUP FAILED: {', '.join(failures)}")
        print("Do not run the demo until this succeeds. obsel would detect staleness")
        print("and be unable to record it, which looks identical to nothing being wrong.")
        return 1

    print("Setup complete. obsel can now apply its stale marks.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
