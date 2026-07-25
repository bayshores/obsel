"""The demo, driven from one command line.

    python -m agents.setup        # or: python -m agents.run setup
    python -m agents.run register
    python -m agents.run run
    python -m agents.run rerun-same
    python -m agents.run change
    python -m agents.run repair

Run them in that order. `rerun-same` before `change` on purpose: it establishes
that a re-run which produces the same table marks nothing, so when `change` lights
up three tasks a second later, the difference is the rename and not the re-run.
`repair` closes the loop: it redoes the flagged work in dependency order, and
obsel takes each flag off as the redo that earns it lands -- including flags it
clears itself, when an upstream redo comes out identical.

Every timing printed here is measured with `time.perf_counter()` around the thing
being timed. Nothing in this file says "instant".

Every outcome printed here is read back from obsel. `run`, `rerun-same` and
`change` each state one specific claim, check it against what obsel actually
returned, and print an `UNEXPECTED:` line and exit non-zero when the two differ.
The demo relies on that guard, so a command that
prints its claim without checking it would be worse than no guard at all: a
missing key or an empty list would read as a pass.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import shutil
import socket
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from agents import pipeline, scale, seed_data, worker
from agents.fingerprint import fingerprint

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
            {
                "name": task.name,
                "reads": list(task.reads),
                "writes": [task.writes],
                # The one-sentence job, stored as the DataJob's own description
                # so DataHub's UI and obsel's board show the same words.
                "description": task.summary,
                # The short human name the board leads with. `name` above stays
                # the code identifier the URN is built from.
                "title": task.title,
            },
            # A registration is a mutation: entity, edges, and confirms.
            timeout=worker.MUTATION_TIMEOUT,
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
        pipeline.task_urn(task.name), pipeline.task_dataset_urn(task, task.writes), args.obsel_url
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

    # Whatever this task last ran — the instruction AND the column contract,
    # together, so this is a true no-change re-run at any point in the demo,
    # including after `change`. Replaying the instruction with a contract from a
    # different run is how this step failed live on 2026-07-22: the changed
    # instruction said order_total_usd, the standing contract said order_total,
    # the contract won, and the re-run reverted the rename.
    remembered = worker.last_run(task.name) or {}
    instruction = remembered.get("instruction") or task.instruction
    expect_columns = tuple(remembered.get("columns") or task.output_columns)
    before = worker.load_table(task.writes, REPO_ROOT)
    result, was_first_run = _run_one(
        task, args, instruction=instruction, expect_columns=expect_columns
    )
    after = worker.load_table(task.writes, REPO_ROOT)

    where = f"{task.name}'s completion"
    affected = _required_list(result.coordination, "affected", where)
    changed = _required_list(result.coordination, "changedOutputs", where)

    # Compared by fingerprint, NOT by `before == after`.
    #
    # Python's equality is weaker than the hash obsel decides on, and the gap is
    # not theoretical: measured 2026-07-22, a re-run of clean_orders differed from
    # the previous one in exactly one value -- order_id 1012's order_total written
    # as `217` where the run before wrote `217.0`. Python calls those two tables
    # equal, because 217 == 217.0. The fingerprint does not, because it hashes the
    # serialised value, and `217` and `217.0` are different bytes.
    #
    # So this check reported "byte-identical: True" for a table that was not, and
    # then blamed obsel for a false alarm that was in fact a correct detection.
    # A check that is looser than the property it verifies does not verify it; it
    # manufactures a failure and points at the wrong component.
    before_print = fingerprint(before["rows"], before["columns"])
    after_print = fingerprint(after["rows"], after["columns"])
    identical = before_print == after_print

    print()
    print(f"  output byte-identical to the previous run: {identical}")
    if not identical:
        for label, prints in (("before", before_print), ("after", after_print)):
            print(f"    {label:<7}schema {prints['schema'][:12]} content {prints['content'][:12]}")
    print(f"  outputs obsel saw change: {len(changed)}")
    print(f"  tasks obsel marked stale: {len(affected)}")

    problems: list[str] = []
    if was_first_run:
        problems.append(
            "obsel held no previous fingerprint for this table, so it compared nothing. "
            "Marking nothing here proves nothing. Run `run` before `rerun-same`."
        )
    if not identical:
        # Stated as an agent problem, because that is what it is. obsel comparing
        # fingerprints and finding a difference that really exists is obsel
        # working. The demonstration is what failed: this step can only show
        # "no change, no alarm" if the re-run genuinely produced no change.
        problems.append(
            "the re-run produced a different table, so this was not a no-change re-run -- "
            "any mark below is a correct detection, not a false alarm"
        )
    elif changed:
        problems.append(f"obsel reported {len(changed)} changed output(s) for an identical table")
    elif affected:
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


def _read_tables(root: Path = REPO_ROOT) -> dict[str, Any]:
    """Every table currently on disk, by short name.

    `root` follows the convention every function in `worker.py` uses, so a check
    can point this at a scratch directory and exercise the real read.
    """
    directory = worker.data_dir(root)
    if not directory.is_dir():
        return {}
    return {
        path.stem: json.loads(path.read_text(encoding="utf-8"))
        for path in sorted(directory.glob("*.json"))
    }


def _capture(
    directory: str,
    swarm_before: Any,
    tables_before: dict[str, Any],
    coordination: dict[str, Any],
    obsel_url: str,
) -> None:
    """Write the artefacts a judge reads, all from this one `change`.

    Assembling these from separate runs would produce a set that looks coherent
    and is not -- the fingerprints in `swarm-before` would belong to a table other
    than the one `coordination-result` reports on, which is precisely the kind of
    quiet disagreement obsel exists to catch. So they are written together or not
    at all.

    The tables are captured as well as the responses, and both sides of the
    change. Without them every digest in the JSON is a number a reader has to take
    on trust; with them `examples/reproduce_fingerprints.py` can recompute each
    one from the actual rows it was taken over. `clean_orders` is the table that
    moves, so it is the one that genuinely needs both versions -- the others are
    captured on both sides too, because "these three did not move" is itself a
    claim worth being able to check.

    `swarm-after` is read here rather than passed in, so it is the swarm once the
    marks have actually landed in DataHub, not once the HTTP call returned.
    """
    target = Path(directory)
    (target / "tables").mkdir(parents=True, exist_ok=True)

    files = {
        "swarm-before.json": swarm_before,
        "coordination-result.json": coordination,
        "swarm-after.json": worker.read_swarm(obsel_url),
        "tables/before.json": tables_before,
        "tables/after.json": _read_tables(),
    }
    for name, body in files.items():
        path = target / name
        path.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
        print(f"  captured {path}")

    # Python and Prettier disagree about when a short array fits on one line, and
    # `pnpm verify` runs `prettier --check .`. Whitespace only -- the parsed values
    # are identical either way -- but a capture committed as written fails the
    # check, so say so here rather than leaving it to be rediscovered.
    print(f"  run `npx prettier --write {directory}` before committing these")


def cmd_change(args: argparse.Namespace) -> int:
    task = pipeline.TASKS[0]
    _rule(f"change: {task.name} runs again and renames a column")
    print("  One requirement changed upstream: the money column is now order_total_usd.")
    print("  Nothing downstream is told. Three tasks already finished.")
    print()

    before = worker.load_table(task.writes, REPO_ROOT)

    # Read before the agent runs, so a capture records the swarm and the tables as
    # they actually were on the far side of the change rather than a later re-read.
    swarm_before = worker.read_swarm(args.obsel_url) if args.capture else None
    tables_before = _read_tables() if args.capture else {}

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

    if args.capture:
        _capture(args.capture, swarm_before, tables_before, result.coordination, args.obsel_url)

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


def _repair_order(stale_names: set[str]) -> list[pipeline.AgentTask]:
    """The flagged tasks, in the order redoing them makes sense.

    Producers before consumers, from the same topological sort the demo runs in.
    The order is the whole trick: redoing `build_revenue` first gives obsel the
    chance to prove `write_report` and `write_docs` sound before their turns
    come, so the loop in `cmd_repair` re-reads the board at each turn and skips
    whatever is no longer flagged.
    """
    return [task for task in pipeline.in_dependency_order() if task.name in stale_names]


def cmd_repair(args: argparse.Namespace) -> int:
    """Redo the flagged work, and let obsel take each flag off as it is earned.

    There is no tool that clears a flag, on purpose. The only two ways a flag
    comes off are the task's own redo, and obsel proving the task sound when an
    upstream redo lands byte-identical. This command drives the first and
    reports the second, so the board ends green through real work rather than
    through a reset.
    """
    _rule("repair: redo what obsel flagged, in dependency order")

    records = {record["name"]: record for record in _demo_tasks(args.obsel_url)}
    flagged = {name for name, record in records.items() if record.get("stale")}

    if not flagged:
        print("  nothing is flagged, so there is nothing to redo")
        return 0

    print(f"  {len(flagged)} task(s) flagged: {', '.join(t.name for t in _repair_order(flagged))}")
    print("  Each redo replays what that task last ran, on its current inputs. A flag")
    print("  only comes off through a redo: this task's own, or an upstream redo that")
    print("  obsel confirms came out identical.")
    print()

    started = time.perf_counter()
    redone: list[str] = []
    # Why each cleared-without-a-re-run task cleared, by name, taken from the
    # `restored` list of the completion that cleared it. The skip decision
    # itself never reads this -- it reads the board -- but the operator deserves
    # the reason, and the reply is where obsel put it.
    cleared_because: dict[str, str] = {}

    # Passes, not one pass. A redo may land a genuinely different table -- a
    # live model is allowed to -- and obsel then rightly flags what was built on
    # the new version. Those flags land strictly downstream, so another pass in
    # dependency order absorbs them. Each pass either redoes something or ends
    # clean, so one pass per task is the most the board can need, and a loop
    # still going past that is evidence, not patience.
    passes = 0
    while True:
        current = {record["name"]: record for record in _demo_tasks(args.obsel_url)}
        flagged_now = {name for name, record in current.items() if record.get("stale")}
        if not flagged_now:
            break

        passes += 1
        if passes > len(pipeline.TASKS):
            raise Unexpected(
                f"repair has redone work {passes - 1} passes deep and obsel still flags "
                f"{', '.join(sorted(flagged_now))}. Redoing in dependency order must "
                "converge within one pass per task."
            )

        for task in _repair_order(flagged_now):
            fresh = {record["name"]: record for record in _demo_tasks(args.obsel_url)}
            if not fresh[task.name].get("stale"):
                reason = cleared_because.get(task.name)
                if reason:
                    print(f"  {task.name}: skipped, obsel already cleared it")
                    print(f"    {reason}")
                else:
                    # True and worth distinguishing: cleared by something other
                    # than this loop's own redos, e.g. a re-run from a terminal.
                    print(f"  {task.name}: skipped, no longer flagged when its turn came")
                print()
                continue

            # The task's own last run, instruction and column contract together
            # -- the same pairing rerun-same uses, and for the same reason:
            # replaying an instruction against a contract from a different run
            # is how a redo quietly reverts a change instead of absorbing one.
            remembered = worker.last_run(task.name) or {}
            instruction = remembered.get("instruction") or task.instruction
            expect_columns = tuple(remembered.get("columns") or task.output_columns)

            result, _ = _run_one(
                task, args, instruction=instruction, expect_columns=expect_columns
            )
            redone.append(task.name)

            for entry in _required_list(result.coordination, "restored", f"{task.name}'s redo"):
                cleared_because[entry["task"]["name"]] = entry["reason"]

            after = {record["name"]: record for record in _demo_tasks(args.obsel_url)}
            if after[task.name].get("stale"):
                raise Unexpected(
                    f"{task.name} re-ran and reported, and obsel still holds its flag. "
                    "A completed redo is the one thing that must always clear a task's own mark."
                )
            print()

    # The closing claim is about the whole board, so it is read back from the
    # board rather than assumed from the loop having ended.
    final = _demo_tasks(args.obsel_url)
    still = sorted(record["name"] for record in final if record.get("stale"))
    elapsed = time.perf_counter() - started

    print(f"  redid {len(redone)} of the {len(flagged)} flagged task(s) in {elapsed:.1f} s")
    if cleared_because:
        cleared = ", ".join(sorted(cleared_because))
        print(f"  obsel cleared {len(cleared_because)} without a re-run: {cleared}")
        print("    because the redone table came out identical, the work built on it")
        print("    was flagged for ground that never moved")

    if still:
        raise Unexpected(
            f"repair finished and obsel still flags: {', '.join(still)}. "
            "Redoing every flagged task, in dependency order, must end with a clean board."
        )

    print("  every flag is off, and every one came off through a redo")
    return 0


def cmd_reset(args: argparse.Namespace, root: Path = REPO_ROOT) -> int:
    """Put obsel back to registered and delete this machine's run output.

    `root` is the only destructive path in this file, and it takes a parameter for
    that reason: a check that could only run against `REPO_ROOT` would have to
    delete the operator's real `.obsel` directory to prove that it does not delete
    the operator's real `.obsel` directory. The dispatcher passes one argument, so
    the default is what every real invocation uses.
    """
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

    for name in ("data", "plans", "state", "work"):
        path = root / ".obsel" / name
        if path.exists():
            shutil.rmtree(path)
            print(f"  removed {path}")
    ensure_seed(root)
    return 0


# --------------------------------------------------------------------------
# The scale swarm: forty real agents, a bounded pool, a change mid-run
# --------------------------------------------------------------------------

# The changed re-run enters the pool under this key, beside the forty task
# names, so the timeline can say when the change landed relative to everything
# else without colliding with the original daily_trips entry.
SCALE_CHANGE_KEY = f"{scale.CHANGE_TASK}#change"

# One direct reader of the changed table is held back and released at the same
# moment the change is cued, so the two run side by side: the reader loads the
# old table, the change replaces it mid-read, and the reader's completion is
# the straddling case the engine's classifyObservation exists for. Everything
# here is derived from the spec where it can be; the self-check pins the rest.
SCALE_HELD_READER = "docs_marts"


def _scale_hop1() -> list[str]:
    """The tasks that read the changed table directly, from the spec's walk."""
    return sorted(n for n, h in scale.EXPECTED_CHANGE_DESCENDANTS.items() if h == 1)


def _scale_trigger_met(completed: set[str]) -> bool:
    """Cue the change once every unheld direct reader has finished.

    At that moment the held reader and the changed re-run enter the pool
    together: enough descendants are complete for the cascade to have work, and
    one reader is guaranteed in flight while the table under it is replaced.
    """
    return all(name in completed for name in _scale_hop1() if name != SCALE_HELD_READER)


def _scale_records(obsel_url: str) -> dict[str, dict[str, Any]]:
    """obsel's record of the forty scale tasks, or an error naming the missing."""
    records = {
        record.get("urn"): record
        for record in worker.read_swarm(obsel_url)["snapshot"]["tasks"]
        if isinstance(record, dict)
    }
    found: dict[str, dict[str, Any]] = {}
    missing: list[str] = []
    for task in scale.TASKS:
        record = records.get(scale.task_urn(task.name))
        if record is None:
            missing.append(task.name)
        else:
            found[task.name] = record
    if missing:
        raise RuntimeError(
            f"obsel has no record of {len(missing)} scale task(s): "
            f"{', '.join(missing[:6])}{'…' if len(missing) > 6 else ''}. "
            "Run `python -m agents.run scale-register` first."
        )
    return found


def cmd_scale_register(args: argparse.Namespace) -> int:
    _rule("scale-register: putting the forty taxi tasks into DataHub")
    written = scale.install_seeds(REPO_ROOT)
    for name in written:
        print(f"  seeded {name} from the committed extract (hash checked)")
    print()

    started = time.perf_counter()
    for task in scale.in_dependency_order():
        record = worker.post_json(
            f"{args.obsel_url}/api/tasks/register",
            {
                "name": task.name,
                # Qualified with the scale namespace, which the server passes
                # through untouched; a short name here would land the task's
                # edges under the demo's tables.
                "reads": [f"{scale.NAMESPACE}.{source}" for source in task.reads],
                "writes": [f"{scale.NAMESPACE}.{task.writes}"],
                "description": task.summary,
                "title": task.title,
            },
            timeout=worker.MUTATION_TIMEOUT,
        )
        expected = scale.task_urn(task.name)
        if record.get("urn") != expected:
            print(f"  MISMATCH {task.name}")
            print(f"    obsel returned {record.get('urn')}")
            print(f"    agents expect  {expected}")
            return 1
        print(f"  {task.name:<18} registered")

    elapsed = time.perf_counter() - started
    print()
    print(f"  all {len(scale.TASKS)} tasks registered in {elapsed:.1f} s")
    return 0


def _scale_execute(task: pipeline.AgentTask, args: argparse.Namespace) -> worker.RunResult:
    """One scale task, thread-side: no printing, the main loop narrates."""
    return worker.run_task(task, obsel_url=args.obsel_url)


def _print_scale_completion(key: str, result: worker.RunResult) -> list[str]:
    """One line per finished agent, plus obsel's verdict when it said anything.

    Returns the names obsel marked on this completion, so the caller can keep
    the running account without re-parsing the reply.
    """
    coordination = result.coordination
    where = f"{key}'s completion"
    affected = _required_list(coordination, "affected", where)
    restored = _required_list(coordination, "restored", where)
    changed = _required_list(coordination, "changedOutputs", where)

    print(
        f"  {key:<20} {result.plan_source} {result.model_seconds:5.1f}s"
        f"  {result.row_count:>4} rows  {result.output_table}"
    )
    if changed:
        what = ", ".join(f"{_short(item['dataset'])} ({item['kind']})" for item in changed)
        print(f"    obsel: changed {what}")
    for entry in affected:
        print(f"    obsel: marked {entry['task']['name']} — {entry['mark']['reason']}")
    for entry in restored:
        print(f"    obsel: cleared {entry['task']['name']} without a re-run")
    return [entry["task"]["name"] for entry in affected]


def cmd_scale_run(args: argparse.Namespace) -> int:
    from agents import swarm

    change_during = bool(getattr(args, "change_during", False))
    title = "scale-run: forty agents over one week of real taxi trips"
    if change_during:
        title += ", with one requirement changing mid-run"
    _rule(title)
    written = scale.install_seeds(REPO_ROOT)
    for name in written:
        print(f"  seeded {name} from the committed extract (hash checked)")
    print(f"  pool: up to {args.pool} Codex sessions at once")
    print()

    started = time.perf_counter()
    cued = {"change": False, "at": 0.0, "released": not change_during}
    marked_by: list[tuple[str, str]] = []
    change_reply: dict[str, Any] = {}
    in_flight_at_mark: list[str] = []

    # How long after cueing the change the held reader is released. The change
    # re-run is a real Codex session that takes tens of seconds; releasing the
    # reader at the cue let a 26-second reader finish before a 50-second change
    # landed (observed live, first mid-run attempt), so the straddle never
    # happened and the reader was marked by the ordinary cascade instead. A
    # short delay puts the reader's run inside the change's. Codex being live,
    # either path can still occur, and both are asserted correct below; the
    # delay only raises the odds of the straddling one being on the board.
    RELEASE_DELAY_S = 18.0

    def on_event(event: swarm.Event, outcome: swarm.Outcome, controls: swarm.Controls) -> None:
        if event.kind == "completed":
            marked = _print_scale_completion(event.key, outcome.results[event.key])
            marked_by.extend((event.key, name) for name in marked)
            if event.key == SCALE_CHANGE_KEY:
                change_reply.update(outcome.results[event.key].coordination)
                submitted = {e.key for e in outcome.events if e.kind in ("submitted", "extra")}
                finished = set(outcome.results) | set(outcome.failures)
                in_flight_at_mark.extend(sorted(submitted - finished - {event.key}))
        if event.kind == "failed":
            print(f"  {event.key:<20} FAILED: {outcome.failures[event.key]}")

        if (
            change_during
            and not cued["change"]
            and event.kind == "completed"
            and _scale_trigger_met(set(outcome.results))
        ):
            cued["change"] = True
            cued["at"] = time.perf_counter()
            change_task = scale.by_name(scale.CHANGE_TASK)
            print()
            print(f"  >> cueing the change: {scale.CHANGE_TASK} re-runs with the renamed column;")
            print(f"     {SCALE_HELD_READER} follows in about {RELEASE_DELAY_S:.0f} s, into the middle of it")
            print()
            controls.submit_extra(
                SCALE_CHANGE_KEY,
                lambda: worker.run_task(
                    change_task,
                    instruction=scale.CHANGE_INSTRUCTION,
                    obsel_url=args.obsel_url,
                    expect_columns=scale.CHANGE_COLUMNS,
                ),
            )

        # The delayed release, checked on every event after the cue. Any
        # completion in a forty-task pool lands often enough to serve as the
        # clock, and if the change itself completes first the release happens
        # on that event too — the reader then reads the new table and simply
        # completes clean, which the assertions below accept and name.
        if (
            change_during
            and cued["change"]
            and not cued["released"]
            and (
                time.perf_counter() - cued["at"] >= RELEASE_DELAY_S
                # A change that lands before the delay elapses forces the
                # release with it: with nothing else in the pool there would be
                # no later event to fire on, and the reader would sit held
                # until the drain reported it blocked.
                or (event.kind == "completed" and event.key == SCALE_CHANGE_KEY)
            )
        ):
            cued["released"] = True
            print(f"  >> releasing {SCALE_HELD_READER} into the middle of the change's re-run")
            controls.release(SCALE_HELD_READER)

    outcome = swarm.run_pool(
        scale.TASKS,
        lambda task: _scale_execute(task, args),
        pool_size=args.pool,
        held=[SCALE_HELD_READER] if change_during else [],
        on_event=on_event,
    )

    elapsed = time.perf_counter() - started
    print()
    print(
        f"  {len(outcome.results)} agent runs finished in {elapsed:.1f} s, "
        f"peak {outcome.peak_concurrency} at once"
    )

    problems: list[str] = []
    for key, error in outcome.failures.items():
        problems.append(f"{key} failed: {error}")
    for key, reason in outcome.blocked.items():
        problems.append(f"{key} never ran: {reason}")
    if change_during and not cued["change"]:
        problems.append(
            "the change was never cued: the trigger tasks did not all complete, "
            "so this run demonstrated nothing about a mid-run change"
        )

    # The closing claims are about the board, so they are read back from the
    # board. Which tasks SHOULD be flagged depends on how the run interleaved,
    # and the honest assertion is derived from what obsel itself reported at
    # the moment the change landed, cross-checked against the spec's walk.
    records = _scale_records(args.obsel_url)
    stale_now = sorted(name for name, record in records.items() if record.get("stale"))
    descendants = set(scale.EXPECTED_CHANGE_DESCENDANTS)

    if not change_during:
        unfinished = sorted(n for n, r in records.items() if r.get("status") != "complete")
        if unfinished:
            problems.append(f"not complete after a full run: {', '.join(unfinished)}")
        if stale_now:
            problems.append(f"a plain run left marks standing: {', '.join(stale_now)}")
        if marked_by:
            problems.append(
                f"obsel marked work during a first run: "
                + ", ".join(f"{who} marked {what}" for who, what in marked_by)
            )
    else:
        cascade_marked = {
            entry["task"]["name"]
            for entry in _required_list(change_reply, "affected", "the change's completion")
        }
        outside = sorted(cascade_marked - descendants)
        if outside:
            problems.append(
                f"the cascade reached outside the changed table's descendants: {', '.join(outside)}"
            )
        hop1 = set(_scale_hop1())
        missing_hop1 = sorted((hop1 - {SCALE_HELD_READER}) - set(stale_now))
        if missing_hop1:
            problems.append(
                "direct readers of the changed table ended unflagged: "
                + ", ".join(missing_hop1)
                + " — every unheld one of them finished on the old version before the change landed"
            )

        # The held reader's right answer depends on which side of the change
        # its read landed, and each side has exactly one. Read the old table
        # and finish before the change lands: the cascade flags it. Read the
        # old table and finish after: it flags ITSELF at completion, the
        # straddling-reader mark. Read the new table: it is current, and a
        # flag would be the false alarm obsel exists to not raise.
        reader_result = outcome.results.get(SCALE_HELD_READER)
        if reader_result is not None:
            reader_reply_marked = {
                entry["task"]["name"]
                for entry in _required_list(
                    reader_result.coordination, "affected", f"{SCALE_HELD_READER}'s completion"
                )
            }
            straddled = SCALE_HELD_READER in reader_reply_marked
            reader_stale = SCALE_HELD_READER in stale_now
            order = {
                (event.kind, event.key): index for index, event in enumerate(outcome.events)
            }
            finished_before_mark = order.get(
                ("completed", SCALE_HELD_READER), len(outcome.events)
            ) < order.get(("completed", SCALE_CHANGE_KEY), -1)

            print()
            if straddled:
                print(f"  {SCALE_HELD_READER} straddled the change: it read the old table, the")
                print("  table was replaced under it, and obsel marked it at its own completion")
                if not reader_stale:
                    problems.append(
                        f"{SCALE_HELD_READER}'s own completion marked it, but the board holds no flag"
                    )
            elif finished_before_mark:
                print(f"  {SCALE_HELD_READER} finished before the change landed; the cascade flagged it")
                if not reader_stale:
                    problems.append(
                        f"{SCALE_HELD_READER} finished on the old table before the change and must be flagged"
                    )
            else:
                print(f"  {SCALE_HELD_READER} read the new table after the change landed and is current")
                if reader_stale:
                    problems.append(
                        f"{SCALE_HELD_READER} read the current table and finished current; "
                        "its flag is a false alarm"
                    )
        wrongly_flagged = sorted(set(stale_now) - descendants)
        if wrongly_flagged:
            problems.append(
                f"flagged despite standing outside the change: {', '.join(wrongly_flagged)}"
            )
        for name in sorted(descendants - hop1):
            record = records[name]
            expected_stale = name in cascade_marked
            if bool(record.get("stale")) != expected_stale:
                actually = "flagged" if record.get("stale") else "unflagged"
                problems.append(
                    f"{name} is {actually}, but the change's own cascade "
                    f"{'named' if expected_stale else 'did not name'} it; a deep descendant "
                    "flags exactly when it was finished at the moment the change landed"
                )
        cause = records[scale.CHANGE_TASK]
        if cause.get("stale") or cause.get("status") != "complete":
            problems.append(f"{scale.CHANGE_TASK} is the cause, not a casualty, and must end complete")

        elapsed_ms = change_reply.get("elapsedMs")
        print()
        print(f"  the change landed with {len(in_flight_at_mark)} agent(s) still in flight:")
        print(f"    {', '.join(in_flight_at_mark) if in_flight_at_mark else '(none)'}")
        print(
            f"  obsel marked {len(cascade_marked)} at the change itself"
            + (f", measured {elapsed_ms} ms" if elapsed_ms is not None else "")
        )
        print(f"  the board now flags {len(stale_now)} of {len(records)} tasks: {', '.join(stale_now)}")
        untouched = len(records) - len(stale_now) - 1
        print(f"  {untouched} tasks stand outside the change, none of them flagged")

    if problems:
        for problem in problems:
            print(f"  UNEXPECTED: {problem}")
        return 1

    if not change_during:
        print("  every task is complete and nothing was marked, which is what a first run means")
    return 0


def cmd_scale_change(args: argparse.Namespace) -> int:
    """The deterministic variant: the change lands on a fully settled board."""
    task = scale.by_name(scale.CHANGE_TASK)
    _rule(f"scale-change: {task.name} re-runs and renames a column, everything else settled")

    records = _scale_records(args.obsel_url)
    unfinished = sorted(n for n, r in records.items() if r.get("status") != "complete")
    if unfinished:
        raise RuntimeError(
            f"{len(unfinished)} task(s) are not complete ({', '.join(unfinished[:5])}…); "
            "scale-change asserts the exact descendant set, which needs a settled board. "
            "Run `scale-run` first, or use `scale-run --change-during` for the mid-run form."
        )

    # Which way the rename goes is read off the board, not assumed. A repair
    # never touches this task, so after `change` then `repair` the column is
    # already renamed, and re-running the same direction reproduces the table
    # byte for byte: obsel rightly marks nothing and the step's own descendant
    # assertion fails. The recorded run's columns say where the board sits, and
    # `scale.change_for` renames away from it, so the button works every time.
    recorded = (
        ((records[task.name].get("run") or {}).get("outputs") or {})
        .get(pipeline.task_dataset_urn(task, task.writes)) or {}
    )
    plan = scale.change_for(recorded.get("columns"))
    print(f"  the passenger column is {plan.removed} on the board today; "
          f"this run renames it to {plan.added}")

    result = worker.run_task(
        task,
        instruction=plan.instruction,
        obsel_url=args.obsel_url,
        expect_columns=plan.columns,
    )
    marked = _print_scale_completion(task.name, result)

    where = f"{task.name}'s completion"
    affected = _required_list(result.coordination, "affected", where)
    reached = {entry["task"]["name"]: entry["mark"]["hops"] for entry in affected}
    changed = _required_list(result.coordination, "changedOutputs", where)
    kinds = {_short(item["dataset"]): item["kind"] for item in changed}

    problems: list[str] = []
    if kinds.get(task.writes) != "schema":
        problems.append(
            f"obsel called the change {kinds.get(task.writes)!r}, expected 'schema': "
            "a rename moves the names and no values"
        )
    if reached != scale.EXPECTED_CHANGE_DESCENDANTS:
        problems.append(
            f"obsel reached {reached or 'nothing'}, expected {scale.EXPECTED_CHANGE_DESCENDANTS}"
        )

    print()
    print(f"  obsel marked {len(marked)} of the {len(scale.TASKS)} tasks, out to "
          f"{max(reached.values()) if reached else 0} hops")
    print(f"  {len(scale.TASKS) - len(marked) - 1} tasks stand outside the change, none flagged")

    if problems:
        for problem in problems:
            print(f"  UNEXPECTED: {problem}")
        return 1
    return 0


def cmd_scale_repair(args: argparse.Namespace) -> int:
    """Redo what obsel flagged, in parallel, with the plan shrinking as proofs land.

    The serial `repair` redoes flagged work one task at a time. At forty tasks
    that wastes exactly what obsel knows: which redos are independent, and —
    once a redo comes back byte-identical — which planned redos the clearing
    rule has just made unnecessary. So this command runs eligible redos
    concurrently in the same bounded pool the swarm ran in, and every time a
    completion's reply carries `restored` entries, the tasks they name are
    cancelled out of the plan before they ever start.

    Nothing here can clear a flag. The scheduler only consumes the `restored`
    lists obsel already emits; a cancellation is obsel having already cleared
    the task, never a decision to skip it.
    """
    from agents import swarm

    _rule("scale-repair: redo the flagged work in parallel, cancelling what proofs clear")

    records = _scale_records(args.obsel_url)
    flagged_at_start = sorted(n for n, r in records.items() if r.get("stale"))
    if not flagged_at_start:
        print("  nothing is flagged, so there is nothing to redo")
        return 0

    # The estimate a person weighs the repair against: what redoing every
    # flagged task would cost, summed from each task's own last measured run.
    # Labeled estimated because it is arithmetic over recorded figures, not a
    # measurement of a run that happened.
    def last_ms(name: str) -> int | None:
        run = records[name].get("run")
        return run.get("ms") if isinstance(run, dict) and isinstance(run.get("ms"), int) else None

    known = [last_ms(n) for n in flagged_at_start if last_ms(n) is not None]
    estimate_s = sum(known) / 1000 if known else None

    print(f"  {len(flagged_at_start)} task(s) flagged: {', '.join(flagged_at_start)}")
    if estimate_s is not None and len(known) == len(flagged_at_start):
        print(
            f"  redoing all of them would cost about {estimate_s:.0f} s of agent time, "
            "estimated from each task's last measured run"
        )
    print(f"  pool: up to {args.pool} redos at once. A cancelled redo is one obsel")
    print("  already cleared, with the reason printed as the proof lands.")
    print()

    started = time.perf_counter()
    redone: list[str] = []
    cleared_because: dict[str, str] = {}
    passes = 0

    def redo(task: pipeline.AgentTask) -> worker.RunResult:
        # The task's own last run, instruction and column contract together —
        # the same pairing the serial repair uses, and for the same reason: a
        # redo replaying an instruction against a contract from a different
        # run quietly reverts a change instead of absorbing one.
        remembered = worker.last_run(task.name) or {}
        instruction = remembered.get("instruction") or task.instruction
        expect_columns = tuple(remembered.get("columns") or task.output_columns)
        return worker.run_task(
            task,
            instruction=instruction,
            obsel_url=args.obsel_url,
            expect_columns=expect_columns,
        )

    while True:
        current = _scale_records(args.obsel_url)
        flagged_now = sorted(n for n, r in current.items() if r.get("stale"))
        if not flagged_now:
            break

        passes += 1
        if passes > len(scale.TASKS):
            raise Unexpected(
                f"scale-repair is {passes - 1} passes deep and obsel still flags "
                f"{', '.join(flagged_now)}. Redoing in dependency order must converge."
            )

        plan = [scale.by_name(name) for name in flagged_now]

        def on_event(event: swarm.Event, outcome: swarm.Outcome, controls: swarm.Controls) -> None:
            if event.kind == "failed":
                print(f"  {event.key:<20} FAILED: {outcome.failures[event.key]}")
                return
            if event.kind != "completed":
                return
            result: worker.RunResult = outcome.results[event.key]
            marked = _print_scale_completion(event.key, result)
            del marked
            restored = _required_list(result.coordination, "restored", f"{event.key}'s redo")
            for entry in restored:
                name = entry["task"]["name"]
                cleared_because[name] = entry["reason"]
                # Only what has not started can leave the plan. A redo already
                # running resolves itself: its own completion clears its mark.
                try:
                    controls.cancel(name)
                    print(f"  >> {name} leaves the plan: obsel cleared it")
                    print(f"     {entry['reason']}")
                except RuntimeError:
                    pass

        outcome = swarm.run_pool(
            plan,
            redo,
            pool_size=args.pool,
            on_event=on_event,
        )
        redone.extend(sorted(outcome.results))
        for key, error in outcome.failures.items():
            raise Unexpected(f"{key}'s redo failed: {error}")

    final = _scale_records(args.obsel_url)
    still = sorted(n for n, r in final.items() if r.get("stale"))
    elapsed = time.perf_counter() - started

    print()
    print(
        f"  redid {len(redone)} of the {len(flagged_at_start)} flagged task(s) "
        f"in {elapsed:.1f} s measured"
    )
    if cleared_because:
        print(f"  obsel cleared {len(cleared_because)} without a re-run: "
              f"{', '.join(sorted(cleared_because))}")
    if estimate_s is not None and len(known) == len(flagged_at_start):
        print(
            f"  against about {estimate_s:.0f} s of agent time to redo all "
            f"{len(flagged_at_start)}, estimated from each task's last measured run"
        )

    if still:
        raise Unexpected(
            f"scale-repair finished and obsel still flags: {', '.join(still)}."
        )
    print("  every flag is off, and every one came off through a redo or a proof")
    return 0


# --------------------------------------------------------------------------
# Self-check
# --------------------------------------------------------------------------


def _expected_hops(changed_table: str) -> dict[str, int]:
    """Who is downstream of `changed_table`, and how far, derived from TASKS.

    The same walk obsel performs over DataHub's lineage graph, done here over the
    demo's own declared shape. It exists so `EXPECTED_CASCADE` cannot quietly stop
    describing the pipeline it is asserted against: edit `pipeline.TASKS` and this
    disagrees, at `pnpm verify` time rather than on camera.
    """
    readers: dict[str, list[str]] = {}
    for task in pipeline.TASKS:
        for source in task.reads:
            readers.setdefault(source, []).append(task.name)

    hops: dict[str, int] = {}
    frontier = [(changed_table, 0)]
    while frontier:
        table, depth = frontier.pop(0)
        for name in sorted(readers.get(table, [])):
            if name in hops:
                continue
            hops[name] = depth + 1
            frontier.append((pipeline.by_name(name).writes, depth + 1))
    return hops


def cmd_self_check(args: argparse.Namespace) -> int:
    """Prove the guards this file's printed claims rest on.

    Run directly: `python -m agents.run self-check`

    Not a demo step. The demo tells an operator to trust the
    `UNEXPECTED:` lines the commands above print, which makes the machinery that
    produces them load-bearing: a guard that cannot fail is not a guard, and one
    that reads a broken reply as a pass is worse than none at all.

    Everything here is deterministic and offline. The commands themselves talk to
    obsel and to Codex and are covered by `tests/live/run-commands.live.test.ts`
    and `tests/live/codex.live.test.ts`.
    """
    failures: list[str] = []

    def check(name: str, condition: bool, detail: str) -> None:
        print(f"  {'pass' if condition else 'FAIL'}  {name}: {detail}")
        if not condition:
            failures.append(name)

    def refused(reply: Any, key: str) -> str:
        """The Unexpected message, or "" if the value came back."""
        try:
            _required_list(reply, key, "a completion report")
        except Unexpected as error:
            return str(error)
        return ""

    def printed(fn: Any, *a: Any, **kw: Any) -> str:
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            fn(*a, **kw)
        return buffer.getvalue()

    # ----------------------------------------------------------------------
    # The distinction the whole file rests on: a reply that said "nothing was
    # affected" against one that never answered. `reply.get(key) or []` collapses
    # the two, and the collapsed value reads as everything being fine.
    # ----------------------------------------------------------------------
    print("obsel's reply, read strictly")

    check(
        "a list comes back as itself",
        _required_list({"affected": [1, 2]}, "affected", "x") == [1, 2],
        "the ordinary case",
    )
    check(
        "an empty list is an answer and is returned",
        _required_list({"affected": []}, "affected", "x") == [],
        "'nothing downstream was affected' is a real result and must not be an error",
    )

    absent = refused({"changedOutputs": []}, "affected")
    check(
        "a missing key is refused, not read as empty",
        absent != "",
        "the one wrong answer that looks exactly like everything being fine",
    )
    check(
        "and the refusal names the key and what did arrive",
        "'affected'" in absent and "changedOutputs" in absent,
        "an operator has to see what obsel sent instead, not just that something was wrong",
    )
    check(
        "and it says why reading it as zero would be wrong",
        "pass" in absent,
        "the message is the only place this reasoning reaches whoever hits it",
    )
    check(
        "a reply carrying no keys at all says so",
        "nothing" in refused({}, "affected"),
        "an empty object would otherwise produce a dangling 'it carries: '",
    )
    check(
        "a key holding something other than a list is refused, by type",
        "str" in refused({"affected": "none"}, "affected"),
        "a string is iterable, so this would otherwise loop over characters",
    )
    check(
        "null is refused rather than treated as absent",
        refused({"affected": None}, "affected") != "",
        "obsel sending null is obsel answering, and the answer is not a list",
    )
    check(
        "a reply that is not an object at all is refused",
        "not an object" in refused(["affected"], "affected"),
        "a list where a reply was expected usually means an error body",
    )

    # ----------------------------------------------------------------------
    # What the operator reads while it runs.
    # ----------------------------------------------------------------------
    print()
    print("what the commands print")

    clean_urn = pipeline.dataset_urn("clean_orders")
    check(
        "a dataset URN shortens to the table name",
        _short(clean_urn) == "clean_orders",
        f"{clean_urn} is not a thing to say out loud",
    )
    check(
        "something that is not a URN is left alone",
        _short("clean_orders") == "clean_orders",
        "shortening must never turn an already-short name into an empty string",
    )

    quiet = printed(_print_coordination, {}, False)
    check(
        "a task obsel was not told about prints nothing",
        quiet == "",
        "`--report False` runs exist and must not narrate a coordination that never happened",
    )

    first = printed(
        _print_coordination,
        {"changedOutputs": [], "affected": [], "restored": [], "elapsedMs": 12},
        True,
    )
    check(
        "a first run says there was nothing to compare against",
        "first version" in first,
        "marking nothing on a first run proves nothing, and the line must not imply it does",
    )
    same = printed(
        _print_coordination,
        {"changedOutputs": [], "affected": [], "restored": [], "elapsedMs": 12},
        False,
    )
    check(
        "an identical re-run says nothing was marked stale",
        "identical" in same and "nothing marked stale" in same,
        "the quiet step of the demo, and the reason anyone trusts the loud one",
    )
    check(
        "the two are worded differently",
        first != same,
        "they are different facts; one is 'no baseline', the other is 'no change'",
    )

    nobody = printed(
        _print_coordination,
        {
            "changedOutputs": [{"dataset": clean_urn, "kind": "schema"}],
            "affected": [],
            "restored": [],
            "elapsedMs": 40,
        },
        False,
    )
    check(
        "a change with nothing finished downstream says exactly that",
        "nothing downstream had finished" in nobody,
        "not the same as 'nothing changed', and the demo passes through this state",
    )

    def mark(name: str, hops: int) -> dict[str, Any]:
        return {
            "task": {"name": name},
            "mark": {"hops": hops, "reason": f"{name} is built on a renamed column"},
        }

    cascade = printed(
        _print_coordination,
        {
            "changedOutputs": [{"dataset": clean_urn, "kind": "schema"}],
            "affected": [mark("build_revenue", 1), mark("write_report", 2)],
            "restored": [],
            "elapsedMs": 213,
        },
        False,
    )
    check(
        "a cascade reports how many were marked, and in how long",
        "marked 2 finished task(s) stale in 213 ms" in cascade,
        "a measured number, because 'immediately' is not a claim this project makes",
    )
    check(
        "one hop is singular and two are plural",
        "1 hop " in cascade and "2 hops" in cascade,
        "'1 hops' on screen reads as a bug in the thing being demonstrated",
    )
    check(
        "each mark carries its reason",
        "built on a renamed column" in cascade,
        "a mark with no traceable cause is not actionable, which is a correctness rule",
    )
    untimed = printed(
        _print_coordination, {"changedOutputs": [], "affected": [], "restored": []}, False
    )
    check(
        "an unreported elapsed time says so rather than printing None",
        "(unreported)" in untimed and "None" not in untimed,
        "'None ms' would read as a measurement, and this project only prints measured numbers",
    )
    redone = printed(
        _print_coordination,
        {
            "changedOutputs": [],
            "affected": [],
            "restored": [
                {
                    "task": {"name": "write_docs"},
                    "reason": "build revenue redid daily revenue and it came out identical",
                }
            ],
            "elapsedMs": 60,
        },
        False,
    )
    check(
        "an identical redo prints the flags it earned off, beside the quiet line",
        "nothing marked stale" in redone
        and "cleared write_docs without a re-run" in redone
        and "came out identical" in redone,
        "the repair's account: the same event is a quiet comparison and a cleared flag",
    )
    check(
        "a reply missing restored is refused, not read as nothing cleared",
        refused({"changedOutputs": [], "affected": []}, "restored") != "",
        "a lost key must not silently hide work that flipped back to sound",
    )

    # ----------------------------------------------------------------------
    # The claim the `change` command checks itself against.
    # ----------------------------------------------------------------------
    print()
    print("the cascade the demo asserts")

    derived = _expected_hops(pipeline.TASKS[0].writes)
    check(
        "EXPECTED_CASCADE still describes the pipeline",
        derived == EXPECTED_CASCADE,
        f"walked from {pipeline.TASKS[0].writes}: {derived}",
    )
    check(
        "the two-hop tasks genuinely never read the changed table",
        all(
            pipeline.TASKS[0].writes not in pipeline.by_name(name).reads
            for name, hops in EXPECTED_CASCADE.items()
            if hops > 1
        ),
        "the whole point: reached through daily_revenue, not by touching clean_orders",
    )
    check(
        "the changed task is not downstream of itself",
        pipeline.TASKS[0].name not in EXPECTED_CASCADE,
        "a task that re-ran is not stale work; it IS the new work",
    )

    # ----------------------------------------------------------------------
    # The order repair redoes flagged work in.
    # ----------------------------------------------------------------------
    print()
    print("the order repair redoes work in")

    cascade_order = [task.name for task in _repair_order(set(EXPECTED_CASCADE))]
    check(
        "the demo's flagged set repairs producers before consumers",
        cascade_order[0] == "build_revenue"
        and set(cascade_order[1:]) == {"write_report", "write_docs"},
        "redoing build_revenue first is what gives obsel the chance to clear the other two",
    )
    check(
        "a task that is not flagged is not redone",
        [task.name for task in _repair_order({"write_docs"})] == ["write_docs"],
        "repair touches exactly what obsel flagged, nothing beside it",
    )
    check(
        "an empty flagged set redoes nothing",
        _repair_order(set()) == [],
        "repair on a clean board is a no-op, not an error",
    )

    # ----------------------------------------------------------------------
    # The scale choreography: the cues behind the mid-run change.
    # ----------------------------------------------------------------------
    print()
    print("the scale choreography")

    hop1 = _scale_hop1()
    check(
        "the held reader reads the changed table directly",
        SCALE_HELD_READER in hop1,
        "holding anything else would not put a straddling read on camera",
    )
    unheld = set(hop1) - {SCALE_HELD_READER}
    check(
        "the change is cued once every unheld direct reader is done",
        _scale_trigger_met(unheld) and _scale_trigger_met(unheld | {"report_city"}),
        "extra completions never un-cue it",
    )
    some = next(iter(sorted(unheld)))
    check(
        "one unfinished direct reader is enough to wait",
        not _scale_trigger_met(unheld - {some}),
        f"with {some} still working the cascade would have too little finished work to show",
    )
    check(
        "the change runs under a key no task owns",
        SCALE_CHANGE_KEY not in {t.name for t in scale.TASKS},
        "a collision would make the pool refuse the change as a duplicate",
    )

    # ----------------------------------------------------------------------
    # Real files, in a scratch directory.
    # ----------------------------------------------------------------------
    print()
    print("what the commands touch on disk")

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)

        check(
            "no data directory reads as no tables, not as a crash",
            _read_tables(root) == {},
            "`change --capture` runs before anything has been written",
        )

        printed(ensure_seed, root)
        seeded = _read_tables(root)
        check(
            "seeding writes the one table nothing in the swarm produces",
            pipeline.SEED_TABLE in seeded and len(seeded[pipeline.SEED_TABLE]["rows"]) > 0,
            "every agent reads from raw_orders, directly or through another agent",
        )

        before = worker.table_path(pipeline.SEED_TABLE, root).read_bytes()
        printed(ensure_seed, root)
        check(
            "seeding again leaves the existing table alone",
            worker.table_path(pipeline.SEED_TABLE, root).read_bytes() == before,
            "re-seeding mid-demo would change an input under agents that already read it",
        )

        # reset against an obsel that is not there. Real HTTP to a port nothing is
        # listening on, so this is the actual failure an operator hits when they
        # forget `pnpm dev` -- and the property being checked is that it costs them
        # nothing.
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            dead_port = probe.getsockname()[1]

        canary = root / ".obsel" / "data" / "clean_orders.json"
        canary.parent.mkdir(parents=True, exist_ok=True)
        canary.write_text('{"columns": [], "rows": []}\n', encoding="utf-8")

        dead = argparse.Namespace(obsel_url=f"http://127.0.0.1:{dead_port}", capture=None)
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            dead_code = cmd_reset(dead, root)
        dead = buffer.getvalue()

        check(
            "reset against an obsel that is not running fails",
            dead_code == 1,
            "an unreachable coordinator is not a successful reset",
        )
        check(
            "and it deletes nothing locally",
            canary.exists(),
            "clearing local files while DataHub still holds the fingerprints leaves the "
            "two halves disagreeing, and the next run compares against a table that is gone",
        )
        check(
            "and it says nothing local was touched",
            "Nothing local was touched" in dead,
            "the operator has to know the machine is still in a state they can re-run from",
        )

    # ----------------------------------------------------------------------
    # Which of two different problems the operator is looking at.
    # ----------------------------------------------------------------------
    print()
    print("how failures are labelled")

    # Registered for the length of this check, then removed. Not a stand-in for a
    # command: it is a command, whose job is to raise, because the labelling under
    # test happens in `main` around whatever the dispatcher returns.
    COMMANDS["raise-unexpected"] = _raises(Unexpected("obsel reported no 'affected' key"))
    COMMANDS["raise-runtime"] = _raises(RuntimeError("DataHub is not up"))
    try:
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            unexpected_code = main(["raise-unexpected"])
        unexpected_text = buffer.getvalue()

        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            runtime_code = main(["raise-runtime"])
        runtime_text = buffer.getvalue()
    finally:
        del COMMANDS["raise-unexpected"]
        del COMMANDS["raise-runtime"]

    check(
        "obsel answering wrongly is labelled UNEXPECTED and exits non-zero",
        unexpected_code == 1 and "UNEXPECTED:" in unexpected_text,
        "the demo ran and obsel is wrong -- the one outcome that must never be quiet",
    )
    check(
        "the demo failing to run is labelled stopped",
        runtime_code == 1 and runtime_text.strip().startswith("stopped:"),
        "'DataHub is not up' is the operator's problem, not evidence about obsel",
    )
    check(
        "the two labels are distinguishable",
        "UNEXPECTED:" not in runtime_text,
        "the demo tells the operator to tell these apart, so they must differ",
    )

    # argparse writes its usage to stderr and exits. Both are swallowed here, so
    # the check reports the exit code rather than leaving a usage block in the
    # middle of a passing run that reads as a failure.
    unknown = 0
    try:
        with contextlib.redirect_stderr(io.StringIO()):
            main(["not-a-command"])
    except SystemExit as exit_code:
        unknown = int(exit_code.code or 0)
    check(
        "an unknown command is refused",
        unknown == 2,
        "argparse's own exit code, so a typo in the demo script fails loudly",
    )

    print()
    if failures:
        print(f"FAILED: {', '.join(failures)}")
        return 1
    print("every printed claim rests on something that can fail")
    return 0


def _raises(error: BaseException) -> Any:
    """A command whose whole job is to raise, used to check `main`'s labelling."""

    def command(args: argparse.Namespace) -> int:
        raise error

    return command


COMMANDS = {
    "setup": cmd_setup,
    "register": cmd_register,
    "run": cmd_run,
    "rerun-same": cmd_rerun_same,
    "change": cmd_change,
    "repair": cmd_repair,
    "reset": cmd_reset,
    "scale-register": cmd_scale_register,
    "scale-run": cmd_scale_run,
    "scale-change": cmd_scale_change,
    "scale-repair": cmd_scale_repair,
    "self-check": cmd_self_check,
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agents.run", description=__doc__)
    parser.add_argument("command", choices=sorted(COMMANDS))
    parser.add_argument(
        "--obsel-url",
        default=worker.OBSEL_URL,
        help="where obsel is running (default %(default)s)",
    )
    parser.add_argument(
        "--capture",
        metavar="DIR",
        default=None,
        help=(
            "with `change`, write swarm-before.json, coordination-result.json and "
            "swarm-after.json into DIR, all from this one run"
        ),
    )
    parser.add_argument(
        "--pool",
        type=int,
        default=8,
        help="with `scale-run`, how many Codex sessions may run at once (default %(default)s)",
    )
    parser.add_argument(
        "--change-during",
        action="store_true",
        help=(
            "with `scale-run`, re-run the change task with its renamed column while "
            "other agents are still working, instead of running everything unchanged"
        ),
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
