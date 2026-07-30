"""Run many agent tasks concurrently, without ever running one before its inputs.

The demo's four agents run one after another. Forty real agent sessions cannot:
sequentially they are half an hour of wall clock, and a swarm that only ever
moves one agent at a time is not the thing obsel exists to watch. This module is
the runner's concurrency: a bounded pool, a dependency frontier, and three
controls a caller's completion hook can use to choreograph a run — release a
held task, submit an extra execution, cancel one that has not started.

What it deliberately is not: a scheduler with opinions. It knows nothing about
obsel, which CLI runs the agents, staleness, or repair. `run.py` supplies an `execute` callable and
reads the outcome; every claim about what a run means is made there, from
obsel's own answers, never from this module's bookkeeping. The timeline it
returns is narration and choreography, not evidence.

Failure policy: a task that raises stops NEW submissions of its descendants
(they end in `blocked`), while everything already running is left to finish.
Killing a live agent session mid-write would leave half a table on disk for the
next reader to trip over, which is worse than the wait.
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Protocol


class TaskLike(Protocol):
    """What the pool needs to know about a task: its name and its inputs."""

    @property
    def name(self) -> str: ...

    @property
    def reads(self) -> tuple[str, ...]: ...

    @property
    def writes(self) -> str: ...


@dataclass
class Event:
    """One thing that happened, in the order the main loop saw it."""

    kind: str  # "submitted" | "completed" | "failed" | "released" | "cancelled" | "extra"
    key: str
    #: perf_counter seconds, one clock for the whole run. Start/end pairs for a
    #: task come from inside its own thread, so they bracket the real work
    #: rather than the main loop's harvesting.
    at: float
    started: float | None = None
    finished: float | None = None


@dataclass
class Outcome:
    """Everything a pooled run produced, for the caller to assert against."""

    results: dict[str, Any] = field(default_factory=dict)
    failures: dict[str, BaseException] = field(default_factory=dict)
    #: Tasks never submitted because an input's producer failed or was
    #: cancelled. Reported, never silently dropped: a task that did not run is
    #: a claim the caller has to account for, not an absence.
    blocked: dict[str, str] = field(default_factory=dict)
    cancelled: list[str] = field(default_factory=list)
    events: list[Event] = field(default_factory=list)
    #: Highest number of executions observed running at once, measured inside
    #: the worker threads. The pool bound is asserted against this in the
    #: self-check rather than trusted.
    peak_concurrency: int = 0


class Controls:
    """What a completion hook may do to the run while it is running.

    Handed to `on_event`, which runs in the main loop between harvests, so
    everything here mutates run state without locking. A control misused —
    releasing a task that was never held, cancelling one already running — is
    an error, not a no-op: the caller is choreographing a demonstration, and a
    cue that silently did nothing produces a run that looks wrong later, with
    the mistake nowhere near the symptom.
    """

    def __init__(self) -> None:
        self._released: list[str] = []
        self._extras: list[tuple[str, Callable[[], Any]]] = []
        self._cancelled: list[str] = []

    def release(self, name: str) -> None:
        self._released.append(name)

    def submit_extra(self, key: str, fn: Callable[[], Any]) -> None:
        self._extras.append((key, fn))

    def cancel(self, name: str) -> None:
        self._cancelled.append(name)


def run_pool(
    tasks: Iterable[TaskLike],
    execute: Callable[[TaskLike], Any],
    *,
    pool_size: int,
    held: Iterable[str] = (),
    on_event: Callable[[Event, Outcome, Controls], None] | None = None,
) -> Outcome:
    """Run every task, at most `pool_size` at once, producers before readers.

    A task becomes eligible when every table it reads either has no producer in
    `tasks` (outside input) or that producer has completed in this run. `held`
    names tasks that stay ineligible until a hook releases them. `on_event`
    fires in the main loop for every submitted/completed/failed event, with the
    live `Outcome` and a `Controls`.
    """
    ordered = sorted(tasks, key=lambda t: t.name)
    by_name = {t.name: t for t in ordered}
    if len(by_name) != len(ordered):
        raise ValueError("two tasks share a name; the pool cannot tell them apart")
    producers = {t.writes: t.name for t in ordered}

    outcome = Outcome()
    held_now = set(held)
    unknown_held = held_now - set(by_name)
    if unknown_held:
        raise ValueError(f"held names nothing here: {', '.join(sorted(unknown_held))}")

    pending = dict(by_name)
    running: dict[str, Future[Any]] = {}
    cancelled: set[str] = set()
    submitting = True

    # Thread-side bookkeeping, the only state touched off the main loop.
    clock_lock = threading.Lock()
    spans: dict[str, tuple[float, float]] = {}
    live = 0

    def timed(key: str, fn: Callable[[], Any]) -> Callable[[], Any]:
        def call() -> Any:
            nonlocal live
            started = time.perf_counter()
            with clock_lock:
                live += 1
                outcome.peak_concurrency = max(outcome.peak_concurrency, live)
            try:
                return fn()
            finally:
                with clock_lock:
                    live -= 1
                    spans[key] = (started, time.perf_counter())

        return call

    def ready() -> list[TaskLike]:
        return [
            task
            for name, task in sorted(pending.items())
            if name not in held_now
            and name not in running
            and all(
                producers.get(source) is None
                or producers[source] in outcome.results
                for source in task.reads
            )
        ]

    def blocked_reason(task: TaskLike) -> str | None:
        for source in task.reads:
            producer = producers.get(source)
            if producer is None:
                continue
            if producer in outcome.failures:
                return f"its input {source} comes from {producer}, which failed"
            if producer in cancelled or producer in outcome.blocked:
                return f"its input {source} comes from {producer}, which never ran"
        return None

    def fire(event: Event) -> None:
        outcome.events.append(event)
        if on_event is None:
            return
        controls = Controls()
        on_event(event, outcome, controls)
        for name in controls._released:
            if name not in held_now:
                raise RuntimeError(f"release({name!r}): it is not held")
            held_now.discard(name)
            outcome.events.append(Event("released", name, time.perf_counter()))
        for name in controls._cancelled:
            if name in running or name in outcome.results or name in outcome.failures:
                raise RuntimeError(f"cancel({name!r}): it already ran or is running")
            if name not in pending:
                raise RuntimeError(f"cancel({name!r}): nothing by that name is pending")
            del pending[name]
            cancelled.add(name)
            outcome.cancelled.append(name)
            outcome.events.append(Event("cancelled", name, time.perf_counter()))
        for key, fn in controls._extras:
            if key in running or key in outcome.results or key in outcome.failures:
                raise RuntimeError(f"submit_extra({key!r}): that key is already in use")
            running[key] = pool.submit(timed(key, fn))
            outcome.events.append(Event("extra", key, time.perf_counter()))

    with ThreadPoolExecutor(max_workers=pool_size) as pool:
        while True:
            if submitting:
                for task in ready():
                    del pending[task.name]
                    running[task.name] = pool.submit(timed(task.name, lambda t=task: execute(t)))
                    fire(Event("submitted", task.name, time.perf_counter()))

            if not running:
                break

            done, _ = wait(running.values(), return_when=FIRST_COMPLETED)
            for key in [k for k, f in running.items() if f in done]:
                future = running.pop(key)
                span = spans.get(key, (None, None))
                # The harvest try covers ONLY the task's own result. `fire` runs
                # outside it, so a broken choreography cue raises out of the run
                # as the caller bug it is, instead of being recorded as the
                # task having failed — which is exactly what happened to the
                # first version of this loop, with the cue's error surfacing as
                # a phantom task failure three assertions away.
                try:
                    result = future.result()
                except BaseException as error:  # noqa: BLE001 — recorded, then surfaced by the caller
                    outcome.failures[key] = error
                    submitting = False
                    fire(Event("failed", key, time.perf_counter(), span[0], span[1]))
                    continue
                outcome.results[key] = result
                fire(Event("completed", key, time.perf_counter(), span[0], span[1]))

        # Whatever never ran, with the reason. Held-forever is the caller's own
        # cue that never fired, and saying so beats a silent short count.
        for name, task in sorted(pending.items()):
            reason = blocked_reason(task)
            if reason is None and name in held_now:
                reason = "still held when the pool drained"
            if reason is None and not submitting:
                reason = "submissions stopped after an earlier failure"
            outcome.blocked[name] = reason or "its inputs never completed, see the other entries"

    return outcome


# --------------------------------------------------------------------------
# Self-check
# --------------------------------------------------------------------------


def _self_check() -> int:
    """Prove the scheduling properties every scale assertion rests on.

    Run directly: `python -m agents.swarm`

    Real threads and a real executor; the executions are short sleeps because
    the property under test is the scheduling, and the live suite runs the same
    pool over real agent sessions. What matters here: nothing runs before its
    inputs, the bound holds, holds hold, cancellation refuses what already ran,
    and a failure blocks its descendants while everything else drains.
    """
    from dataclasses import dataclass as _dataclass

    failures: list[str] = []

    def check(name: str, condition: bool, detail: str) -> None:
        print(f"  {'pass' if condition else 'FAIL'}  {name}: {detail}")
        if not condition:
            failures.append(name)

    @_dataclass(frozen=True)
    class Step:
        name: str
        reads: tuple[str, ...]
        writes: str

    diamond = [
        Step("head", (), "a"),
        Step("left", ("a",), "b"),
        Step("right", ("a",), "c"),
        Step("tail", ("b", "c"), "d"),
    ]

    print("dependency order")
    order: list[str] = []
    order_lock = threading.Lock()

    def slow(step: Step) -> str:
        with order_lock:
            order.append(f"start:{step.name}")
        time.sleep(0.05 if step.name == "left" else 0.01)
        with order_lock:
            order.append(f"end:{step.name}")
        return step.name

    outcome = run_pool(diamond, slow, pool_size=4)
    check(
        "every task ran once",
        sorted(outcome.results) == ["head", "left", "right", "tail"],
        f"results for {len(outcome.results)} of 4",
    )
    check(
        "nothing started before its input's producer ended",
        order.index("end:head") < order.index("start:left")
        and order.index("end:head") < order.index("start:right")
        and order.index("end:left") < order.index("start:tail")
        and order.index("end:right") < order.index("start:tail"),
        "head before both branches, both branches before the tail",
    )
    check(
        "the branches genuinely overlapped",
        order.index("start:right") < order.index("end:left"),
        "right started while the slower left was still working — the point of a pool",
    )

    print()
    print("the bound")
    wide = [Step(f"w{i}", (), f"o{i}") for i in range(9)]
    bounded = run_pool(wide, lambda s: time.sleep(0.03) or s.name, pool_size=3)
    check(
        "at most pool_size ran at once",
        0 < bounded.peak_concurrency <= 3,
        f"peak {bounded.peak_concurrency} with pool_size 3 over 9 tasks",
    )
    check(
        "all nine still completed",
        len(bounded.results) == 9,
        "the bound queues, it does not drop",
    )

    print()
    print("holds, extras, cancellation")
    cues: list[str] = []

    def choreograph(event: Event, live: Outcome, controls: Controls) -> None:
        if event.kind == "completed" and event.key == "head":
            controls.release("left")
            controls.submit_extra("head#again", lambda: "extra-ran")
            cues.append("released-left")

    held_outcome = run_pool(diamond, slow, pool_size=4, held=["left"], on_event=choreograph)
    check(
        "a held task waits for its cue",
        cues == ["released-left"] and "left" in held_outcome.results,
        "left ran only after head's completion released it",
    )
    check(
        "an extra execution runs under its own key",
        held_outcome.results.get("head#again") == "extra-ran",
        "the mid-run change enters the pool this way",
    )

    def cancel_tail(event: Event, live: Outcome, controls: Controls) -> None:
        if event.kind == "completed" and event.key == "head":
            controls.cancel("tail")

    cancelled = run_pool(diamond, slow, pool_size=4, on_event=cancel_tail)
    check(
        "a cancelled task never runs and is recorded",
        cancelled.cancelled == ["tail"] and "tail" not in cancelled.results,
        "the repair's shrinking plan is this control",
    )

    refused = ""
    try:
        run_pool(
            diamond,
            slow,
            pool_size=4,
            on_event=lambda e, _o, c: c.cancel("head") if e.kind == "completed" and e.key == "head" else None,
        )
    except RuntimeError as error:
        refused = str(error)
    check(
        "cancelling what already ran is refused",
        "already ran" in refused,
        "a cue that silently did nothing would surface as a wrong count far away",
    )

    unknown_hold = ""
    try:
        run_pool(diamond, slow, pool_size=4, held=["nobody"])
    except ValueError as error:
        unknown_hold = str(error)
    check(
        "holding an unknown name is refused up front",
        "nobody" in unknown_hold,
        "a typo in a cue must not become a task that quietly never runs",
    )

    print()
    print("failure")

    def explode(step: Step) -> str:
        if step.name == "left":
            raise RuntimeError("left broke")
        return slow(step)

    failed = run_pool(diamond, explode, pool_size=4)
    check(
        "the failure is recorded, not raised mid-drain",
        "left" in failed.failures and isinstance(failed.failures["left"], RuntimeError),
        "the caller decides what a failure means",
    )
    check(
        "the failed task's descendant is blocked with the reason",
        "tail" in failed.blocked and "left" in failed.blocked["tail"],
        f"tail: {failed.blocked.get('tail', 'MISSING')}",
    )
    check(
        "work not downstream of the failure still finished",
        "right" in failed.results and "head" in failed.results,
        "one broken branch does not abandon the others",
    )

    two_share = [Step("one", (), "same"), Step("two", (), "same2"), Step("one", (), "same3")]
    duplicate = ""
    try:
        run_pool(two_share, slow, pool_size=2)
    except ValueError as error:
        duplicate = str(error)
    check(
        "two tasks sharing a name are refused",
        "share a name" in duplicate,
        "results are keyed by name, so a collision would silently drop one",
    )

    cyclic = [Step("x", ("y_out",), "x_out"), Step("y", ("x_out",), "y_out")]
    stuck = run_pool(cyclic, slow, pool_size=2)
    check(
        "a cycle drains to blocked instead of hanging",
        sorted(stuck.blocked) == ["x", "y"] and not stuck.results,
        "each names the input it was waiting on",
    )

    print()
    if failures:
        print(f"FAILED: {', '.join(failures)}")
        return 1
    print("the pool schedules and the caller decides")
    return 0


if __name__ == "__main__":
    raise SystemExit(_self_check())
