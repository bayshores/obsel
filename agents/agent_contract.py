"""What a demo agent is told, and what it is held to, whichever CLI runs it.

obsel runs each demo agent as a real session of a coding CLI: `codex_runner.py`
uses Codex, `claude_runner.py` uses Claude Code, and `runner_select.py` decides
which. The invocation differs between them. Everything in this module does not,
and that is the point of it being one module: `validate` is the only thing
standing between a live model's output and obsel's fingerprint, and a second
copy of it would drift from the first. A drifted validator accepts a table the
other would have refused, which fingerprints as a real change and marks the whole
downstream chain stale for nothing -- the false alarm obsel exists to prevent.

So nothing here trusts the agent. What it produced is read back off disk and
checked against the contract before obsel is told anything, and every failure is
loud.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class AgentUnavailable(RuntimeError):
    """The CLI that runs the agents is not installed, or not signed in.

    Each runner subclasses this with its own name, because which CLI is missing
    is the whole content of the message an operator sees before anything runs.
    """


class AgentProducedNothing(RuntimeError):
    """The agent ran but did not leave a usable table behind."""


def build_prompt(
    instruction: str,
    input_files: list[str],
    output_file: str,
    output_columns: list[str] | None,
) -> str:
    """What the agent is told.

    Deliberately specific about the file contract and silent about how to do the
    work. The shape has to be exact for the fingerprint to mean anything; the
    transformation is the agent's job and is what makes this an agent at all.

    The same words go to every runner. A prompt tuned per CLI would make the two
    runners' outputs incomparable, and the demo's whole quiet case is that a
    re-run produces byte-identical work.
    """
    reads = "\n".join(f"  - {name}" for name in input_files)
    columns_line = (
        f"\nThe output columns must be exactly, in this order: {output_columns}."
        if output_columns
        else ""
    )
    return f"""You are one agent in a small data pipeline. Do exactly one job.

Your job:
{instruction}

Read these files in the current directory:
{reads}

Each file is JSON shaped like {{"columns": [...], "rows": [{{...}}, ...]}}, where
every row is an object keyed by the column names.

Write your result to `{output_file}` in the current directory, in that same shape:
a JSON object with a "columns" array and a "rows" array, where every row object
has exactly the keys listed in "columns".{columns_line}

Do not create or modify any other file. Do not print the table. When you are
done, reply with only the number of rows you wrote."""


def validate(path: Path, expect_columns: list[str] | None) -> dict[str, Any]:
    """Read back what the agent wrote and refuse anything unusable.

    Checked rather than trusted, because a plausible-looking bad table is worse
    than a crash: it fingerprints cleanly and marks everything downstream stale.
    """
    if not path.exists():
        raise AgentProducedNothing(f"the agent did not write {path.name}")

    raw = path.read_text(encoding="utf-8")
    try:
        table = json.loads(raw)
    except json.JSONDecodeError as error:
        raise AgentProducedNothing(f"{path.name} is not valid JSON: {error}") from error

    if not isinstance(table, dict):
        raise AgentProducedNothing(f"{path.name} is not a JSON object")

    columns = table.get("columns")
    rows = table.get("rows")
    if not isinstance(columns, list) or not all(isinstance(c, str) for c in columns):
        raise AgentProducedNothing(f"{path.name} has no usable 'columns' array")
    if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
        raise AgentProducedNothing(f"{path.name} has no usable 'rows' array")
    if not columns:
        raise AgentProducedNothing(f"{path.name} declares no columns")
    if not rows:
        # An empty table is a legitimate result of a filter, but never of this
        # demo, and it would fingerprint as a dramatic change.
        raise AgentProducedNothing(
            f"{path.name} has no rows. Every task in this demo produces at least one."
        )

    for index, row in enumerate(rows):
        missing = [c for c in columns if c not in row]
        if missing:
            raise AgentProducedNothing(
                f"{path.name} row {index} is missing declared column(s): {missing}"
            )

    if expect_columns is not None and list(columns) != list(expect_columns):
        raise AgentProducedNothing(
            f"{path.name} has columns {columns}, but this task must produce "
            f"{expect_columns}. The agent did not follow the output contract."
        )

    return {"columns": list(columns), "rows": rows}


# --------------------------------------------------------------------------
# Self-check
# --------------------------------------------------------------------------


def _self_check() -> int:
    """Prove that nothing an agent writes is taken on trust.

    Run directly: `python -m agents.agent_contract`

    `validate` is the only thing between a live model's output and obsel's
    fingerprint, and it is the reason a bad run fails loudly instead of quietly.
    Every branch below refuses a table that would otherwise hash cleanly and mark
    the whole downstream chain stale for no reason -- a false alarm, which is the
    exact failure obsel exists to prevent. So the rejections are the subject here,
    not the accept path.

    Real files in a real temporary directory. `validate` takes a `Path` and reads
    it, so pointing it at a scratch directory exercises the actual read; there is
    nothing here to stand in for.

    What is NOT covered: starting a CLI. Both runners spawn a subprocess and need
    their CLI installed and signed in, and they are covered by
    `tests/live/codex.live.test.ts` and `tests/live/claude.live.test.ts`, which
    each run a real agent.
    """
    import tempfile

    from agents.fingerprint import fingerprint

    failures: list[str] = []

    def check(name: str, condition: bool, detail: str) -> None:
        print(f"  {'pass' if condition else 'FAIL'}  {name}: {detail}")
        if not condition:
            failures.append(name)

    # ----------------------------------------------------------------------
    # What the agent is told.
    # ----------------------------------------------------------------------
    print("the prompt an agent receives")

    with_contract = build_prompt(
        "Rename order_total to order_total_usd.",
        ["raw_orders.json"],
        "clean_orders.json",
        ["order_id", "order_total_usd"],
    )
    without_contract = build_prompt(
        "Summarise the table.", ["a.json", "b.json"], "out.json", None
    )

    check(
        "the job is passed through verbatim",
        "Rename order_total to order_total_usd." in with_contract,
        "the instruction is the one thing the agent must not receive a paraphrase of",
    )
    check(
        "every input file is named",
        "a.json" in without_contract and "b.json" in without_contract,
        "an agent that is told about one of its two inputs produces a table built on half the data",
    )
    check(
        "the output file is named",
        "clean_orders.json" in with_contract,
        "the file obsel fingerprints is the file the agent has to write",
    )
    check(
        "a column contract appears when there is one",
        "['order_id', 'order_total_usd']" in with_contract,
        "the demo's rename is enforced through this line",
    )
    check(
        "no contract line when the task has no fixed columns",
        "must be exactly" not in without_contract,
        "inventing a contract would make the agent refuse work it was free to shape",
    )
    check(
        "the agent is told not to print the table",
        "Do not print the table" in with_contract,
        "the table is read off disk, so a printed one is noise that can only mislead",
    )

    # ----------------------------------------------------------------------
    # What comes back is checked, never trusted.
    # ----------------------------------------------------------------------
    print()
    print("what the agent wrote, read back and checked")

    good = {
        "columns": ["order_id", "order_total"],
        "rows": [{"order_id": 1, "order_total": 217.0}],
    }

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)

        def written(name: str, body: Any) -> Path:
            path = root / name
            text = body if isinstance(body, str) else json.dumps(body)
            path.write_text(text, encoding="utf-8")
            return path

        def refused(path: Path, expect: list[str] | None = None) -> str:
            """The refusal message, or "" if the table was accepted.

            Returns the message rather than a bool so each check can assert that
            the operator is told *which* table and *what* about it. A rejection
            that says only "invalid" sends someone to read the agent's transcript.
            """
            try:
                validate(path, expect)
            except AgentProducedNothing as error:
                return str(error)
            return ""

        accepted = validate(written("good.json", good), ["order_id", "order_total"])
        check(
            "a table meeting its contract is accepted unchanged",
            accepted == good,
            "the columns and rows come back exactly as the agent wrote them",
        )
        check(
            "no contract means no contract check",
            validate(written("good.json", good), None) == good,
            "a task with free-form output is not failed for having free-form output",
        )

        missing = refused(root / "never_written.json")
        check(
            "a file the agent never wrote is refused, by name",
            "never_written.json" in missing,
            "the commonest real failure: the agent answered and wrote nothing",
        )
        check(
            "a file that is not JSON is refused",
            "not valid JSON" in refused(written("bad.json", "{oops")),
            "a half-written file is not a table",
        )
        check(
            "a JSON value that is not an object is refused",
            "not a JSON object" in refused(written("arr.json", [1, 2, 3])),
            "a bare array has no columns to fingerprint",
        )
        check(
            "a missing columns array is refused",
            "columns" in refused(written("nocols.json", {"rows": [{"a": 1}]})),
            "without declared columns the schema fingerprint is over nothing",
        )
        check(
            "a column name that is not a string is refused",
            "columns" in refused(written("numcol.json", {"columns": [1], "rows": [{"a": 1}]})),
            "column names are joined and hashed, so a non-string would hash by its repr",
        )
        check(
            "a rows value that is not a list is refused",
            "rows" in refused(written("norows.json", {"columns": ["a"], "rows": {"a": 1}})),
            "one row written as an object rather than a list of one",
        )
        check(
            "a row that is not an object is refused",
            "rows" in refused(written("rowlist.json", {"columns": ["a"], "rows": [[1]]})),
            "positional rows would fingerprint as all-null, since values are read by key",
        )
        check(
            "a table declaring no columns is refused",
            "no columns" in refused(written("empty.json", {"columns": [], "rows": [{"a": 1}]})),
            "every row would serialise to [] and the whole table to one repeated hash",
        )
        check(
            "a table with no rows is refused",
            "no rows" in refused(written("norow.json", {"columns": ["a"], "rows": []})),
            "legitimate for a filter, never for this demo, and it fingerprints as a dramatic change",
        )

        ragged = refused(
            written(
                "ragged.json",
                {"columns": ["a", "b"], "rows": [{"a": 1, "b": 2}, {"a": 3}]},
            )
        )
        check(
            "a row missing a declared column is refused, by row number",
            "row 1" in ragged and "b" in ragged,
            "the fingerprint reads a missing key as null, so this would hash as real data",
        )

        wrong = refused(written("good.json", good), ["order_id", "order_total_usd"])
        check(
            "columns that do not match the contract are refused",
            "did not follow the output contract" in wrong,
            "the demo's whole change is a column name; an agent that ignored it must not pass",
        )
        reordered = refused(written("good.json", good), ["order_total", "order_id"])
        check(
            "the right columns in the wrong order are refused",
            "did not follow the output contract" in reordered,
            "the contract is a list, and column order moves the content fingerprint",
        )

        # An agent that leaves a scratch key behind is a real thing to survive,
        # and the two halves of this pair have to agree about it or the demo
        # produces a false alarm on a table nobody meaningfully changed.
        extra = {
            "columns": ["order_id", "order_total"],
            "rows": [{"order_id": 1, "order_total": 217.0, "_scratch": "ignore me"}],
        }
        check(
            "a row carrying an undeclared extra key is accepted",
            validate(written("extra.json", extra), ["order_id", "order_total"]) == extra,
            "the contract is about declared columns, and refusing this would fail honest work",
        )
        check(
            "and that extra key does not move the fingerprint",
            fingerprint(extra["rows"], extra["columns"])
            == fingerprint(good["rows"], good["columns"]),
            "rows are hashed by declared column, so scratch keys cannot raise a false alarm",
        )

    print()
    if failures:
        print(f"FAILED: {', '.join(failures)}")
        return 1
    print("nothing an agent writes is taken on trust")
    return 0


if __name__ == "__main__":
    raise SystemExit(_self_check())
