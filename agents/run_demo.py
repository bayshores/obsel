"""The four-agent demo, one command per step.

    python -m agents.run run
    python -m agents.run rerun-same
    python -m agents.run change
    python -m agents.run repair

`run` declares whatever obsel has no record of before it runs anything, so
starting from an empty board takes one command. `register` remains for
re-declaring all four after a change to what they read or write.

`rerun-same` before `change` on purpose: it establishes that a re-run producing
the same table marks nothing, so when `change` lights up three tasks a second
later, the difference is the rename and not the re-run.

Every outcome printed here is read back from obsel. Each command states one
specific claim, checks it against what obsel actually returned, and prints an
`UNEXPECTED:` line and exits non-zero when the two differ.
"""

from __future__ import annotations

import argparse
import json
import shutil
import time
from pathlib import Path
from typing import Any

from agents import pipeline, worker
from agents.fingerprint import fingerprint
from agents.demo_output import (
    Unexpected,
    _demo_tasks,
    _print_run,
    _required_list,
    _rule,
    _short,
    ensure_seed,
    missing_names,
)

REPO_ROOT = worker.REPO_ROOT


# --------------------------------------------------------------------------
# Steps
# --------------------------------------------------------------------------



def cmd_setup(args: argparse.Namespace) -> int:
    from agents import setup

    _rule("setup: registering obsel's vocabulary in DataHub")
    code = setup.main()
    if code != 0:
        return code
    print()
    ensure_seed()
    return 0


def _register_one(task: pipeline.AgentTask, args: argparse.Namespace) -> int:
    """Declare one task to obsel and check the urn it filed it under.

    Shared by `register` and by the registration `run` performs for itself, so
    the two cannot declare the same task differently.
    """
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
        headers=worker.auth_headers(),
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


def cmd_register(args: argparse.Namespace) -> int:
    _rule("register: putting the four agent tasks into DataHub")
    ensure_seed()
    print()
    for task in pipeline.in_dependency_order():
        code = _register_one(task, args)
        if code != 0:
            return code
    return 0


def _register_missing(args: argparse.Namespace) -> int:
    """Declare whichever of the four tasks obsel has no record of.

    `run` does this itself so that running the demo is one action rather than
    two. It registers only what is absent: re-declaring a task obsel already
    holds sets its status back to `registered`, and on a board that has already
    run that would throw away the finished state the page reads off it.
    """
    expected = [(task.name, pipeline.task_urn(task.name)) for task in pipeline.in_dependency_order()]
    absent = missing_names(worker.read_swarm(args.obsel_url)["snapshot"]["tasks"], expected)
    if not absent:
        return 0

    print(f"  obsel had no record of {len(absent)} of the {len(expected)} tasks; declaring them now")
    by_name = {task.name: task for task in pipeline.in_dependency_order()}
    for name in absent:
        code = _register_one(by_name[name], args)
        if code != 0:
            return code
    print()
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
    code = _register_missing(args)
    if code != 0:
        return code
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
