"""The forty-agent taxi swarm: a bounded pool, and a change landing mid-run.

    python -m agents.run scale-register
    python -m agents.run scale-run
    python -m agents.run scale-change
    python -m agents.run scale-repair

The same guards as the four-agent demo in `run_demo.py`: every claim printed is
read back from obsel and checked, and a disagreement exits non-zero.
"""

from __future__ import annotations

import argparse
import time
from typing import Any

from agents import pipeline, scale, worker
from agents.demo_output import (
    Unexpected,
    _required_list,
    _rule,
    _short,
    register_missing,
    register_one,
)

REPO_ROOT = worker.REPO_ROOT


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


def _register_scale_one(task: pipeline.AgentTask, args: argparse.Namespace) -> int:
    """Declare one taxi task, shared by `scale-register` and by `scale-run`."""
    code, _ = register_one(
        args.obsel_url,
        name=task.name,
        # Qualified with the scale namespace, which the server passes through
        # untouched; a short name here would land the task's edges under the
        # demo's tables.
        reads=[f"{scale.NAMESPACE}.{source}" for source in task.reads],
        writes=[f"{scale.NAMESPACE}.{task.writes}"],
        description=task.summary,
        title=task.title,
        expected_urn=scale.task_urn(task.name),
    )
    if code != 0:
        return code
    print(f"  {task.name:<18} registered")
    return 0


def cmd_scale_register(args: argparse.Namespace) -> int:
    _rule("scale-register: putting the forty taxi tasks into DataHub")
    written = scale.install_seeds(REPO_ROOT)
    for name in written:
        print(f"  seeded {name} from the committed extract (hash checked)")
    print()

    started = time.perf_counter()
    for task in scale.in_dependency_order():
        code = _register_scale_one(task, args)
        if code != 0:
            return code

    elapsed = time.perf_counter() - started
    print()
    print(f"  all {len(scale.TASKS)} tasks registered in {elapsed:.1f} s")
    return 0


def _register_scale_missing(args: argparse.Namespace) -> int:
    """Declare whichever of the forty taxi tasks obsel has no record of.

    `_scale_records` still refuses a board with tasks missing. That check runs
    after the swarm, where an absent task means a run that did not do what it
    claimed, and this registration cannot mask it.
    """
    return register_missing(
        args.obsel_url,
        tasks=scale.in_dependency_order(),
        task_urn=scale.task_urn,
        register=lambda task: _register_scale_one(task, args),
    )


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
    from agents import runner_select

    # Named rather than assumed: the operator can pick with OBSEL_RUNNER, and a
    # line saying Codex above forty Claude Code sessions would be the terminal
    # disagreeing with the board about what did the work.
    print(
        f"  pool: up to {args.pool} {runner_select.PRODUCT[runner_select.resolve()]} "
        "sessions at once"
    )
    print()

    code = _register_scale_missing(args)
    if code != 0:
        return code

    started = time.perf_counter()
    cued = {"change": False, "at": 0.0, "released": not change_during}
    marked_by: list[tuple[str, str]] = []
    change_reply: dict[str, Any] = {}
    in_flight_at_mark: list[str] = []

    # How long after cueing the change the held reader is released. The change
    # re-run is a real agent session that takes tens of seconds; releasing the
    # reader at the cue let a 26-second reader finish before a 50-second change
    # landed (observed live on Codex, first mid-run attempt), so the straddle
    # never happened and the reader was marked by the ordinary cascade instead. A
    # short delay puts the reader's run inside the change's. The agent being
    # live, either path can still occur, and both are asserted correct below; the
    # delay only raises the odds of the straddling one being on the board.
    #
    # The number was tuned against Codex session lengths and has not been
    # re-measured on Claude Code, so a taxi run there may straddle less often.
    # Both outcomes are still asserted, so it cannot make the run wrong.
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
        instruction, expect_columns = worker.remembered_run(task)
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
