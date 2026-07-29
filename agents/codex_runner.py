"""Run one demo agent as a real Codex session.

It hands Codex the input file and the job, and Codex reads, decides, and writes
the output table itself with its own tools. The agent is genuinely an agent, not
a single structured-output call.

The cost of that is unpredictability, so nothing here trusts the agent. What the
agent is told and what it is held to live in `agent_contract.py`, shared with
`claude_runner.py`; this module is only the invocation. `runner_select.py`
decides which of the two runs.

Two invocation details, both learned by running it rather than reading about it:

- `--sandbox workspace-write` is required, or the agent cannot write its output.
- `--skip-git-repo-check` is required, because the data directory is gitignored
  and Codex otherwise refuses to run outside a repository.
"""

from __future__ import annotations

import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

from agents.agent_contract import (
    AgentProducedNothing,
    AgentUnavailable,
    build_prompt,
    validate,
)

# Codex is given a generous ceiling because it may read, reason, and write across
# several tool calls. A demo agent that has not finished by then has gone wrong in
# a way that waiting will not fix.
TIMEOUT_SECONDS = 600

#: What obsel records as having produced the table. `plan_source` carries the
#: CLI's own version string alongside it.
NAME = "codex"


class CodexUnavailable(AgentUnavailable):
    """The codex CLI is not installed, or not signed in."""


def codex_version() -> str:
    """Fail early and clearly if the CLI is missing, rather than mid-demo."""
    if shutil.which("codex") is None:
        raise CodexUnavailable(
            "the `codex` CLI is not on PATH. Install it and run `codex login`, or "
            "run the swarm on Claude Code instead with OBSEL_RUNNER=claude."
        )
    result = subprocess.run(
        ["codex", "--version"], capture_output=True, text=True, timeout=60
    )
    if result.returncode != 0:
        raise CodexUnavailable(f"`codex --version` failed: {result.stderr.strip()}")
    return result.stdout.strip()


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
        raise AgentProducedNothing(
            f"codex exec exited {result.returncode} after {elapsed:.1f}s: {tail}"
        )

    return validate(target, expect_columns), elapsed, version
