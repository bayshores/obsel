"""The demo, driven from one command line.

    python -m agents.setup        # or: python -m agents.run setup
    python -m agents.run register
    python -m agents.run run
    python -m agents.run rerun-same
    python -m agents.run change

Run them in that order. `rerun-same` before `change` on purpose: it establishes
that a re-run which produces the same table marks nothing, so when `change` lights
up three tasks a second later, the difference is the rename and not the re-run.

Every timing printed here is measured with `time.perf_counter()` around the thing
being timed. Nothing in this file says "instant".

Every outcome printed here is read back from obsel. `run`, `rerun-same` and
`change` each state one specific claim, check it against what obsel actually
returned, and print an `UNEXPECTED:` line and exit non-zero when the two differ.
`docs/demo-script.md` tells the operator to rely on that guard, so a command that
prints its claim without checking it would be worse than no guard at all: a
missing key or an empty list would read as a pass.
"""

from __future__ import annotations

import argparse
import shutil
import sys
import time
from pathlib import Path
from typing import Any

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
    an operator following `docs/demo-script.md` has to tell them apart.
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
        return

    what = ", ".join(f"{_short(item['dataset'])} ({item['kind']})" for item in changed)
    print(f"    obsel: changed {what}")

    if not affected:
        print(f"    obsel: nothing downstream had finished, so nothing to mark ({elapsed_text})")
        return

    print(f"    obsel: marked {len(affected)} finished task(s) stale in {elapsed_text}")
    for entry in affected:
        mark = entry["mark"]
        hops = mark["hops"]
        unit = "hop" if hops == 1 else "hops"
        print(f"      {entry['task']['name']:<15} {hops} {unit:<5} {mark['reason']}")


def _short(dataset_urn: str) -> str:
    return dataset_urn.split(",")[1].split(".")[-1] if "," in dataset_urn else dataset_urn


# --------------------------------------------------------------------------
# Steps
# --------------------------------------------------------------------------


def ensure_seed(root: Path = REPO_ROOT) -> None:
    """Write raw_orders if it is not there. Nothing in the swarm produces it."""
    path = worker.table_path(pipeline.SEED_TABLE, root)
    if path.exists():
        return
    table = seed_data.raw_orders()
    worker.save_table(pipeline.SEED_TABLE, table, root)
    print(f"  seeded {pipeline.SEED_TABLE}: {len(table['rows'])} rows (fixed seed {seed_data.SEED})")


def cmd_setup(args: argparse.Namespace) -> int:
    from agents import setup

    _rule("setup: registering obsel's vocabulary in DataHub")
    code = setup.main()
    if code != 0:
        return code
    print()
    ensure_seed()
    return 0


def cmd_register(args: argparse.Namespace) -> int:
    _rule("register: putting the four agent tasks into DataHub")
    ensure_seed()
    print()
    for task in pipeline.in_dependency_order():
        started = time.perf_counter()
        record = worker.post_json(
            f"{args.obsel_url}/api/tasks/register",
            {"name": task.name, "reads": list(task.reads), "writes": [task.writes]},
        )
        elapsed = (time.perf_counter() - started) * 1000

        expected = pipeline.task_urn(task.name)
        if record.get("urn") != expected:
            print(f"  MISMATCH {task.name}")
            print(f"    obsel returned {record.get('urn')}")
            print(f"    agents expect  {expected}")
            print("    The two sides disagree about URNs; lineage traversal would miss this task.")
            return 1

        print(f"  {task.name:<15} {record['urn']}")
        print(
            f"    reads {', '.join(task.reads)} -> writes {task.writes}, "
            f"registered in {elapsed:.0f} ms"
        )
    return 0


def _run_one(
    task: pipeline.AgentTask,
    args: argparse.Namespace,
    instruction: str | None = None,
    expect_columns: tuple[str, ...] | None = None,
) -> tuple[worker.RunResult, bool]:
    """Run one agent. Returns the result and whether obsel had a baseline to compare.

    `was_first_run` is asked of obsel, not inferred from whether a local output file
    happens to exist. The two can disagree -- a reset on either side alone is enough
    -- and every line that follows is a claim about obsel's state, so it has to come
    from obsel's state.
    """
    was_first_run = not worker.has_recorded_output(
        pipeline.task_urn(task.name), pipeline.dataset_urn(task.writes), args.obsel_url
    )
    result = worker.run_task(
        task,
        instruction=instruction,
        obsel_url=args.obsel_url,
        expect_columns=expect_columns,
    )
    _print_run(result, was_first_run)
    return result, was_first_run


def cmd_run(args: argparse.Namespace) -> int:
    _rule("run: four agents, in dependency order")
    ensure_seed()
    print()
    started = time.perf_counter()

    # What obsel marked while the four ran. On a first run this stays empty; run
    # `run` again after `change` and it does not, because build_revenue's new output
    # invalidates the two tasks downstream of it before they re-run themselves.
    marked: list[tuple[str, str]] = []
    for task in pipeline.in_dependency_order():
        result, _ = _run_one(task, args)
        for entry in _required_list(result.coordination, "affected", f"{task.name} finishing"):
            marked.append((task.name, entry["task"]["name"]))
        print()

    print(f"  all four agents finished in {(time.perf_counter() - started):.1f} s")

    if marked:
        print(f"  obsel marked {len(marked)} finished task(s) stale part-way through this run:")
        for finisher, invalidated in marked:
            print(f"    {invalidated} when {finisher} finished")

    # The closing claim is about the swarm as a whole, so it is read back from the
    # swarm rather than assumed from the fact that four agents returned. A task can
    # be marked mid-run and clear its own mark by re-running, so only the final
    # state can settle it.
    records = _demo_tasks(args.obsel_url)
    unfinished = sorted(r["name"] for r in records if r.get("status") != "complete")
    still_marked = sorted(r["name"] for r in records if r.get("stale"))
    print(
        f"  obsel's own state: {len(records) - len(unfinished)} of {len(records)} complete, "
        f"{len(still_marked)} still carrying a stale mark"
    )

    if unfinished or still_marked:
        print("  UNEXPECTED: obsel does not agree that this run left everything sound.")
        if unfinished:
            print(f"    not complete: {', '.join(unfinished)}")
        if still_marked:
            print(f"    still marked stale: {', '.join(still_marked)}")
        return 1

    print("  every task is complete and every task is built on something still true")
    return 0


def cmd_rerun_same(args: argparse.Namespace) -> int:
    task = pipeline.TASKS[0]
    _rule(f"rerun-same: {task.name} runs again and produces the same table")
    print("  Same job, same input, so the same plan applies and the same rows come out.")
    print("  obsel decides on the fingerprint, not on the fact that a write happened,")
    print("  so nothing downstream should be touched.")
    print()

    # Whatever this task was last told to do, so this is a true no-change re-run
    # at any point in the demo, including after `change`.
    instruction = worker.last_instruction(task.name) or task.instruction
    before = worker.load_table(task.writes, REPO_ROOT)
    result, was_first_run = _run_one(task, args, instruction=instruction)
    after = worker.load_table(task.writes, REPO_ROOT)

    where = f"{task.name}'s completion"
    affected = _required_list(result.coordination, "affected", where)
    changed = _required_list(result.coordination, "changedOutputs", where)

    identical = before == after
    print()
    print(f"  output byte-identical to the previous run: {identical}")
    print(f"  outputs obsel saw change: {len(changed)}")
    print(f"  tasks obsel marked stale: {len(affected)}")

    problems: list[str] = []
    if was_first_run:
        problems.append(
            "obsel held no previous fingerprint for this table, so it compared nothing. "
            "Marking nothing here proves nothing. Run `run` before `rerun-same`."
        )
    if not identical:
        problems.append("the re-run produced a different table, so this was not a no-change re-run")
    if changed:
        problems.append(f"obsel reported {len(changed)} changed output(s) for an identical table")
    if affected:
        problems.append(f"obsel marked {len(affected)} task(s) stale for an identical table")

    if problems:
        for problem in problems:
            print(f"  UNEXPECTED: {problem}")
        return 1
    return 0


# The whole claim of the project, written down so the command can check it rather
# than narrate it. build_revenue read the renamed table itself. write_report and
# write_docs never touched it and are reached only by walking through
# daily_revenue -- if the transitive half broke, this map is what catches it, and
# "something was marked" would not.
EXPECTED_CASCADE = {"build_revenue": 1, "write_report": 2, "write_docs": 2}


def cmd_change(args: argparse.Namespace) -> int:
    task = pipeline.TASKS[0]
    _rule(f"change: {task.name} runs again and renames a column")
    print("  One requirement changed upstream: the money column is now order_total_usd.")
    print("  Nothing downstream is told. Three tasks already finished.")
    print()

    before = worker.load_table(task.writes, REPO_ROOT)
    # The renamed column is the whole demo, so the contract for this run is passed
    # in and enforced. If the agent quietly kept the old name the run fails here,
    # rather than producing an unchanged fingerprint and a cascade that never fires.
    result, was_first_run = _run_one(
        task,
        args,
        instruction=pipeline.CHANGE_INSTRUCTION,
        expect_columns=pipeline.CHANGE_COLUMNS,
    )
    after = worker.load_table(task.writes, REPO_ROOT)

    where = f"{task.name}'s completion"
    affected = _required_list(result.coordination, "affected", where)
    changed = _required_list(result.coordination, "changedOutputs", where)

    print()
    print(f"  columns before: {', '.join(before['columns'])}")
    print(f"  columns after:  {', '.join(after['columns'])}")

    reached = {entry["task"]["name"]: entry["mark"]["hops"] for entry in affected}
    if reached:
        print(
            "  obsel reached: "
            + ", ".join(f"{name} at {hops}" for name, hops in sorted(reached.items()))
            + " hops"
        )
    kinds = {_short(item["dataset"]): item["kind"] for item in changed}
    for dataset, kind in sorted(kinds.items()):
        print(f"  obsel called the change to {dataset}: {kind}")

    problems: list[str] = []
    if was_first_run:
        problems.append(
            f"obsel held no previous fingerprint for {task.writes}, so nothing was compared "
            "and nothing could be marked. Run `run` before `change`."
        )

    # A rename moves the column names and leaves every value alone, so obsel must
    # say "schema" here. "both" or "content" would mean the fingerprint split is not
    # doing its job and the reason on every mark downstream is wrong.
    if kinds.get(task.writes) != "schema":
        problems.append(
            f"obsel called the change to {task.writes} {kinds.get(task.writes)!r}, expected "
            "'schema': renaming a column moves the column names and no values"
        )

    if reached != EXPECTED_CASCADE:
        problems.append(
            f"obsel reached {reached or 'nothing'}, expected {EXPECTED_CASCADE}. "
            "The two-hop tasks are the ones that never read the changed table."
        )

    wrong_kind = sorted(
        entry["task"]["name"] for entry in affected if entry["mark"]["changeKind"] != "schema"
    )
    if wrong_kind:
        problems.append(f"marks carrying a changeKind other than 'schema': {', '.join(wrong_kind)}")

    if problems:
        for problem in problems:
            print(f"  UNEXPECTED: {problem}")
        return 1

    print("  write_report and write_docs never read clean_orders. They were reached through")
    print("  daily_revenue, which is the whole point.")
    return 0


def cmd_reset(args: argparse.Namespace) -> int:
    _rule("reset: clearing obsel's task state and the local run output")

    # obsel's half goes first. If it fails, the local files are left exactly as they
    # are: clearing them while DataHub still holds the old fingerprints leaves a
    # baseline on one side and nothing on the other, and the next run compares
    # against a table this machine no longer has.
    url = f"{args.obsel_url}/api/demo/reset"
    try:
        reply = worker.post_json(url, {})
    except RuntimeError as error:
        print(f"  FAILED to reset obsel's task state: {error}")
        print("  Nothing local was touched, so the two halves still agree. Fix obsel and")
        print("  run reset again.")
        return 1

    if not isinstance(reply, dict) or reply.get("ok") is not True:
        print(f"  FAILED: {url} answered without reporting success: {reply!r:.300}")
        print("  Nothing local was touched.")
        return 1

    reset = reply.get("reset")
    tags_cleared = reply.get("tagsCleared")
    if not isinstance(reset, list) or not isinstance(tags_cleared, list):
        print(f"  FAILED: {url} reported ok without the lists it promises: {reply!r:.300}")
        print("  Nothing local was touched. An unreadable reply is not evidence of a reset.")
        return 1

    if reset:
        print(f"  obsel put {len(reset)} task(s) back to registered: {', '.join(sorted(reset))}")
    else:
        print("  obsel reset no tasks -- it has none registered. That is only what you should")
        print("  see before `register` has ever run against this DataHub.")
    if tags_cleared:
        print(
            f"  obsel removed the DataHub stale tag from {len(tags_cleared)} task(s): "
            f"{', '.join(sorted(tags_cleared))}"
        )
    else:
        print("  no task was carrying the DataHub stale tag")

    for name in ("data", "plans", "state"):
        path = REPO_ROOT / ".obsel" / name
        if path.exists():
            shutil.rmtree(path)
            print(f"  removed {path}")
    ensure_seed()
    return 0


COMMANDS = {
    "setup": cmd_setup,
    "register": cmd_register,
    "run": cmd_run,
    "rerun-same": cmd_rerun_same,
    "change": cmd_change,
    "reset": cmd_reset,
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agents.run", description=__doc__)
    parser.add_argument("command", choices=sorted(COMMANDS))
    parser.add_argument(
        "--obsel-url",
        default=worker.OBSEL_URL,
        help="where obsel is running (default %(default)s)",
    )
    args = parser.parse_args(argv)

    try:
        return COMMANDS[args.command](args)
    except Unexpected as error:
        # The demo ran and obsel's answer does not hold up. Different problem from
        # the demo failing to run, and labelled differently on purpose.
        print()
        print(f"UNEXPECTED: {error}")
        return 1
    except (RuntimeError, FileNotFoundError, ValueError) as error:
        print()
        print(f"stopped: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
