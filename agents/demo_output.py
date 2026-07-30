"""How the demo prints, how it declares its tasks, and how it reads obsel's answers.

All three are here because all three are guards, and because `run_demo.py` and
`run_scale.py` must not be able to do any of them differently. Every timing
printed by the demo is measured with `time.perf_counter()` around the thing
being timed; nothing says "instant". A reply obsel never sent is refused rather
than read as an empty list, because `affected: []` means "nothing downstream was
invalidated", which is the one wrong answer that looks exactly like everything
being fine. And a registration obsel filed under a urn the agents did not expect
stops the caller, because lineage traversal starts from the urn and would walk
straight past the task.
"""

from __future__ import annotations

import time
from typing import Any, Callable, Sequence

from pathlib import Path

from agents import pipeline, seed_data, worker

REPO_ROOT = worker.REPO_ROOT


# --------------------------------------------------------------------------
# Printing
# --------------------------------------------------------------------------


def _rule(title: str) -> None:
    print()
    print(title)
    print("-" * max(len(title), 60))


# --------------------------------------------------------------------------
# Reading obsel's answers
# --------------------------------------------------------------------------


class Unexpected(RuntimeError):
    """obsel's answer does not support the claim the command was about to print.

    Separate from a plain RuntimeError so `main` can label it, because "the demo
    could not run" and "the demo ran and obsel is wrong" are different problems and
    an operator running the demo has to tell them apart.
    """


def _required_list(reply: dict[str, Any], key: str, where: str) -> list[Any]:
    """One list out of an obsel reply, or an error naming what was missing.

    Never `reply.get(key) or []`. That turns a reply obsel never sent into an
    empty list, and an empty list here means "nothing was affected" -- the one
    wrong answer that looks exactly like everything being fine. A reply that does
    not carry the key has not told us anything, and is reported as such.
    """
    if not isinstance(reply, dict):
        raise Unexpected(f"obsel's reply to {where} is not an object: {reply!r:.300}")
    if key not in reply:
        raise Unexpected(
            f"obsel's reply to {where} has no {key!r} key "
            f"(it carries: {', '.join(sorted(reply)) or 'nothing'}). "
            f"Reading a missing key as zero would turn a broken reply into a pass."
        )
    value = reply[key]
    if not isinstance(value, list):
        raise Unexpected(
            f"obsel's reply to {where} has {key!r} as {type(value).__name__}, not a list"
        )
    return value


def missing_names(board_tasks: list[Any], expected: list[tuple[str, str]]) -> list[str]:
    """Which of `expected` obsel has no record of, in the order given.

    `expected` is (name, urn) pairs; the urn is what decides, because the name is
    the caller's word for a task and the urn is what obsel filed it under.

    Pure on purpose. A run that registers what is missing has to know exactly
    what is missing: registering a task obsel already holds re-declares it, and
    a re-declaration sets `obsel.status` back to `registered`, which on a board
    that has already run would discard the finished state the page reads. So the
    set this returns is the set that gets registered, and nothing wider.
    """
    present = {
        record.get("urn") for record in board_tasks if isinstance(record, dict)
    }
    return [name for name, urn in expected if urn not in present]


def register_one(
    obsel_url: str,
    *,
    name: str,
    reads: list[str],
    writes: list[str],
    description: str,
    title: str,
    expected_urn: str,
) -> tuple[int, float]:
    """Declare one task to obsel, and check the urn it filed the task under.

    Returns the exit code and the elapsed milliseconds; the caller prints its
    own success line, because the demo has four tasks to describe in full and
    the taxi swarm has forty to list.

    The mismatch is what is shared. obsel and the agents disagreeing about a
    URN is not a cosmetic difference: lineage traversal starts from the urn, so
    a task filed under another one is a task a cascade walks straight past.
    Neither caller may carry on past it, and neither may report it differently.
    """
    started = time.perf_counter()
    record = worker.post_json(
        f"{obsel_url}/api/tasks/register",
        {
            "name": name,
            "reads": reads,
            "writes": writes,
            # The one-sentence job, stored as the DataJob's own description so
            # DataHub's UI and obsel's board show the same words.
            "description": description,
            # The short human name the board leads with. `name` above stays the
            # code identifier the URN is built from.
            "title": title,
        },
        # A registration is a mutation: entity, edges, and confirms.
        timeout=worker.MUTATION_TIMEOUT,
        headers=worker.auth_headers(),
    )
    elapsed = (time.perf_counter() - started) * 1000

    if record.get("urn") != expected_urn:
        print(f"  MISMATCH {name}")
        print(f"    obsel returned {record.get('urn')}")
        print(f"    agents expect  {expected_urn}")
        print("    The two sides disagree about URNs; lineage traversal would miss this task.")
        return 1, elapsed

    return 0, elapsed


def register_missing(
    obsel_url: str,
    *,
    tasks: Sequence[Any],
    task_urn: Callable[[str], str],
    register: Callable[[Any], int],
) -> int:
    """Declare whichever of `tasks` obsel has no record of, in the order given.

    Both `run` and `scale-run` do this themselves so that starting a swarm is one
    action rather than two. Only the absent ones are declared: re-declaring a task
    obsel already holds sets its status back to `registered`, which on a board that
    has already run would discard the finished state the page reads off it.
    """
    expected = [(task.name, task_urn(task.name)) for task in tasks]
    absent = missing_names(worker.read_swarm(obsel_url)["snapshot"]["tasks"], expected)
    if not absent:
        return 0

    print(f"  obsel had no record of {len(absent)} of the {len(expected)} tasks; declaring them now")
    by_name = {task.name: task for task in tasks}
    for name in absent:
        code = register(by_name[name])
        if code != 0:
            return code
    print()
    return 0


def _demo_tasks(obsel_url: str) -> list[dict[str, Any]]:
    """obsel's record of the four demo tasks, or an error saying which is missing."""
    records = {
        record.get("urn"): record
        for record in worker.read_swarm(obsel_url)["snapshot"]["tasks"]
        if isinstance(record, dict)
    }
    found: list[dict[str, Any]] = []
    missing: list[str] = []
    for task in pipeline.TASKS:
        record = records.get(pipeline.task_urn(task.name))
        if record is None:
            missing.append(task.name)
        else:
            found.append(record)
    if missing:
        raise RuntimeError(
            f"obsel has no record of {', '.join(missing)}. "
            "Run `python -m agents.run register` first."
        )
    return found


def _print_run(result: worker.RunResult, was_first_run: bool) -> None:
    # A real agent read the files and wrote the table itself. There is no plan
    # and no cache, so neither may be mentioned -- saying otherwise would
    # misdescribe on camera what actually did the work.
    origin = f"{result.plan_source} did the work in {result.model_seconds * 1000:.0f} ms"

    print(f"  {result.task}")
    if result.start == "resumed":
        print("    resumed: a previous attempt of this agent announced its start and did")
        print("    not finish, so obsel already had it at running")
    print(f"    {origin}")
    if result.plan_notes:
        print(f"    it says: {result.plan_notes}")
    print(
        f"    wrote {result.output_table}: {result.row_count} rows, "
        f"columns {', '.join(result.columns)}"
    )
    for prints in result.fingerprints.values():
        print(f"    fingerprint schema {prints['schema'][:12]} content {prints['content'][:12]}")
    print(f"    agent finished in {result.total_seconds * 1000:.0f} ms")
    _print_coordination(result.coordination, was_first_run)


def _print_coordination(coordination: dict[str, Any], was_first_run: bool) -> None:
    if not coordination:
        return

    changed = _required_list(coordination, "changedOutputs", "a completion report")
    affected = _required_list(coordination, "affected", "a completion report")
    # As strict as `affected`, pointed the other way: a lost key read as an
    # empty list would print nothing over a reply that cleared two tasks, and
    # telling the operator which flags a redo just earned off is what the
    # repair step's whole account rests on.
    restored = _required_list(coordination, "restored", "a completion report")
    elapsed = coordination.get("elapsedMs")
    elapsed_text = f"{elapsed} ms" if elapsed is not None else "unreported"

    if not changed:
        if was_first_run:
            print(f"    obsel: first version of this table, nothing to compare against ({elapsed_text})")
        else:
            print(
                f"    obsel: identical to the previous version, nothing marked stale "
                f"({elapsed_text})"
            )
    else:
        what = ", ".join(f"{_short(item['dataset'])} ({item['kind']})" for item in changed)
        print(f"    obsel: changed {what}")

        if not affected:
            print(f"    obsel: nothing downstream had finished, so nothing to mark ({elapsed_text})")
        else:
            print(f"    obsel: marked {len(affected)} finished task(s) stale in {elapsed_text}")
            for entry in affected:
                mark = entry["mark"]
                hops = mark["hops"]
                unit = "hop" if hops == 1 else "hops"
                print(f"      {entry['task']['name']:<15} {hops} {unit:<5} {mark['reason']}")

    # The redo dividend: flagged work this completion proved sound, cleared by
    # obsel without being re-run. Arrives with `changed` empty on the demo's
    # repair (the redone table came out identical), so it prints after either
    # branch above rather than inside one.
    for entry in restored:
        print(f"    obsel: cleared {entry['task']['name']} without a re-run")
        print(f"      {entry['reason']}")


def _short(dataset_urn: str) -> str:
    return dataset_urn.split(",")[1].split(".")[-1] if "," in dataset_urn else dataset_urn


def ensure_seed(root: Path = REPO_ROOT) -> None:
    """Write raw_orders if it is not there. Nothing in the swarm produces it."""
    path = worker.table_path(pipeline.SEED_TABLE, root)
    if path.exists():
        return
    table = seed_data.raw_orders()
    worker.save_table(pipeline.SEED_TABLE, table, root)
    print(f"  seeded {pipeline.SEED_TABLE}: {len(table['rows'])} rows (fixed seed {seed_data.SEED})")
