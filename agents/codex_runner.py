"""Run one demo agent as a real Codex session.

The alternative, kept in `worker.py`, asks a model for a small JSON plan and then
applies that plan with deterministic Python. This module does something different
and closer to what the hackathon category asks for: it hands Codex the input file
and the job, and Codex reads, decides, and writes the output table itself with its
own tools. The agent is genuinely an agent, not a single structured-output call.

The cost of that is unpredictability, so nothing here trusts the agent. What it
produced is read back off disk and checked against the contract before obsel is
told anything, and every failure is loud. An agent that quietly wrote a malformed
or empty table would otherwise produce a fingerprint that looks like a real change
and mark the whole downstream chain stale for no reason -- a false alarm, which is
the failure mode obsel exists to prevent.

Two invocation details, both learned by running it rather than reading about it:

- `--sandbox workspace-write` is required, or the agent cannot write its output.
- `--skip-git-repo-check` is required, because the data directory is gitignored
  and Codex otherwise refuses to run outside a repository.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

# Codex is given a generous ceiling because it may read, reason, and write across
# several tool calls. A demo agent that has not finished by then has gone wrong in
# a way that waiting will not fix.
TIMEOUT_SECONDS = 600


class CodexUnavailable(RuntimeError):
    """The codex CLI is not installed, or not signed in."""


class CodexProducedNothing(RuntimeError):
    """Codex ran but did not leave a usable table behind."""


def codex_version() -> str:
    """Fail early and clearly if the CLI is missing, rather than mid-demo."""
    if shutil.which("codex") is None:
        raise CodexUnavailable(
            "the `codex` CLI is not on PATH. Install it, or run the swarm with "
            "Codex is the only runner."
        )
    result = subprocess.run(
        ["codex", "--version"], capture_output=True, text=True, timeout=60
    )
    if result.returncode != 0:
        raise CodexUnavailable(f"`codex --version` failed: {result.stderr.strip()}")
    return result.stdout.strip()


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


def _validate(path: Path, expect_columns: list[str] | None) -> dict[str, Any]:
    """Read back what the agent wrote and refuse anything unusable.

    Checked rather than trusted, because a plausible-looking bad table is worse
    than a crash: it fingerprints cleanly and marks everything downstream stale.
    """
    if not path.exists():
        raise CodexProducedNothing(f"the agent did not write {path.name}")

    raw = path.read_text(encoding="utf-8")
    try:
        table = json.loads(raw)
    except json.JSONDecodeError as error:
        raise CodexProducedNothing(f"{path.name} is not valid JSON: {error}") from error

    if not isinstance(table, dict):
        raise CodexProducedNothing(f"{path.name} is not a JSON object")

    columns = table.get("columns")
    rows = table.get("rows")
    if not isinstance(columns, list) or not all(isinstance(c, str) for c in columns):
        raise CodexProducedNothing(f"{path.name} has no usable 'columns' array")
    if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
        raise CodexProducedNothing(f"{path.name} has no usable 'rows' array")
    if not columns:
        raise CodexProducedNothing(f"{path.name} declares no columns")
    if not rows:
        # An empty table is a legitimate result of a filter, but never of this
        # demo, and it would fingerprint as a dramatic change.
        raise CodexProducedNothing(
            f"{path.name} has no rows. Every task in this demo produces at least one."
        )

    for index, row in enumerate(rows):
        missing = [c for c in columns if c not in row]
        if missing:
            raise CodexProducedNothing(
                f"{path.name} row {index} is missing declared column(s): {missing}"
            )

    if expect_columns is not None and list(columns) != list(expect_columns):
        raise CodexProducedNothing(
            f"{path.name} has columns {columns}, but this task must produce "
            f"{expect_columns}. The agent did not follow the output contract."
        )

    return {"columns": list(columns), "rows": rows}


def run_agent(
    *,
    instruction: str,
    input_files: list[str],
    output_file: str,
    working_dir: Path,
    expect_columns: list[str] | None = None,
    timeout: int = TIMEOUT_SECONDS,
) -> tuple[dict[str, Any], float, str]:
    """Run one Codex agent and return (table, seconds, codex version).

    The output file is removed first, so a stale file from an earlier run can
    never be mistaken for this run's work -- which would silently report an
    unchanged fingerprint and prove nothing.
    """
    version = codex_version()
    target = working_dir / output_file
    target.unlink(missing_ok=True)

    prompt = build_prompt(instruction, input_files, output_file, expect_columns)

    started = time.perf_counter()
    result = subprocess.run(
        [
            "codex",
            "exec",
            "--sandbox",
            "workspace-write",
            "--skip-git-repo-check",
            "--cd",
            str(working_dir),
            prompt,
        ],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    elapsed = time.perf_counter() - started

    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").strip()[-800:]
        raise CodexProducedNothing(
            f"codex exec exited {result.returncode} after {elapsed:.1f}s: {tail}"
        )

    return _validate(target, expect_columns), elapsed, version
