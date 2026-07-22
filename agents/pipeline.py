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

from dataclasses import dataclass

from agents import graph

# The DataFlow all four tasks hang off. Matches graph.task_urn's expectations.
FLOW = "orders_pipeline"

# Dataset names are namespaced so the demo's tables are obviously the demo's,
# and not mistaken for anything else in a shared DataHub instance.
NAMESPACE = "obsel_demo"

# The one model these agents use. Named in every printed line and recorded in
# every cached plan, because a demo that is vague about which model did the work
# is a demo a judge cannot check.
MODEL = "gpt-5.6"

# The table the swarm starts from. Nothing in the swarm produces it.
SEED_TABLE = "raw_orders"


@dataclass(frozen=True)
class AgentTask:
    """One agent's standing job description."""

    name: str
    #: Which applier turns the model's plan into a table. See `worker.py`.
    kind: str  # "clean" | "aggregate" | "write"
    reads: tuple[str, ...]
    writes: str
    #: What this agent is told to do. Part of the plan cache key, so changing it
    #: is what makes the demo's `change` step call the model again.
    instruction: str


TASKS: tuple[AgentTask, ...] = (
    AgentTask(
        name="clean_orders",
        kind="clean",
        reads=(SEED_TABLE,),
        writes="clean_orders",
        instruction=(
            "You are cleaning a raw orders export before anyone reports on it. "
            "Produce a plan that keeps four columns named exactly order_id, customer, "
            "order_total and order_date. Customer names arrive with stray whitespace and "
            "inconsistent capitalisation, so normalise them. Some order_date values are "
            "full timestamps where a calendar date is wanted. Money should be a number "
            "rounded to two decimal places. Drop any row whose order_total is missing or "
            "is not greater than zero, because those are cancellations and refunds rather "
            "than sales and would understate nothing but corrupt every average."
        ),
    ),
    AgentTask(
        name="build_revenue",
        kind="aggregate",
        reads=("clean_orders",),
        writes="daily_revenue",
        instruction=(
            "Turn the cleaned orders into one row per calendar day. Each row should carry "
            "the day, the total money taken that day, how many orders made it up, and the "
            "average order value. Name the day column order_date so it still matches the "
            "column it came from. Sort by the day, ascending."
        ),
    ),
    AgentTask(
        name="write_report",
        kind="write",
        reads=("daily_revenue",),
        writes="revenue_report",
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
        reads=("daily_revenue",),
        writes="pipeline_docs",
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


def dataset_urn(short_name: str) -> str:
    """URN for one of the demo's tables. `graph.dataset_urn` takes the full name."""
    return graph.dataset_urn(f"{NAMESPACE}.{short_name}")


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
