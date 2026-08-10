"""Which CLI runs the demo agents.

obsel's own decisions never involve a model, and this is not one of obsel's
decisions: it is the operator's, about their own machine. The rule is small and
lives in one place so that the worker, the board's checklist and `start.sh` all
answer the question the same way. A checklist that reported on Codex while the
worker ran Claude Code would be a green tick above a failing run.

    OBSEL_RUNNER=codex     always Codex
    OBSEL_RUNNER=claude    always Claude Code
    unset                  whichever is installed, Codex first

**An explicit choice is never second-guessed.** `resolve("codex")` returns the
Codex runner even with no `codex` on PATH, so the failure comes from the runner
itself and names the CLI the operator asked for. Falling back silently would run
a different agent product than the one they named and report it as if nothing
had happened.

Codex is preferred when both are installed for one reason, and it is not a
judgement about either product: every measured figure in `docs/verification.md`
came from a Codex run, so an unattended machine keeps producing numbers those
documents describe.
"""

from __future__ import annotations

import os
import shutil
from types import ModuleType

from agents.agent_contract import AgentUnavailable

#: The two runners, in the order detection tries them.
RUNNERS = ("codex", "claude")

#: The thing an operator installs and signs into, as the subject of a sentence.
DISPLAY = {"codex": "the Codex CLI", "claude": "Claude Code"}

#: The word that goes in "a real ___ session", which is not the same string.
#:
#: The two forms exist because sharing one produces "a real the Codex CLI
#: session" and "up to 8 the Codex CLI sessions at once". That sentence was
#: written three times during this change, in `preflight.ts`, in `guide.ts` and
#: in `run.py`, so both forms are kept side by side wherever a runner is named.
PRODUCT = {"codex": "Codex", "claude": "Claude Code"}

#: The command that signs each one in, shown as the fix on a failing check.
SIGN_IN = {"codex": "codex login", "claude": "claude auth login"}

ENV_VAR = "OBSEL_RUNNER"


class NoRunnerAvailable(AgentUnavailable):
    """Neither CLI is installed, so no agent can run at all."""


def _installed(name: str) -> bool:
    return shutil.which(name) is not None


def resolve(requested: str | None = None) -> str:
    """The name of the runner to use, or raise saying why there is none.

    `requested` defaults to `$OBSEL_RUNNER`. An empty or absent value means
    detect; an unrecognized one is an error rather than a fallback, because a
    typo that silently ran something else would be reported on the board as the
    runner the operator did not ask for.
    """
    choice = (requested if requested is not None else os.environ.get(ENV_VAR, "")).strip()

    if choice:
        if choice not in RUNNERS:
            raise ValueError(
                f"{ENV_VAR}={choice!r} is not a runner obsel knows. "
                f"Use one of: {', '.join(RUNNERS)}."
            )
        return choice

    for name in RUNNERS:
        if _installed(name):
            return name

    raise NoRunnerAvailable(
        "no agent CLI is installed, so the demo agents cannot run. Install "
        "either one: Claude Code (`claude auth login` after installing), or the "
        "Codex CLI (`codex login`). obsel itself needs neither -- the board, the "
        "graph and the staleness engine all work without them."
    )


def runner(requested: str | None = None) -> ModuleType:
    """The runner module itself, imported late so neither CLI is needed to import this."""
    name = resolve(requested)
    if name == "codex":
        from agents import codex_runner

        return codex_runner

    from agents import claude_runner

    return claude_runner


# --------------------------------------------------------------------------
# Self-check
# --------------------------------------------------------------------------


def _self_check() -> int:
    """Prove the rule above, including the parts that are easy to get backwards.

    Run directly: `python -m agents.runner_select`

    Real environment variables and the real PATH lookup. What is not covered is
    starting either CLI, which is what the two live tests are for.
    """
    failures: list[str] = []

    def check(name: str, condition: bool, detail: str) -> None:
        print(f"  {'pass' if condition else 'FAIL'}  {name}: {detail}")
        if not condition:
            failures.append(name)

    def raised(requested: str | None) -> str:
        try:
            resolve(requested)
        except (ValueError, NoRunnerAvailable) as error:
            return str(error)
        return ""

    print("an explicit choice is honored exactly")

    check(
        "codex asked for is codex returned",
        resolve("codex") == "codex",
        "the operator named a product, and running the other one would misreport the run",
    )
    check(
        "claude asked for is claude returned",
        resolve("claude") == "claude",
        "the same, in the direction that had no code path at all until now",
    )
    check(
        "an unknown name is refused, naming the valid ones",
        "codex" in raised("codexx") and "claude" in raised("codexx"),
        "a typo must not fall back, or the board reports a runner nobody chose",
    )
    check(
        "surrounding whitespace does not make a valid name unknown",
        resolve(" claude ") == "claude",
        "a value pasted into a shell profile arrives with a trailing space",
    )

    print()
    print("detection, when nothing was chosen")

    installed = [name for name in RUNNERS if _installed(name)]
    if installed:
        check(
            "detection picks the first installed runner in order",
            resolve("") == installed[0],
            f"installed here: {', '.join(installed)}; Codex first keeps the measured figures comparable",
        )
        # The env var is the only input the worker actually passes, so read it
        # here rather than only ever calling `resolve` with an explicit argument.
        # Restored afterwards, because the checks below share this process.
        before = os.environ.get(ENV_VAR)
        try:
            os.environ[ENV_VAR] = "claude"
            check(
                "the environment variable is what an unargued call reads",
                resolve() == "claude",
                "this is the path the worker takes, and nothing else exercises it",
            )
            os.environ[ENV_VAR] = ""
            check(
                "set to empty means detect, not error",
                resolve() == installed[0],
                "unset and set-to-empty are the same intent, and shells produce both",
            )
        finally:
            if before is None:
                os.environ.pop(ENV_VAR, None)
            else:
                os.environ[ENV_VAR] = before
    else:
        # Not an else-branch for tidiness: with neither CLI installed `resolve("")`
        # raises, so the two checks above have nothing to compare and this is the
        # only observable behavior left. It is also the case an operator who has
        # just cloned obsel is most likely to be in.
        check(
            "with neither installed, the error names both and how to get one",
            "claude" in raised("").lower() and "codex" in raised("").lower(),
            "an operator with neither must be told there is a choice, not just that one is missing",
        )
        check(
            "and it says obsel itself still works",
            "board" in raised(""),
            "the graph and the staleness engine need no CLI, and a blocked demo must not read as a dead app",
        )

    print()
    print("what the rest of obsel reads off this module")

    check(
        "every runner has both name forms and a sign-in command",
        all(name in DISPLAY and name in PRODUCT and name in SIGN_IN for name in RUNNERS),
        "the checklist and the terminal render these, and a missing one prints a KeyError at an operator",
    )
    check(
        "the display names are distinct",
        len(set(DISPLAY.values())) == len(RUNNERS),
        "two runners sharing a label makes the checklist unable to say which one it checked",
    )

    # The bug this catches was written three times before it was noticed, once
    # per surface, and every time it was the same mistake: using DISPLAY where
    # PRODUCT belongs. PRODUCT always follows an article already, so a value
    # carrying its own is what produces "a real the Codex CLI session".
    check(
        "no product name carries an article",
        not any(PRODUCT[name].lower().startswith(("the ", "a ", "an ")) for name in RUNNERS),
        'it always follows one, as in "a real ___ session" and "up to 8 ___ sessions"',
    )

    print()
    if failures:
        print(f"FAILED: {', '.join(failures)}")
        return 1
    print("the runner is chosen the same way everywhere")
    return 0


if __name__ == "__main__":
    raise SystemExit(_self_check())
