"""Run one demo agent as a real Claude Code session.

The counterpart to `codex_runner.py`. Both hand a coding CLI the input file and
the job and let it read, decide, and write the output table with its own tools;
both are held to the same contract in `agent_contract.py`, because a validator
that differed per runner would accept a table the other refused.
`runner_select.py` decides which one runs.

Seven invocation details, each learned by running the CLI rather than reading
about it, and each with an observed reason:

- `-p` is print mode: it runs the session non-interactively and exits. Without
  it the CLI opens an interactive session and the worker waits forever.

- `--safe-mode` is required, and it is the one that is not obvious. Claude Code
  discovers CLAUDE.md, skills, plugins, hooks and MCP servers by walking up from
  its working directory, and the agent's working directory is `.obsel/work/<task>/`
  inside this repository. Two runs of the same prompt in the same directory, with
  and without the flag, were not the same: the run without it obeyed a CLAUDE.md
  from a parent directory and added a key to the output table that the prompt
  never asked for. A demo agent doing a two-column rename must not be reading
  obsel's own instructions, and an output that depends on where the repository
  sits on disk is not reproducible. The flag turns all of that off and leaves
  auth, model selection, built-in tools and permissions alone.

- `--permission-mode acceptEdits` lets the agent write its output file without
  stopping to ask. Confirmed against a file that did not exist yet, which is the
  case the demo always hits.

- `--allowedTools "Bash(python3 *)"` lets a non-interactive session execute the
  table transformation it wrote. It does not allow other Bash command shapes or
  full permission bypass. Python is still code execution, so this was enabled
  only after the owner approved it. Without it, both initial scale agents
  stopped to request approval and wrote no output file.

- `--model claude-sonnet-5` fixes the model instead of inheriting whichever
  default the signed-in account currently selects.

- `--effort medium` fixes the reasoning effort. A measured run must not change
  because an account default changed between sessions.

- stdin is `DEVNULL`. Left connected, the CLI waits for piped input and prints
  "no stdin data received in 3s, proceeding without it" into captured stderr,
  which is noise in the one place an operator reads when a run has failed.

There is no equivalent of Codex's `--skip-git-repo-check`, and none is needed:
a session in a gitignored directory inside a repository ran without complaint.
There is no `--cd` either, so the working directory is set on the subprocess.
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

# The same ceiling Codex gets, and for the same reason: the agent may read,
# reason and write across several tool calls, and one that has not finished by
# now has gone wrong in a way that waiting will not fix.
TIMEOUT_SECONDS = 600
MODEL = "claude-sonnet-5"
EFFORT = "medium"


class ClaudeUnavailable(AgentUnavailable):
    """The claude CLI is not installed, or not signed in."""


def claude_version() -> str:
    """Fail early and clearly if the CLI is missing, rather than mid-demo.

    Being signed in is deliberately not checked here, because `claude --version`
    answers without an account, exactly as `codex --version` does. The board's
    checklist asks `claude auth status`, which is the question that has a
    different answer.
    """
    if shutil.which("claude") is None:
        raise ClaudeUnavailable(
            "the `claude` CLI is not on PATH. Install Claude Code and run "
            "`claude auth login`, or run the swarm on Codex instead with "
            "OBSEL_RUNNER=codex."
        )
    result = subprocess.run(
        ["claude", "--version"], capture_output=True, text=True, timeout=60
    )
    if result.returncode != 0:
        raise ClaudeUnavailable(f"`claude --version` failed: {result.stderr.strip()}")
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
    """Run one Claude Code agent and return (table, seconds, claude version).

    The output file is removed first, so a stale file from an earlier run can
    never be mistaken for this run's work -- which would silently report an
    unchanged fingerprint and prove nothing.
    """
    version = claude_version()
    target = working_dir / output_file
    target.unlink(missing_ok=True)

    prompt = build_prompt(instruction, input_files, output_file, expect_columns)

    started = time.perf_counter()
    result = subprocess.run(
        [
            "claude",
            "-p",
            "--model",
            MODEL,
            "--effort",
            EFFORT,
            "--safe-mode",
            "--permission-mode",
            "acceptEdits",
            "--allowedTools",
            "Bash(python3 *)",
            "--",
            prompt,
        ],
        cwd=str(working_dir),
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    elapsed = time.perf_counter() - started

    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").strip()[-800:]
        raise AgentProducedNothing(
            f"claude -p exited {result.returncode} after {elapsed:.1f}s: {tail}"
        )

    return validate(target, expect_columns), elapsed, version
