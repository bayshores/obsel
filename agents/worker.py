"""An agent worker: read your inputs, do the job, report in.

Each of the four demo agents is this file with a different job description. A run
is five steps:

1. Load the input tables from `.obsel/data/`.
2. Tell obsel the task has started, so the board can show work in flight while it
   is in flight.
3. Let the agent do the work: a real session in the data directory, with its own
   tools, which reads, decides, and writes the output table itself.
4. Hold that output to its contract -- the exact column names, and one serialised
   form per numeric column. See `canonicalise_numbers`.
5. Save it, fingerprint it, and POST that to obsel, which decides what the change
   breaks.

Step 2 comes before step 3, and that ordering is load-bearing in both directions.
Announcing afterwards left obsel holding the task at `registered` for the whole
20-50 seconds an agent actually works, so the board said "waiting" about an agent
mid-job. Announcing beforehand means a run that dies owes the announcement back,
because obsel skips `running` work in the cascade and a wedged task would be
invisible to every later traversal. `run_task` does both halves.

The runner is a real coding CLI -- Codex through `codex exec`, or Claude Code
through `claude -p`, chosen by `runner_select.py`. Both authenticate through
their own CLI. There is no API-key path and no offline mode: if the chosen one is
not installed or not signed in, the run fails and says so. A demo that quietly
fakes the model is worse than one that does not run.

An earlier design asked the model for a JSON plan and applied it with
deterministic code, which made a byte-identical re-run a property of the
construction. An agent writing the table directly gives that up, which is why
step 4 exists: the agent decides what the numbers are, and the worker decides how
they are written down, so the same table twice hashes the same twice.

Steps 1, 4 and 5's disk half are in `agents/tables.py`; steps 2 and 5's HTTP half
are in `agents/obsel_client.py`. This file is the run itself, and re-exports both
so that callers keep reaching them through `worker.`.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from agents import mcp_core, pipeline
from agents.fingerprint import fingerprint

# Re-exported rather than moved out of reach: every caller reaches these through
# `worker.`, and `agents/tables.py` and `agents/obsel_client.py` are where they
# now live.
from agents.obsel_client import (  # noqa: F401
    MUTATION_TIMEOUT,
    OBSEL_URL,
    abandon_run,
    announce_start,
    auth_headers,
    get_json,
    has_recorded_output,
    obsel_task,
    post_json,
    read_swarm,
    report_completion,
    _send,
)
from agents.tables import (  # noqa: F401
    REPO_ROOT,
    Table,
    canonicalise_numbers,
    data_dir,
    load_table,
    save_table,
    table_path,
)

# What does the work: a real session of a coding CLI, running in the data
# directory with its own tools. The agent reads, decides, and writes the table
# itself -- an agent rather than a single model call, which is what the hackathon
# category asks for. `runner_select.py` says which CLI; there is no other kind of
# runner, and in particular no API-key path.
#
# It is not byte-reproducible on its own. Measured 2026-07-22 across four live
# runs over the identical seed, one wrote a money value `217` where the others
# wrote `217.0` -- so the worker canonicalises the output before hashing it, and
# the demo's "a re-run marks nothing" step rests on that rather than on luck.


# --------------------------------------------------------------------------
# Running one agent
# --------------------------------------------------------------------------


@dataclass
class RunResult:
    task: str
    output_table: str
    output_path: str
    columns: list[str]
    row_count: int
    fingerprints: dict[str, dict[str, str]]
    plan_source: str  # "model" or "cache"
    plan_notes: str
    model_seconds: float
    total_seconds: float
    coordination: dict[str, Any] = field(default_factory=dict)
    #: How this run entered obsel's `running` state: "announced" for a normal run,
    #: "resumed" when a previous attempt of this same task announced its start and
    #: then failed, "not reported" when the run did not talk to obsel at all.
    start: str = "announced"


def _remember_run(
    task_name: str, instruction: str, columns: list[str], root: Path = REPO_ROOT
) -> None:
    """Record what a task was last told to do, and the columns it actually wrote.

    `run.py rerun-same` needs this: re-running an agent with whatever it last ran
    is the only way to demonstrate "no change, no alarm" honestly at any point in
    the demo, including after the rename.

    The columns are remembered **together with** the instruction, and that is the
    fix for a live failure on 2026-07-22: rerun-same replayed the changed
    instruction ("name the column order_total_usd") but passed no column
    contract, so the worker fell back to the task's standing `output_columns` —
    the ORIGINAL names — and the contract won. The re-run reverted the rename,
    obsel correctly flagged a genuine schema change, and the step's own assertion
    failed. An instruction and a contract from two different runs can contradict
    each other; a pair recorded by one successful run cannot.
    """
    path = root / ".obsel" / "state" / "instructions.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    known = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    known[task_name] = {"instruction": instruction, "columns": columns}
    path.write_text(json.dumps(known, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def last_run(task_name: str, root: Path = REPO_ROOT) -> dict[str, Any] | None:
    """The last successful run's instruction and output columns, or None.

    Tolerates the pre-2026-07-22 format, where the value was the instruction
    string alone — `columns` comes back None and the caller falls back to the
    task's standing contract, which is exactly the old (buggy after a `change`)
    behaviour; a `reset` clears such entries.
    """
    path = root / ".obsel" / "state" / "instructions.json"
    if not path.exists():
        return None
    entry = json.loads(path.read_text(encoding="utf-8")).get(task_name)
    if entry is None:
        return None
    if isinstance(entry, str):
        return {"instruction": entry, "columns": None}
    return entry


def remembered_run(task: pipeline.AgentTask, root: Path = REPO_ROOT) -> tuple[str, tuple[str, ...]]:
    """What to replay for this task: its last run's instruction AND column contract.

    The two are returned together and must be used together. Replaying an
    instruction against a contract recorded by a different run is how a redo
    quietly reverts a change instead of absorbing one: on 2026-07-22 the changed
    instruction said `order_total_usd`, the standing contract said `order_total`,
    the contract won, and `rerun-same` reverted the rename. A task obsel has no
    record of falls back to its standing pair, which is the same pair.

    Every caller that redoes work goes through this -- `rerun-same`, the serial
    repair and the pooled one -- because three copies of a two-line pairing is
    three chances for one of them to keep only half of it.
    """
    remembered = last_run(task.name, root) or {}
    return (
        remembered.get("instruction") or task.instruction,
        tuple(remembered.get("columns") or task.output_columns),
    )


def _inflight_path(task_name: str, root: Path = REPO_ROOT) -> Path:
    return root / ".obsel" / "state" / "inflight" / f"{task_name}.json"


def _enter_running(task_name: str, task_urn: str, obsel_url: str, root: Path) -> str:
    """Get obsel to `running` for this task, and leave a note that we did.

    obsel refuses a second `start` for a task it already has at `running`, which is
    right -- two agents writing the same output at once is a real error. But it also
    means that if this worker announced a start and then died, a retry is refused and
    the task sits at `running` forever, and obsel's rule is that only *finished*
    work can go stale. A task wedged at `running` is invisible to obsel while the
    board still looks healthy, which is the exact silent blindness obsel exists to
    prevent.

    So the marker file records "this worker put that task into running and has not
    finished it yet". On a retry the marker means the precondition already holds and
    the announcement is skipped rather than re-sent. The marker is written *before*
    the announcement and removed if the announcement fails, so it can never claim a
    running state that obsel does not have. `run.py reset` deletes `.obsel/state`,
    which clears these along with everything else.

    The marker on its own is never trusted to describe obsel. A local file outlives
    the state it describes -- obsel may have been reset, or the swarm re-registered
    -- and announcing "obsel already has this at running" on the strength of a file
    on disk is the same defect obsel exists to catch: describing a remote system's
    state from something local that was never checked. The marker decides only
    whether to ask; obsel decides what is true.

    Returns "announced" or "resumed".
    """
    marker = _inflight_path(task_name, root)
    if marker.exists():
        # Confirm with obsel rather than assume. If obsel does not in fact hold the
        # task at running, the marker is left over from an earlier cycle, and the
        # start still has to be announced -- otherwise this run reports a completion
        # for a run obsel never saw begin.
        if obsel_task(task_urn, obsel_url).get("status") == "running":
            return "resumed"
        marker.unlink(missing_ok=True)

    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(
        json.dumps(
            {"task": task_name, "urn": task_urn, "at": datetime.now(timezone.utc).isoformat()},
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    try:
        announce_start(task_urn, obsel_url)
    except BaseException:
        marker.unlink(missing_ok=True)
        raise
    return "announced"


def _leave_running(task_name: str, root: Path) -> None:
    _inflight_path(task_name, root).unlink(missing_ok=True)


def _abandon_running(task_name: str, task_urn: str, obsel_url: str, root: Path) -> None:
    """Undo an announcement after the work behind it failed.

    Used only on the path where the agent never produced a table. Nothing was
    written, so the honest state is the one the task had before it started, and a
    retry is then an ordinary run rather than a resume.

    Deliberately swallows its own failure. This runs inside an `except` block,
    and obsel being unreachable here would replace "the agent CLI is not signed in" --
    the thing that actually went wrong and the thing the operator has to fix --
    with a connection error about the cleanup. The marker file stays put when
    this fails, which is what makes the next attempt a resume instead of a
    silently wedged task.
    """
    try:
        abandon_run(task_urn, obsel_url)
    except Exception:
        return
    _leave_running(task_name, root)


def work_dir(task_name: str, root: Path = REPO_ROOT) -> Path:
    """This task's private working directory for one run."""
    return root / ".obsel" / "work" / task_name


def _snapshot_inputs(
    task: pipeline.AgentTask,
    canonical_inputs: dict[str, Table],
    root: Path,
) -> Path:
    """Write the exact tables that were hashed into a private working directory.

    The agent reads these copies, never the shared data directory. This exists
    for the concurrent swarm: the input observation is hashed from the tables
    loaded at the top of `run_task`, but the agent session reads its input FILES
    seconds later, and in a concurrent swarm an upstream re-run can replace a
    shared file in that gap. The observation would then describe bytes the agent
    never saw, and every conclusion obsel draws from it — including the
    straddling-reader mark — would be about the wrong read. Snapshotting the
    loaded tables makes the hash and the agent's read the same bytes by
    construction.

    The canonical form is written, because the canonical form is what was
    hashed. Published tables are already canonical (every writer canonicalises
    before saving), so for tables written by these workers the copies are
    byte-identical to the originals anyway.
    """
    directory = work_dir(task.name, root)
    if directory.exists():
        import shutil

        shutil.rmtree(directory)
    directory.mkdir(parents=True)
    for name, table in canonical_inputs.items():
        (directory / f"{name}.json").write_text(
            json.dumps(table, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
    return directory


def _run_agent(
    task: pipeline.AgentTask,
    job: str,
    expect_columns: tuple[str, ...] | None,
    working_dir: Path,
) -> tuple[Table, float, str, str]:
    """Run this task as a real agent session and return what it produced.

    The agent works in the task's private working directory: it reads the
    snapshotted inputs and writes its output as ordinary files. The table comes
    back from disk rather than from the agent's reply, because what is on disk
    is what gets published for the next agent and what obsel will fingerprint.

    Which CLI runs is `runner_select`'s decision, and its name is returned
    alongside the table so the completion report says which product did the work
    rather than assuming. Imported here rather than at module scope so that
    importing `worker` needs no CLI installed.
    """
    from agents import runner_select

    runner_name = runner_select.resolve()
    module = runner_select.runner(runner_name)

    contract = list(expect_columns or task.output_columns) or None
    table, seconds, version = module.run_agent(
        instruction=job,
        input_files=[f"{name}.json" for name in task.reads],
        output_file=f"{task.writes}.json",
        working_dir=working_dir,
        expect_columns=contract,
    )
    return table, seconds, version, runner_name


def run_task(
    task: pipeline.AgentTask,
    *,
    instruction: str | None = None,
    obsel_url: str = OBSEL_URL,
    report: bool = True,
    root: Path = REPO_ROOT,
    expect_columns: tuple[str, ...] | None = None,
) -> RunResult:
    """Do this agent's job end to end and tell obsel what came out."""
    started = time.perf_counter()
    job = instruction if instruction is not None else task.instruction
    task_urn = pipeline.task_urn(task.name)

    # Inputs first, and still before the announcement. A missing input is this
    # machine's problem and has nothing to do with obsel's view of the swarm, so
    # failing here should leave the task exactly as it was.
    inputs = {name: load_table(name, root) for name in task.reads}
    canonical_inputs = {name: canonicalise_numbers(table) for name, table in inputs.items()}

    # Hashed now, before the agent touches anything, because this is the exact
    # version the work is about to be built on. Reported alongside the output at
    # completion: if what was read here disagrees with what its producer recorded
    # writing, the table was changed by something that never told obsel, and this
    # report is the only evidence of that anywhere. Canonicalised first, so the
    # observation uses the same definition of "changed" as every fingerprint.
    #
    # Each input is hashed with ITS PRODUCER'S declared volatile columns, read off
    # the board like any other reader would. A reader that applied its own idea of
    # what is meaningless -- or none at all -- would produce a fingerprint the
    # producer could never produce, and obsel would read the disagreement as a
    # change nothing reported: a false alarm with no author to name.
    volatile = mcp_core.volatile_by_dataset(
        read_swarm(obsel_url)["snapshot"]["tasks"]
    )
    observed_inputs = {
        pipeline.task_dataset_urn(task, name): {
            **fingerprint(
                canonical["rows"],
                canonical["columns"],
                exclude=volatile.get(pipeline.task_dataset_urn(task, name), []),
            ),
            "columns": list(canonical["columns"]),
        }
        for name, canonical in canonical_inputs.items()
    }

    # The agent reads private copies of exactly the tables hashed above, so the
    # observation and the agent's read are the same bytes even while another
    # task is replacing the shared file. See `_snapshot_inputs`.
    working_dir = _snapshot_inputs(task, canonical_inputs, root)

    # ORDER MATTERS, and it is the reverse of what it once was.
    #
    # The announcement used to come *after* the agent, so that a failed run could
    # not wedge the task at `running` -- where obsel, which only ever marks
    # *finished* work stale, would skip it in every later traversal while the board
    # still showed a healthy swarm.
    #
    # The cost was that obsel had no idea an agent was working. For the whole 20
    # to 50 seconds a real agent session takes, obsel held the task at
    # `registered` and the page said "waiting" about an agent that was at that
    # moment doing its job. The one thing a person watching wants to know -- is it
    # working or is it stuck -- was the one thing the board could not say.
    #
    # So the announcement moves in front of the work and the wedge is closed
    # directly instead: if the agent fails, `_abandon_running` hands the
    # announcement back and the task returns to `registered`. The property the old
    # order bought -- a failed run leaves the task as it was -- still holds, and
    # now the board tells the truth while the work is happening.
    start = "not reported"
    if report:
        start = _enter_running(task.name, task_urn, obsel_url, root)

    # The agent reads and writes the table itself, with its own tools. Its output
    # is read back off disk and checked against the column contract before obsel
    # hears anything -- a plausible-looking bad table would fingerprint as a real
    # change and mark the chain stale for nothing.
    try:
        output, model_seconds, plan_source, runner_name = _run_agent(
            task, job, expect_columns, working_dir
        )
    except BaseException:
        # Nothing was produced, so there is no partial result to resume from and
        # the honest state is the one before the announcement. BaseException, not
        # Exception: a Ctrl-C during a 50-second agent is the most likely way this
        # is ever hit, and it must not leave the task wedged either.
        if report:
            _abandon_running(task.name, task_urn, obsel_url, root)
        raise

    # Before anything is saved or hashed, so the file on disk and the fingerprint
    # obsel records describe the same bytes. Hashing a canonical table and saving
    # a non-canonical one would put the two permanently out of step.
    output = canonicalise_numbers(output)

    plan = {"runner": runner_name, "agent": plan_source}

    try:
        output_path = save_table(task.writes, output, root)
        _remember_run(task.name, job, list(output["columns"]), root)

        fingerprints = {
            pipeline.task_dataset_urn(task, task.writes): fingerprint(
                output["rows"],
                output["columns"],
                # This task's own declaration, for its own output.
                exclude=volatile.get(pipeline.task_dataset_urn(task, task.writes), []),
            )
        }
        finished_at = datetime.now(timezone.utc).isoformat()

        # What the page shows about this run. Every figure here is already
        # printed to the terminal; sending it is what stops the board from being
        # the one place that cannot say what an agent actually did.
        run_detail = {
            "runner": plan_source,
            "ms": round(model_seconds * 1000),
            "outputs": {
                pipeline.task_dataset_urn(task, task.writes): {
                    "rows": len(output["rows"]),
                    "columns": list(output["columns"]),
                    # Where the table actually lives, so the board can point at
                    # the file instead of asking a viewer to take it on faith.
                    # Display only: a path from this machine decides nothing.
                    "path": str(output_path),
                }
            },
        }

        coordination: dict[str, Any] = {}
        if report:
            coordination = report_completion(
                task_urn, fingerprints, finished_at, obsel_url, run=run_detail, inputs=observed_inputs
            )
            _leave_running(task.name, root)
    except Exception as error:
        if not report:
            # Nothing was announced on this path, so there is no running state to
            # describe and no marker to point at. Saying otherwise would invent a
            # fact about obsel from a code path that never contacted it.
            raise RuntimeError(f"{task.name} failed after producing its table: {error}") from error

        # The marker deliberately stays. It is what makes the next attempt a resume
        # rather than a refusal, so the failure is recoverable by re-running this
        # agent instead of resetting the whole swarm.
        raise RuntimeError(
            f"{task.name} told obsel it had started and then failed: {error}\n"
            f"obsel should still have {task.name} at running, which means it will not "
            f"be considered for staleness until it finishes. Re-run this agent -- "
            f"{_inflight_path(task.name, root)} records the announcement, and the "
            f"re-run re-checks that state with obsel before deciding to resume."
        ) from error

    return RunResult(
        task=task.name,
        output_table=task.writes,
        output_path=str(output_path),
        columns=output["columns"],
        row_count=len(output["rows"]),
        fingerprints=fingerprints,
        plan_source=plan_source,
        plan_notes=str(plan.get("notes", "")),
        model_seconds=model_seconds,
        total_seconds=time.perf_counter() - started,
        coordination=coordination,
        start=start,
    )


def _self_check() -> int:
    """Prove the canonicalisation properties the demo's quiet step depends on.

    Run directly: `python -m agents.worker`

    The case that motivated all of this is first: two runs that wrote the same
    money value as `217` and `217.0` must reach the same fingerprint, because
    they are the same table and obsel should say nothing about them.
    """
    from agents.fingerprint import fingerprint

    failures: list[str] = []

    def check(name: str, condition: bool, detail: str) -> None:
        print(f"  {'pass' if condition else 'FAIL'}  {name}: {detail}")
        if not condition:
            failures.append(name)

    columns = ["order_id", "order_total", "customer"]

    def table(total_1012: Any) -> Table:
        return {
            "columns": columns,
            "rows": [
                {"order_id": 1011, "order_total": 233.08, "customer": "Ada Okafor"},
                {"order_id": 1012, "order_total": total_1012, "customer": "Ben Ruiz"},
            ],
        }

    def printed(value: Any) -> str:
        canonical = canonicalise_numbers(table(value))
        return fingerprint(canonical["rows"], canonical["columns"])["content"]

    check(
        "217 and 217.0 reach the same fingerprint",
        printed(217) == printed(217.0),
        "the exact difference between two live Codex runs on 2026-07-22",
    )
    check(
        "an integer id column stays an integer",
        canonicalise_numbers(table(217))["rows"][0]["order_id"] == 1011,
        "1011, not 1011.0 -- an id is not money and must not gain a decimal",
    )
    check(
        "a column with a fractional value writes every value as a float",
        isinstance(canonicalise_numbers(table(217))["rows"][1]["order_total"], float),
        "233.08 sits in the column, so 217 is written 217.0",
    )
    check(
        "a real change to the data still moves the fingerprint",
        printed(217) != printed(218),
        "canonicalising must not make obsel blind to a value that genuinely moved",
    )
    check(
        "a gained fractional value still moves the fingerprint",
        printed(217) != printed(217.5),
        "217.5 is not 217, and no rounding may hide that",
    )
    check(
        "text columns are untouched",
        canonicalise_numbers(table(217))["rows"][0]["customer"] == "Ada Okafor",
        "only numeric columns are rewritten",
    )
    check(
        "applying it twice changes nothing",
        canonicalise_numbers(canonicalise_numbers(table(217)))
        == canonicalise_numbers(table(217)),
        "idempotent, so a re-saved table cannot drift",
    )

    # ----------------------------------------------------------------------
    # What a run leaves on disk for the next one to read.
    #
    # Real files in a real temporary directory. Every function below already
    # takes `root`, so nothing has to be stood in for: these are the actual
    # writes and the actual reads the demo performs, pointed somewhere harmless.
    # ----------------------------------------------------------------------
    print()
    print("what a run leaves on disk")

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)

        written = {"columns": ["order_id", "order_total"], "rows": [{"order_id": 1, "order_total": 217.0}]}
        save_table("probe", written, root)
        check(
            "a table survives a save and load unchanged",
            load_table("probe", root) == written,
            "a round trip that altered the table would move the fingerprint for no reason",
        )
        check(
            "the file is byte-stable across identical saves",
            (
                save_table("probe", written, root).read_bytes()
                == save_table("probe", written, root).read_bytes()
            ),
            "sort_keys and a trailing newline, so a re-save is a no-op in git",
        )

        missing_named_the_path = False
        try:
            load_table("never_written", root)
        except FileNotFoundError as error:
            missing_named_the_path = "never_written.json" in str(error)
        check(
            "a missing table names the file and the fix",
            missing_named_the_path,
            "an agent reading upstream data that is not there needs the path, not a stack trace",
        )

        not_a_table = False
        try:
            path = table_path("bad", root)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('{"nope": true}\n', encoding="utf-8")
            load_table("bad", root)
        except ValueError:
            not_a_table = True
        check(
            "a file that is not a table is rejected rather than half-read",
            not_a_table,
            "fingerprinting a shape obsel did not write would produce a confident wrong digest",
        )

        # The property the reader-side check stands on. A writer hashes its
        # canonicalised table and saves it; the next reader loads that file,
        # canonicalises, and hashes what it read. If those two fingerprints could
        # differ for the same file, every honest read would look like a table
        # changed behind obsel's back, and the unreported-change alarm would fire
        # on nothing at all.
        producer_view = canonicalise_numbers(
            {"columns": ["order_id", "order_total"], "rows": [{"order_id": 2, "order_total": 217}]}
        )
        save_table("handoff", producer_view, root)
        reader_view = canonicalise_numbers(load_table("handoff", root))
        check(
            "the reader's hash of a saved table equals the writer's",
            fingerprint(producer_view["rows"], producer_view["columns"])
            == fingerprint(reader_view["rows"], reader_view["columns"]),
            "write, save, load, read must reach one fingerprint or input observations lie",
        )

        # The pair whose separation reverted a rename live on 2026-07-22.
        check(
            "nothing is remembered before a run",
            last_run("clean_orders", root) is None,
            "a first run has no previous instruction to replay",
        )
        _remember_run("clean_orders", "rename order_total to order_total_usd", ["order_id", "order_total_usd"], root)
        remembered = last_run("clean_orders", root)
        check(
            "an instruction and the columns it produced are remembered together",
            remembered is not None
            and remembered["instruction"] == "rename order_total to order_total_usd"
            and remembered["columns"] == ["order_id", "order_total_usd"],
            "replaying the instruction without its contract reverted the rename and failed a take",
        )
        _remember_run("clean_orders", "second instruction", ["order_id"], root)
        second = last_run("clean_orders", root)
        check(
            "a later run replaces the pair rather than merging it",
            second is not None and second["instruction"] == "second instruction" and second["columns"] == ["order_id"],
            "half of one run's pair and half of another's is the contradiction this file exists to stop",
        )
        check(
            "one task's memory does not answer for another's",
            last_run("build_revenue", root) is None,
            "each agent replays what IT last ran",
        )

        # The pre-2026-07-22 format, which stored the instruction as a bare string.
        legacy = root / ".obsel" / "state" / "instructions.json"
        legacy.write_text('{"write_docs": "an old instruction"}\n', encoding="utf-8")
        old = last_run("write_docs", root)
        check(
            "an entry written before columns were recorded still reads",
            old is not None and old["instruction"] == "an old instruction" and old["columns"] is None,
            "columns None makes the caller fall back to the standing contract, which is the old behaviour",
        )

    print()
    if failures:
        print(f"FAILED: {', '.join(failures)}")
        return 1
    print("all properties hold")
    return 0


if __name__ == "__main__":
    raise SystemExit(_self_check())
