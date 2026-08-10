"""The fixed shape of the demo swarm.

Data only -- importing this module reads nothing, writes nothing, and calls no
model. `worker.py` executes a task, `run.py` sequences them, `setup.py` registers
the flow they belong to. Everything about *what* the four agents are lives here,
so the demo can be read in one screen.

The shape:

    clean_orders   reads raw_orders     writes clean_orders
    build_revenue  reads clean_orders   writes daily_revenue
    write_report   reads daily_revenue  writes revenue_report
    write_docs     reads daily_revenue  writes pipeline_docs

All four finish. Then clean_orders re-runs under CHANGE_INSTRUCTION and renames a
column. build_revenue is one hop from that change; write_report and write_docs
are two, and neither of them ever read clean_orders. That cascade is the demo.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from agents import graph

# The DataFlow all four tasks hang off. Matches graph.task_urn's expectations.
#
# OBSEL_FLOW_ID overrides it, and must stay character-for-character identical to
# src/server/datahub/urns.ts's FLOW_ID, which reads the same variable with the same
# default. The two write and read the same entities, so a URN differing by one
# character is a different entity in DataHub rather than an error.
#
# The override exists so obsel's integration tests can register into a real but
# separate DataFlow instead of the demo's, where resetSwarm would clear whatever the
# operator had on screen.
FLOW = os.environ.get("OBSEL_FLOW_ID") or "orders_pipeline"

# Dataset names are namespaced so the demo's tables are obviously the demo's,
# and not mistaken for anything else in a shared DataHub instance.
NAMESPACE = "obsel_demo"

# The table the swarm starts from. Nothing in the swarm produces it.
SEED_TABLE = "raw_orders"


@dataclass(frozen=True)
class AgentTask:
    """One agent's standing job description."""

    name: str
    #: What sort of work this is, for the `shape` printout only. Nothing
    #: dispatches on it: the agent decides how to do the job.
    kind: str  # "clean" | "aggregate" | "write"
    #: The short human name the board leads with, e.g. "Orders cleaner" for
    #: `clean_orders`. Registered into DataHub as `obsel.title`. `name` stays the
    #: code identifier the URN is built from; this is only what a reader sees.
    #: Deliberately distinct from the table each task writes, because a job called
    #: `clean_orders` writing a table called `clean_orders` is its own confusion.
    title: str
    #: The job in one sentence, registered as the DataJob's own description in
    #: DataHub -- so DataHub's UI, obsel's ledger, and the guide all show the
    #: same words. Written for someone who has never seen this pipeline.
    summary: str
    reads: tuple[str, ...]
    writes: str
    #: What this agent is told to do. The demo's `change` step hands the agent a
    #: modified version of this, which is the whole trigger for the cascade.
    instruction: str
    #: The exact columns this task must produce, in order.
    #:
    #: Enforced by the `codex` runner, where the agent writes the table itself and
    #: could otherwise pick slightly different names on two runs. That would move
    #: the schema fingerprint and mark the whole chain stale for no reason -- a
    #: false alarm, which is the failure obsel exists to prevent. So the contract
    #: is stated and checked rather than hoped for.
    output_columns: tuple[str, ...] = ()
    #: Which dataset namespace this task's tables live in, e.g. `obsel_demo` for
    #: the four-agent demo and `obsel_taxi` for the scale swarm. Part of every
    #: dataset URN, so two swarms sharing one DataHub cannot collide on a table
    #: name. Defaulted so the demo's tasks, and every capture taken before this
    #: field existed, mean exactly what they always meant.
    namespace: str = NAMESPACE


TASKS: tuple[AgentTask, ...] = (
    AgentTask(
        name="clean_orders",
        kind="clean",
        title="Orders cleaner",
        summary="cleans the raw orders export into a tidy four-column table",
        reads=(SEED_TABLE,),
        writes="clean_orders",
        output_columns=("order_id", "customer", "order_total", "order_date"),
        instruction=(
            "You are cleaning a raw orders export before anyone reports on it. "
            "Produce a plan that keeps four columns named exactly order_id, customer, "
            "order_total and order_date. Customer names arrive with stray whitespace and "
            # Pinned, not left to judgment. "normalize them" was the whole
            # instruction here, and it is genuinely ambiguous: 'Ben RUIZ' can be
            # read as a name to title-case or as an all-caps surname to leave
            # alone, and both are defensible. Two real runs took the two
            # readings, so the `change` step's output differed from the previous
            # run's in VALUES as well as in the renamed column, obsel correctly
            # reported the change as `both` rather than `schema`, and the demo's
            # "same rows, same values, just the name" beat became untrue. Found
            # by running the demo end to end on 2026-07-21; the harness's own
            # UNEXPECTED assertion is what caught it.
            "inconsistent capitalization: trim the ends, collapse any run of spaces to a "
            "single space, and capitalize the first letter of each word with the rest "
            "lower case, so 'Ben RUIZ' becomes 'Ben Ruiz'. Some order_date values are "
            "full timestamps where a calendar date is wanted. Money should be a number "
            "rounded to two decimal places. Drop any row whose order_total is missing or "
            "is not greater than zero, because those are cancellations and refunds rather "
            "than sales and would understate nothing but corrupt every average."
        ),
    ),
    AgentTask(
        name="build_revenue",
        kind="aggregate",
        title="Daily revenue",
        summary="totals the clean orders into one revenue row per day",
        reads=("clean_orders",),
        writes="daily_revenue",
        output_columns=(
            "order_date",
            "total_revenue",
            "order_count",
            "average_order_value",
        ),
        instruction=(
            "Turn the cleaned orders into one row per calendar day. Each row should carry "
            "the day, the total money taken that day, how many orders made it up, and the "
            "average order value. Name the day column order_date so it still matches the "
            # Pinned, like the cleaner's casing rule and for the same reason: the
            # precision of an average is genuinely a choice, and two real runs made
            # it differently. Measured 2026-07-24, the first live `repair`: the
            # redone table carried averages at full float precision
            # (104.48666666666666) where the previous run had rounded, so the
            # content hash moved, obsel correctly refused to clear the two
            # downstream tasks, and the repair redid all three instead of one.
            # obsel was right both times; the demonstration needs the redo of an
            # unchanged job to be byte-stable, and an unpinned precision cannot be.
            "column it came from. Round the total and the average to two decimal "
            "places. Sort by the day, ascending."
        ),
    ),
    AgentTask(
        name="write_report",
        kind="write",
        title="Revenue report",
        summary="writes the short revenue report an operations lead reads",
        reads=("daily_revenue",),
        writes="revenue_report",
        output_columns=("section", "heading", "text"),
        instruction=(
            "Write a short revenue report for an operations lead who has ninety seconds. "
            "Use the daily revenue table you are given and nothing else. Cover: what the "
            "period totalled, which day was strongest and which weakest with the actual "
            "numbers, and whether order volume or order size explains the difference. "
            "Quote figures exactly as they appear; do not estimate, extrapolate, or invent "
            "a comparison period that is not in the data. Finish with one bottom line."
        ),
    ),
    AgentTask(
        name="write_docs",
        kind="write",
        title="Table docs",
        summary="documents the daily_revenue table for the next engineer",
        reads=("daily_revenue",),
        writes="pipeline_docs",
        output_columns=("section", "heading", "text"),
        instruction=(
            "Document the daily_revenue table for the next engineer who has to use it. "
            "Give one section per column explaining what it holds, its units, and how it "
            "was derived from the orders it came from. Add a section on what the table "
            "deliberately excludes. Describe only columns that are actually present."
        ),
    ),
)


# The demo's money moment. Same agent, same input, one changed requirement --
# which is exactly how this happens in real life: someone upstream renames a
# column for a good reason and nobody downstream is told.
CHANGE_INSTRUCTION = (
    TASKS[0].instruction
    + " One change from last time: the money column must now be named order_total_usd "
    "rather than order_total, so the currency is unambiguous. Everything else about the "
    "cleaning stays the same."
)


# The output contract for the changed run of clean_orders. Differs from that
# task's own output_columns in exactly one name -- which is the whole point, and
# is what moves the schema fingerprint and starts the cascade. Stated here so the
# `change` step can verify the agent actually did the rename instead of trusting
# that it complied.
CHANGE_COLUMNS: tuple[str, ...] = ("order_id", "customer", "order_total_usd", "order_date")


def dataset_urn(short_name: str) -> str:
    """URN for one of the demo's tables. `graph.dataset_urn` takes the full name."""
    return graph.dataset_urn(f"{NAMESPACE}.{short_name}")


def task_dataset_urn(task: AgentTask, short_name: str) -> str:
    """URN for one of THIS task's tables, under the task's own namespace.

    The demo's tasks default to `obsel_demo`, so for them this is `dataset_urn`
    exactly; the scale swarm's tasks carry `obsel_taxi`. Everything in
    `worker.py` goes through here rather than the module-level helper, because a
    worker that hard-coded the demo namespace would report a scale task's
    fingerprints against dataset URNs nothing ever registered, and every
    comparison downstream would silently be a first run.
    """
    return graph.dataset_urn(f"{task.namespace}.{short_name}")


def task_urn(task_name: str) -> str:
    return graph.task_urn(FLOW, task_name)


def flow_urn() -> str:
    """The DataFlow the tasks nest inside. A dataJob URN embeds this whole string."""
    return f"urn:li:dataFlow:({graph.PLATFORM},{FLOW},prod)"


def by_name(task_name: str) -> AgentTask:
    for task in TASKS:
        if task.name == task_name:
            return task
    known = ", ".join(task.name for task in TASKS)
    raise KeyError(f"no demo task named {task_name!r}; known tasks: {known}")


def in_dependency_order() -> tuple[AgentTask, ...]:
    """The order the agents may run in, derived rather than hardcoded.

    A plain Kahn topological sort over "who writes what this one reads". It
    exists so that editing TASKS cannot silently produce a demo that runs an
    agent before its input is written.
    """
    producer_of = {task.writes: task.name for task in TASKS}
    pending = {task.name: task for task in TASKS}
    ordered: list[AgentTask] = []

    while pending:
        ready = [
            task
            for task in pending.values()
            if all(
                producer_of.get(source) is None or producer_of[source] not in pending
                for source in task.reads
            )
        ]
        if not ready:
            raise ValueError(f"demo tasks form a cycle: {sorted(pending)}")
        # Sorted so the order is fixed rather than dependent on dict iteration.
        for task in sorted(ready, key=lambda t: t.name):
            ordered.append(task)
            del pending[task.name]

    return tuple(ordered)


if __name__ == "__main__":
    for step in in_dependency_order():
        print(f"{step.name:<14} {step.kind:<10} reads {', '.join(step.reads):<14} writes {step.writes}")
