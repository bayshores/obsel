"""The demo, driven from one command line.

    python -m agents.setup        # or: python -m agents.run setup
    python -m agents.run run
    python -m agents.run rerun-same
    python -m agents.run change
    python -m agents.run repair

`run` declares whatever obsel has no record of before running, so this sequence
starts from an empty board. `register` still exists and re-declares all four,
which is what to use after changing what a task reads or writes.

The four-agent steps are in `run_demo.py`, the forty-agent ones in `run_scale.py`,
and what both print and how both read obsel's replies is in `demo_output.py`.

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
import socket
import sys
import tempfile
from pathlib import Path
from typing import Any

from agents import pipeline, scale, worker
from agents.demo_output import (
    Unexpected,
    _print_coordination,
    _required_list,
    _short,
    ensure_seed,
    missing_names,
)
from agents.run_demo import (
    EXPECTED_CASCADE,
    cmd_change,
    cmd_register,
    cmd_repair,
    cmd_rerun_same,
    cmd_reset,
    cmd_run,
    cmd_setup,
    _read_tables,
    _repair_order,
)
from agents.run_scale import (
    SCALE_CHANGE_KEY,
    SCALE_HELD_READER,
    cmd_scale_change,
    cmd_scale_register,
    cmd_scale_repair,
    cmd_scale_run,
    _scale_hop1,
    _scale_trigger_met,
)

REPO_ROOT = worker.REPO_ROOT


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
    obsel and to the agent CLI and are covered by `tests/live/run-commands.live.test.ts`
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
    # What `run` registers for itself. The set has to be exactly the absent
    # tasks: a re-declaration puts a task back to `registered`, so registering
    # one obsel already holds would discard a finished board's state.
    # ----------------------------------------------------------------------
    print()
    print("the tasks a run declares for itself")

    board = [
        {"urn": pipeline.task_urn("clean_orders")},
        {"urn": pipeline.task_urn("build_revenue")},
    ]
    every = [(task.name, pipeline.task_urn(task.name)) for task in pipeline.TASKS]

    check(
        "an empty board is missing every task",
        missing_names([], every) == [task.name for task in pipeline.TASKS],
        "the first run of a fresh page registers all four",
    )
    check(
        "a full board is missing none",
        missing_names([{"urn": urn} for _, urn in every], every) == [],
        "a board that has already run must be left alone entirely",
    )
    check(
        "a partial board names only what is absent",
        missing_names(board, every) == [
            task.name for task in pipeline.TASKS if task.name not in ("clean_orders", "build_revenue")
        ],
        "registering a task obsel holds would reset its status and lose its finished state",
    )
    check(
        "the order asked for is the order returned",
        missing_names([], [("b", "urn:b"), ("a", "urn:a")]) == ["b", "a"],
        "the caller asks in dependency order and registers in the order it gets back",
    )
    check(
        "a task obsel holds under a different urn counts as absent",
        missing_names([{"urn": "urn:li:dataJob:(other,clean_orders)"}], every)
        == [task.name for task in pipeline.TASKS],
        "the urn is what obsel filed it under; a matching name under another urn is another task",
    )
    check(
        "an entry that is not an object is skipped rather than crashing the run",
        missing_names(["clean_orders", None], every) == [task.name for task in pipeline.TASKS],
        "a malformed board entry must not stop a run that was about to fix the board",
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
        help="with `scale-run`, how many agent sessions may run at once (default %(default)s)",
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
