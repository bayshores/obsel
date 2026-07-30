"""Everything a worker says to obsel, over its HTTP API.

urllib rather than requests, so an agent needs nothing installed beyond its own
CLI to talk to the coordinator.

The one rule here that is not obvious is `MUTATION_TIMEOUT`: a timeout on a
mutation is an UNKNOWN outcome, not a failure. Its comment says why.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

OBSEL_URL = os.environ.get("OBSEL_URL", "http://localhost:3000")

REPO_ROOT = Path(__file__).resolve().parent.parent


def auth_headers() -> dict[str, str]:
    """The Authorization header for obsel's mutating routes, or nothing.

    obsel's task, demo and erasure mutations all require a bearer token,
    `OBSEL_API_TOKEN`. Read per call rather than once at import, so a token set
    after this module loaded is still found.

    Two places are consulted, in order:

    - The environment. Server-spawned agents get it this way: `launcher.ts` and
      `reporter.ts` spread the server's own environment into their children.
    - `.env.local` at the repository root. `scripts/start.sh` generates the
      token into that file, and nothing sources it into an operator's shell, so
      the documented terminal path (`python -m agents.run ...` in a fresh
      window) would otherwise break the moment the routes were gated. The token
      is already on disk in that file; reading it leaks nothing new.

    When neither holds one, the answer is no header at all, not an error. The
    server's refusal names the variable and says what to do, and that sentence
    is the authoritative one -- a second copy of it here would drift.
    """
    token = os.environ.get("OBSEL_API_TOKEN", "").strip()
    if not token:
        token = _env_local_token()
    return {"Authorization": f"Bearer {token}"} if token else {}


def _env_local_token(path: Path = REPO_ROOT / ".env.local") -> str:
    """`OBSEL_API_TOKEN` from the settings file, or empty.

    A deliberately narrow reader: one key, `KEY=value` lines only, first match
    wins, quotes stripped. Anything unreadable is treated as no token, because
    the failure that matters -- no usable token -- is answered by the server's
    own refusal either way.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return ""
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("OBSEL_API_TOKEN="):
            continue
        value = stripped.split("=", 1)[1].strip()
        return value.strip("\"'")
    return ""



def _send(request: urllib.request.Request, url: str, timeout: float) -> Any:
    """Do the call and parse the reply, or raise with the real reason.

    urllib rather than requests, so an agent needs nothing installed beyond the
    model client to talk to the coordinator.
    """
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace").strip()
        # A page rather than an API reply means something else is on that port.
        # Dumping the markup buries the actual problem, so name it instead.
        if detail.startswith("<"):
            raise RuntimeError(
                f"{url} returned {error.code} and an HTML page rather than JSON. "
                "Something other than obsel is answering on that port -- start obsel "
                "with `pnpm dev`, or point the agents elsewhere with --obsel-url."
            ) from error
        raise RuntimeError(f"{url} returned {error.code}: {detail[:500]}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(
            f"could not reach obsel at {url} ({error.reason}). "
            "Start it with `pnpm dev` before running the agents."
        ) from error


def post_json(
    url: str,
    body: dict[str, Any],
    timeout: float = 60.0,
    headers: dict[str, str] | None = None,
) -> Any:
    """POST JSON to obsel and return the parsed reply.

    `headers` is additive and optional. Every mutating route wants the bearer
    token from `auth_headers()`, and it belongs on the call rather than baked in
    here, because this function is also how reads are made and a credential sent
    where none is needed is a credential waiting to leak into a log.
    """
    return _send(
        urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", **(headers or {})},
            method="POST",
        ),
        url,
        timeout,
    )


def get_json(url: str, timeout: float = 60.0, headers: dict[str, str] | None = None) -> Any:
    """GET JSON from obsel and return the parsed reply."""
    return _send(urllib.request.Request(url, headers=headers or {}, method="GET"), url, timeout)


def read_swarm(obsel_url: str = OBSEL_URL) -> dict[str, Any]:
    """Everything obsel currently holds about the swarm, read back from obsel.

    The caller uses this instead of guessing from local files. What is on disk is
    this machine's leftovers; what obsel holds is what obsel will actually compare
    the next run against, and only the second one can support a claim about obsel.
    """
    swarm = get_json(f"{obsel_url}/api/swarm")
    if not isinstance(swarm, dict) or not isinstance(swarm.get("snapshot"), dict):
        raise RuntimeError(f"{obsel_url}/api/swarm did not return a swarm snapshot: {swarm!r:.300}")
    tasks = swarm["snapshot"].get("tasks")
    if not isinstance(tasks, list):
        raise RuntimeError(
            f"{obsel_url}/api/swarm returned a snapshot with no task list: {swarm!r:.300}"
        )
    return swarm


def obsel_task(task_urn: str, obsel_url: str = OBSEL_URL) -> dict[str, Any]:
    """obsel's record of one task. Raises if obsel has never heard of it."""
    for record in read_swarm(obsel_url)["snapshot"]["tasks"]:
        if isinstance(record, dict) and record.get("urn") == task_urn:
            return record
    raise RuntimeError(
        f"obsel has no task {task_urn}. Run `python -m agents.run register` first; "
        "without a registered task there is no lineage to traverse."
    )


def has_recorded_output(task_urn: str, dataset_urn: str, obsel_url: str = OBSEL_URL) -> bool:
    """Whether obsel already holds a fingerprint for this task's output.

    This is what decides whether a completion is a first version or a comparison.
    It is deliberately read out of obsel rather than inferred from whether a local
    output file exists: the local file says what this machine last wrote, which is
    not the baseline obsel will compare against and can disagree with it after a
    reset on either side.
    """
    record = obsel_task(task_urn, obsel_url)
    fingerprints = record.get("fingerprints")
    if not isinstance(fingerprints, dict):
        raise RuntimeError(
            f"obsel's record of {task_urn} has no fingerprint map "
            f"(got {type(fingerprints).__name__}); cannot tell a first run from a re-run."
        )
    return dataset_urn in fingerprints


# How long a mutation is given before the client stops waiting.
#
# These are not the 60-second default, and the difference was paid for. A
# completion report is answered only after obsel has walked the lineage, written
# every mark, and had DataHub confirm each write, which measured 13.3 s for a
# nine-mark cascade on a quiet stack -- and on 2026-07-24, with DataHub under
# sustained load from a night of forty-task runs, the same call outran a 60 s
# client while the server finished the work. The completion landed, every mark
# correct, and the worker had already declared the run dead: the worst shape of
# failure, because the operator is told the opposite of what is true. A timeout
# on a mutation is an UNKNOWN outcome, not a failure, so the ceiling is set
# where a genuine hang is the only thing left that can reach it.
MUTATION_TIMEOUT = 300.0


def announce_start(
    task_urn: str, obsel_url: str = OBSEL_URL, client: dict[str, str] | None = None
) -> Any:
    """Tell obsel this agent has begun. Work in flight is never marked stale.

    `client` is what an MCP client named itself when it connected, passed only by
    `mcp_server.py`, which is the one caller in a position to know it. obsel's
    own workers leave it out: they are not an MCP client of anything.
    """
    body: dict[str, Any] = {"taskUrn": task_urn}
    if client:
        body["client"] = client
    return post_json(f"{obsel_url}/api/tasks/start", body,
                     timeout=MUTATION_TIMEOUT, headers=auth_headers())


def abandon_run(task_urn: str, obsel_url: str = OBSEL_URL) -> Any:
    """Give a start announcement back, because the work behind it died.

    The counterpart to `announce_start`. obsel excludes `running` work from the
    cascade, so a task left at `running` by a failed agent is skipped by every
    later traversal while the board still shows a healthy swarm -- a false
    negative, which is the one answer obsel must never give.
    """
    return post_json(f"{obsel_url}/api/tasks/abandon", {"taskUrn": task_urn},
                     timeout=MUTATION_TIMEOUT, headers=auth_headers())


def report_completion(
    task_urn: str,
    fingerprints: dict[str, dict[str, str]],
    finished_at: str,
    obsel_url: str = OBSEL_URL,
    run: dict[str, Any] | None = None,
    inputs: dict[str, dict[str, Any]] | None = None,
) -> Any:
    """The CompletionReport. obsel answers with what this completion invalidated.

    `run` is what the page shows a viewer -- which runner did the work, how
    long it took, and the shape of what came out. obsel decides nothing on it,
    and omitting it changes no staleness answer; it exists so a person watching
    the board can see what the terminal sees.

    The duration is this process's own measurement of its own run. It is sent
    rather than left for obsel to derive from `finishedAt`, because obsel would
    have to subtract its own clock from this machine's to get it.

    `inputs` is what this task READ, hashed the same way as what it wrote. It is
    the one piece of evidence that can expose a table rewritten by something
    that never reports: the writer sent no fingerprint, so the reader's is the
    only record of what the table holds now. Optional, because the tables were
    already in memory when this is cheap and an agent without them should not
    fake it.
    """
    body: dict[str, Any] = {
        "taskUrn": task_urn,
        "fingerprints": fingerprints,
        "finishedAt": finished_at,
    }
    if run is not None:
        body["run"] = run
    if inputs is not None:
        body["inputs"] = inputs
    return post_json(
        f"{obsel_url}/api/tasks/complete", body, timeout=MUTATION_TIMEOUT,
        headers=auth_headers(),
    )
