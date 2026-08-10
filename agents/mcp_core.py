"""The decisions behind obsel's MCP tools, with no MCP and no network in them.

`agents/mcp_server.py` is the doorway an outside agent walks through; this file is
everything that doorway has to get right. Splitting them is not tidiness. The
server needs the `mcp` SDK, which lives in `agents/.venv`, and `pnpm test:python`
runs with the bare system `python3` -- so anything that imports the SDK cannot be
checked by `pnpm verify`. This module is standard library only, and every judgement
worth checking is in here rather than in a tool closure.

The rules it enforces, and why each one exists:

- A reply obsel never sent is refused, never read as an empty list. `affected: []`
  means "nothing downstream was invalidated", which is the one wrong answer that
  looks exactly like everything being fine. See `run.py:_required_list`, whose
  discipline this repeats.
- An agent never hands obsel a hash. `completion_body` takes rows and columns and
  does the hashing here, through the same `canonicalise_numbers` -> `fingerprint`
  path `worker.run_task` uses. Two paths to one recorded fingerprint would be two
  definitions of what counts as a change.
- A table the task never declared it writes is refused. Fingerprinting an output
  nobody registered would record evidence against lineage that does not exist, so
  the change could never cascade.
- A dataset with no registered producer is reported as exactly that, never as
  fresh. "I could not find out" and "it is fine" are different answers.
- A table may be reported as a `{"path": ...}` to the real file instead of
  inline rows, and the file form is the better one. A model pasting five
  hundred rows into a tool call will eventually truncate or paraphrase one,
  the hash moves, and obsel reports a change nobody made. Hashing the file the
  next agent will actually read cannot drift that way.

The erasure tools are in `agents/mcp_erasure.py`, deliberately not here. This
module's default where nothing is on record is "nothing contradicts it", which
is right for staleness and would be a certificate of erasure there.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from agents.fingerprint import fingerprint
from agents.tables import canonicalise_numbers

Table = dict[str, Any]  # {"columns": [...], "rows": [...]}


class ObselReplyError(RuntimeError):
    """obsel's answer does not support what the tool was about to return.

    Its own type so the server can tell "obsel said something unusable" apart from
    "obsel could not be reached", which `worker._send` already names. An agent
    reading a tool error has to know whether to start obsel or to stop trusting
    the answer it just got.
    """


class ToolInputError(ValueError):
    """The calling agent asked for something obsel cannot be asked.

    Separate from `ObselReplyError` because the fix is the agent's, not the
    operator's, and the message is written to be actionable by a model: it names
    what was passed and what was expected.
    """


# --------------------------------------------------------------------------
# Reading obsel's replies
# --------------------------------------------------------------------------


def required(reply: Any, key: str, where: str) -> Any:
    """One key out of an obsel reply, or an error naming what was missing."""
    if not isinstance(reply, dict):
        raise ObselReplyError(f"obsel's reply to {where} is not an object: {reply!r:.300}")
    if key not in reply:
        raise ObselReplyError(
            f"obsel's reply to {where} has no {key!r} key "
            f"(it carries: {', '.join(sorted(reply)) or 'nothing'}). "
            "Reading a missing key as empty would turn a broken reply into a pass."
        )
    return reply[key]


def required_list(reply: Any, key: str, where: str) -> list[Any]:
    """One list out of an obsel reply. An absent key is not an empty list.

    Never `reply.get(key) or []`. For `affected` and `changedOutputs` an empty
    list is a real and common answer -- it is what an identical re-run returns --
    so a missing key silently becomes the good news rather than the error it is.
    """
    value = required(reply, key, where)
    if not isinstance(value, list):
        raise ObselReplyError(
            f"obsel's reply to {where} has {key!r} as {type(value).__name__}, not a list"
        )
    return value


def required_dict(reply: Any, key: str, where: str) -> dict[str, Any]:
    """One object out of an obsel reply, with the same refusal to guess."""
    value = required(reply, key, where)
    if not isinstance(value, dict):
        raise ObselReplyError(
            f"obsel's reply to {where} has {key!r} as {type(value).__name__}, not an object"
        )
    return value


# --------------------------------------------------------------------------
# URNs in, short names out
# --------------------------------------------------------------------------


def dataset_short_name(dataset_urn: str) -> str:
    """`urn:li:dataset:(...,obsel_demo.clean_orders,PROD)` -> `clean_orders`.

    The mirror of `datasetName` in `src/server/datahub/urns.ts`, and deliberately
    only ever used in this direction. obsel's HTTP API takes short names and builds
    the URNs itself so the naming convention lives in one place; this module parses
    URNs obsel has already returned, and never constructs one. An agent that could
    invent a URN could name a dataset that does not exist.
    """
    if "," not in dataset_urn:
        return dataset_urn
    return dataset_urn.split(",")[1].split(".")[-1]


def short_names(dataset_urns: Iterable[str]) -> list[str]:
    return [dataset_short_name(urn) for urn in dataset_urns]


# --------------------------------------------------------------------------
# Registration
# --------------------------------------------------------------------------


#: The shape a name must have for a URN built from it to be readable again.
#:
#: The mirror of `NAME_PATTERN` in `src/server/datahub/urns.ts`, and asserted equal
#: to it by `tests/register-body.test.ts` the way the URN builders are. It matters
#: on this side because `dataset_short_name` above recovers a table name by
#: splitting on commas and then dots: a name carrying either is interpolated into a
#: URN that comes back as something shorter, so obsel registers a real DataJob whose
#: lineage points at an entity nobody can look up. The board draws it and nothing
#: downstream can tell.
#:
#: Matched with `fullmatch` everywhere below, never `match`. The pattern text is the
#: same on both sides, and that is not enough on its own: Python's `$` also matches
#: immediately before a newline at the end of the string, and JavaScript's `$`
#: without the `m` flag does not, so `re.match` accepted "clean_orders\n" while the
#: TypeScript door refused it. `fullmatch` closes that without changing the text the
#: two doors are asserted equal on.
NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_]*$")

#: One phrasing of the rule, so the two doors and the docs do not drift apart.
_SHAPE = "lowercase letters, digits and underscores, starting with a letter or digit"


def task_name_problem(name: str) -> str | None:
    """Why this task id cannot be used, or None if it can.

    Returns the reason rather than a boolean because the caller is handing the
    message to a model, and "invalid name" gives it nothing to correct.
    """
    if NAME_PATTERN.fullmatch(name):
        return None
    return (
        f"task name {name!r} is not a code identifier. Use {_SHAPE}, "
        'e.g. "build_revenue". The name is interpolated into this task\'s DataJob '
        "URN, so anything else builds an entity that cannot be read back by name."
    )


def dataset_name_problem(name: str) -> str | None:
    """Why this table name cannot be used, or None if it can.

    One namespace segment is allowed -- `obsel_taxi.clean_trips` -- because obsel
    passes a qualified name through untouched and the scale swarm registers that
    way. A second dot is refused: every reader takes the LAST dot-separated
    segment, so `a.b.c` comes back as `c`.

    A URN is refused, which is the case an agent actually hits. obsel's HTTP API
    takes short names and builds the URNs itself; a URN sent to registration is
    qualified into `obsel_demo.urn:li:dataset:(...)`, an entity nothing else
    matches.
    """
    segments = name.split(".")
    if len(segments) <= 2 and all(NAME_PATTERN.fullmatch(segment) for segment in segments):
        return None
    tail = (
        "obsel takes SHORT names here and builds the URNs itself; a URN would be "
        "qualified into obsel_demo.urn:li:dataset:(...), a different entity."
        if name.startswith("urn:li:")
        else "The name is interpolated into the dataset URN and recovered by "
        "splitting on commas and dots, so anything else names a table nothing "
        "can look up."
    )
    return (
        f"dataset name {name!r} is not a table name. Use {_SHAPE}, "
        'e.g. "clean_orders", optionally with one namespace segment like '
        f'"obsel_taxi.clean_trips". {tail}'
    )


def registration_problem(name: str, reads: Sequence[str], writes: Sequence[str]) -> str | None:
    """The first thing wrong with a registration's names, or None.

    First rather than all of them: the caller is a model that will fix one name
    and call again, and a list of five reasons for one typo reads as five faults.
    """
    problem = task_name_problem(name)
    if problem is not None:
        return problem
    for table in [*reads, *writes]:
        problem = dataset_name_problem(table)
        if problem is not None:
            return problem
    return None


def lineage_matches(record: Mapping[str, Any], reads: Sequence[str], writes: Sequence[str]) -> bool:
    """Whether an existing task already declares exactly this lineage.

    Set comparison on short names: the record holds full URNs, the agent passes
    short names, and the order it lists them in is not part of what it declared.
    """
    return set(short_names(record.get("reads") or [])) == set(reads) and set(
        short_names(record.get("writes") or [])
    ) == set(writes)


def find_task_by_name(tasks: Sequence[Any], name: str) -> dict[str, Any] | None:
    for record in tasks:
        if isinstance(record, dict) and record.get("name") == name:
            return record
    return None


# --------------------------------------------------------------------------
# Freshness
# --------------------------------------------------------------------------

#: Worst first. A table with two producers takes the worst of them, because the
#: question an agent is asking is "is it safe to build on this", and one stale
#: producer is enough for the answer to be no.
_VERDICT_ORDER = ("stale", "in-flight", "not-yet-produced", "fresh")


def _producer_verdict(status: Any) -> str:
    if status == "stale":
        return "stale"
    if status == "running":
        return "in-flight"
    if status == "complete":
        return "fresh"
    # `registered`, or any status this version does not know: the producer exists
    # but has not finished, so the table is not there to read yet.
    return "not-yet-produced"


def freshness_verdicts(tasks: Sequence[Any], reads: Sequence[str]) -> dict[str, Any]:
    """For each table an agent means to read, what state its producers are in.

    Returns lists rather than a `safeToProceed` boolean on purpose. A boolean
    compresses five distinct states into one bit and invites an agent to act on
    the bit alone; the lists name the problem, so an agent that reports a blocked
    start can say which table and why.

    A table nothing registered produces is `no-registered-producer` and appears in
    neither problem list. It is usually a seed table, but it is also what a typo
    looks like, and calling either of those `fresh` would be a claim obsel has no
    basis for.
    """
    verdicts: list[dict[str, Any]] = []
    stale_inputs: list[str] = []
    in_flight_inputs: list[str] = []

    for table in reads:
        producers: list[dict[str, Any]] = []
        worst = "fresh"
        mark: Any = None
        dataset: str | None = None

        for record in tasks:
            if not isinstance(record, dict):
                continue
            for written in record.get("writes") or []:
                if dataset_short_name(written) != table:
                    continue
                dataset = written
                verdict = _producer_verdict(record.get("status"))
                producers.append(
                    {
                        "taskUrn": record.get("urn"),
                        "name": record.get("name"),
                        "title": record.get("title"),
                        "status": record.get("status"),
                    }
                )
                if _VERDICT_ORDER.index(verdict) < _VERDICT_ORDER.index(worst):
                    worst = verdict
                if verdict == "stale" and isinstance(record.get("stale"), dict):
                    # Carried through untouched. The reason obsel wrote is the
                    # traceable cause; a summary of it here would be a second,
                    # weaker account of the same fact.
                    mark = record["stale"]

        if not producers:
            verdicts.append(
                {
                    "table": table,
                    "dataset": None,
                    "status": "no-registered-producer",
                    "producers": [],
                    "stale": None,
                }
            )
            continue

        verdicts.append(
            {
                "table": table,
                "dataset": dataset,
                "status": worst,
                "producers": producers,
                "stale": mark if worst == "stale" else None,
            }
        )
        if worst == "stale":
            stale_inputs.append(table)
        elif worst == "in-flight":
            in_flight_inputs.append(table)

    return {
        "verdicts": verdicts,
        "staleInputs": stale_inputs,
        "inFlightInputs": in_flight_inputs,
    }


# --------------------------------------------------------------------------
# Completion
# --------------------------------------------------------------------------


def _validate_table(table_name: str, table: Any) -> Table:
    if not isinstance(table, dict):
        raise ToolInputError(
            f"table {table_name!r} must be an object with 'columns' and 'rows', "
            f"got {type(table).__name__}"
        )
    columns = table.get("columns")
    rows = table.get("rows")
    if not isinstance(columns, list) or not columns:
        raise ToolInputError(
            f"table {table_name!r} needs a non-empty 'columns' list naming the "
            "columns actually written; obsel hashes rows by declared column, so "
            "an empty contract hashes nothing."
        )
    if not all(isinstance(column, str) and column for column in columns):
        raise ToolInputError(f"table {table_name!r} has a column name that is not a string")
    if not isinstance(rows, list):
        raise ToolInputError(
            f"table {table_name!r} needs a 'rows' list (an empty list is a real "
            f"answer and is accepted), got {type(rows).__name__}"
        )
    if not all(isinstance(row, dict) for row in rows):
        raise ToolInputError(f"table {table_name!r} has a row that is not an object")
    return {"columns": list(columns), "rows": [dict(row) for row in rows]}


def _load_table_file(table_name: str, path_value: Any) -> Table:
    """The file form: read and validate the table the next agent will actually read.

    Every error names the path and the working directory, because the calling
    agent chose the path and the fix is a better one — this is a `ToolInputError`
    story from start to finish, never a stack trace.
    """
    if not isinstance(path_value, str) or not path_value:
        raise ToolInputError(f"table {table_name!r} has a 'path' that is not a non-empty string")
    path = Path(path_value)
    if not path.is_file():
        raise ToolInputError(
            f"table {table_name!r} points at {path}, and there is no file there. "
            f"A relative path resolves from the MCP server's working directory, "
            f"which is {Path.cwd()}."
        )
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except UnicodeDecodeError as error:
        raise ToolInputError(f"table {table_name!r} at {path} is not UTF-8 text: {error}") from None
    except json.JSONDecodeError as error:
        raise ToolInputError(f"table {table_name!r} at {path} is not valid JSON: {error}") from None
    except OSError as error:
        raise ToolInputError(f"table {table_name!r} at {path} could not be read: {error}") from None
    return _validate_table(table_name, loaded)


def _resolve_table_value(table_name: str, value: Any) -> Table:
    """A table given inline, or as `{"path": ...}` to the real file.

    The file form is the safer of the two and the reason it exists: a model
    pasting hundreds of rows into a tool call will sooner or later truncate or
    paraphrase one, which moves the content hash, and obsel then reports a
    change nobody made — the exact false alarm it is built to never raise.
    The file is what the next agent will read, so its bytes are the truth.
    """
    if isinstance(value, dict) and "path" in value:
        if "columns" in value or "rows" in value:
            raise ToolInputError(
                f"table {table_name!r} has both 'path' and inline table keys; "
                "pass the path alone, or the columns and rows alone"
            )
        return _load_table_file(table_name, value["path"])
    return _validate_table(table_name, value)


def resolve_outputs(record: Mapping[str, Any], outputs: Mapping[str, Any]) -> dict[str, Table]:
    """Map the short table names an agent reported to the URNs it declared.

    Refuses a table this task never declared it writes, and refuses an empty
    report. Recording either would put evidence in obsel about a dataset with no
    `Produces` edge to this task, or clear the task's own flag with nothing to
    compare.

    Refused here so the agent is told in the words of the tool it called, naming
    the short table it typed. The same two refusals are made again at obsel's
    own door by `evidenceProblem` in
    `src/server/coordinator/completion-evidence.ts`, which is the one that
    holds: `agents/worker.py` and `agents/report.py` post to
    `/api/tasks/complete` without passing through here.
    """
    declared = {dataset_short_name(urn): urn for urn in record.get("writes") or []}
    if not outputs:
        raise ToolInputError(
            "report at least one output table. If your task genuinely produced "
            "nothing, do not report completion -- there is no fingerprint to compare."
        )

    resolved: dict[str, Table] = {}
    for table_name, table in outputs.items():
        urn = declared.get(table_name)
        if urn is None:
            raise ToolInputError(
                f"{record.get('name')} did not declare that it writes {table_name!r}. "
                f"It declared: {', '.join(sorted(declared)) or 'nothing'}. "
                "Register the task with the tables it really writes, or fix the name."
            )
        resolved[urn] = _resolve_table_value(table_name, table)
    return resolved


def resolve_inputs(record: Mapping[str, Any], inputs: Mapping[str, Any]) -> dict[str, Table]:
    """Map the short table names of what an agent read to the URNs it declared.

    The same refusal as `resolve_outputs`, for the same silent failure: an
    observation recorded against a table this task has no `Consumes` edge to
    would be evidence obsel files where no comparison will ever find it. Unlike
    outputs, an empty mapping is fine — observations are optional, and a task
    that did not hash what it read should send nothing rather than invent it.
    """
    declared = {dataset_short_name(urn): urn for urn in record.get("reads") or []}
    resolved: dict[str, Table] = {}
    for table_name, table in inputs.items():
        urn = declared.get(table_name)
        if urn is None:
            raise ToolInputError(
                f"{record.get('name')} did not declare that it reads {table_name!r}. "
                f"It declared: {', '.join(sorted(declared)) or 'nothing'}. "
                "Register the task with the tables it really reads, or fix the name."
            )
        resolved[urn] = _resolve_table_value(table_name, table)
    return resolved


def completion_body(
    record: Mapping[str, Any],
    outputs: Mapping[str, Any],
    finished_at: str,
    runner: str | None = None,
    ms: float | None = None,
    inputs: Mapping[str, Any] | None = None,
    volatile: Mapping[str, Sequence[str]] | None = None,
    client: Mapping[str, str] | None = None,
) -> tuple[dict[str, Any], dict[str, dict[str, str]]]:
    """The body for `POST /api/tasks/complete`, and the fingerprints it carries.

    Both are returned because the tool shows the agent the hashes it recorded on
    its behalf. An agent that never computes a fingerprint should still be able to
    see the one obsel is now comparing against.

    `canonicalise_numbers` runs before `fingerprint`, exactly as `run_task` does
    it, and for the same measured reason: the same value written `217` one run and
    `217.0` the next moved the content hash and obsel correctly reported a change
    nobody made. An outside agent's JSON layer can drift the same way, and it is
    less able to know it did. Applying it here rather than asking the skill to
    teach number discipline keeps one definition of what a changed output is.

    `run` is sent only when both `runner` and `ms` are present, because obsel's
    schema requires the whole object or none of it. It is display material: obsel
    decides nothing on it and a completion without it gets an identical answer.

    `inputs` is what the task READ, hashed here exactly as the outputs are. It is
    the only evidence that can expose a table rewritten by something that never
    reports: the writer sent no fingerprint, so this reader's is the one record
    of what the table holds now. Optional, and worth sending as paths — the files
    are already on disk, so observing them costs one key per table.

    `volatile` is `volatile_by_dataset(tasks)`: the columns each table's producer
    declared meaningless, keyed by dataset URN. It is applied to outputs AND to
    input observations, and it has to be both -- a reader that hashed an input
    without the producer's exclusions would produce a fingerprint the producer
    never could, which obsel reads as a change nothing reported.

    `client` is what the MCP client named itself when it connected, which only
    `mcp_server.py` is in a position to know. It is a separate fact from `runner`
    and neither substitutes for the other: `runner` is what the agent says did
    the work, `client` is what spoke MCP to obsel. Both are the caller's own
    account of itself, and obsel decides nothing on either.
    """
    exclusions = {dataset: list(columns) for dataset, columns in (volatile or {}).items()}
    tables = resolve_outputs(record, outputs)

    # Which outputs arrived as paths, so the shape sent for the board can say
    # where the file lives. Reconstructed from the raw mapping because
    # `resolve_outputs` returns bare tables; display material only.
    declared_writes = {dataset_short_name(urn): urn for urn in record.get("writes") or []}
    paths = {
        declared_writes[name]: value["path"]
        for name, value in outputs.items()
        if isinstance(value, dict) and "path" in value and name in declared_writes
    }

    fingerprints: dict[str, dict[str, str]] = {}
    shapes: dict[str, dict[str, Any]] = {}
    for urn, table in tables.items():
        canonical = canonicalise_numbers(table)
        fingerprints[urn] = fingerprint(
            canonical["rows"], canonical["columns"], exclude=exclusions.get(urn, [])
        )
        shapes[urn] = {"rows": len(canonical["rows"]), "columns": list(canonical["columns"])}
        if urn in paths:
            shapes[urn]["path"] = str(paths[urn])

    body: dict[str, Any] = {
        "taskUrn": record.get("urn"),
        "fingerprints": fingerprints,
        "finishedAt": finished_at,
    }
    # The shape always goes; the runner and the duration go only when they were
    # given. They used to be required together, and that quietly cost the shape:
    # a caller with no stopwatch had to drop the whole object, and `run.outputs`
    # is what obsel's engine diffs to name the columns that moved. So a report
    # without a measured duration now still produces "clean expenses lost
    # amount" rather than "the columns in clean expenses changed".
    #
    # Nulls rather than absent keys, because the completion route reads them as
    # "was not told" and obsel writes that through to the entity, where an
    # invented `0` would read as a measurement.
    body["run"] = {
        "runner": runner if runner else None,
        "ms": round(float(ms)) if ms is not None else None,
        "outputs": shapes,
    }
    # Absent rather than null when unknown: a client that never completed the MCP
    # handshake has told obsel nothing about itself, and an empty name recorded as
    # though it had would be obsel inventing an identity.
    if client:
        body["client"] = dict(client)

    if inputs:
        observations: dict[str, dict[str, Any]] = {}
        for urn, table in resolve_inputs(record, inputs).items():
            canonical = canonicalise_numbers(table)
            observations[urn] = {
                **fingerprint(
                    canonical["rows"], canonical["columns"], exclude=exclusions.get(urn, [])
                ),
                "columns": list(canonical["columns"]),
            }
        body["inputs"] = observations
    return body, fingerprints


# --------------------------------------------------------------------------
# Reading the answer back
# --------------------------------------------------------------------------


def summarise_coordination(coordination: Any) -> list[str]:
    """obsel's answer in sentences an agent can hand to a person.

    The reading half of `run.py:_print_coordination`. Every list is taken through
    `required_list`, so a reply that lost its `affected` key reads as an error
    rather than as "nothing was affected".
    """
    where = "a completion report"
    changed = required_list(coordination, "changedOutputs", where)
    affected = required_list(coordination, "affected", where)
    # Read as strictly as `affected`, and for the same reason pointed the other
    # way: a lost key read as an empty list would summarize "nothing was
    # cleared" over a reply that cleared two tasks, and the operator being told
    # about work that silently flipped back to sound is the entire point of the
    # field.
    restored = required_list(coordination, "restored", where)
    elapsed = coordination.get("elapsedMs")
    elapsed_text = f"{elapsed} ms" if elapsed is not None else "unreported"

    lines: list[str] = []
    if not changed:
        lines.append(f"no outputs changed; nothing was marked stale ({elapsed_text})")
    else:
        lines.append(
            "changed "
            + ", ".join(
                f"{dataset_short_name(item['dataset'])} ({item['kind']})" for item in changed
            )
        )
        if not affected:
            lines.append(f"nothing downstream had finished, so nothing was marked ({elapsed_text})")
        else:
            lines.append(f"marked {len(affected)} finished task(s) stale in {elapsed_text}")
            for entry in affected:
                mark = entry["mark"]
                hops = mark["hops"]
                lines.append(f"{entry['task']['name']} ({hops} {'hop' if hops == 1 else 'hops'}): {mark['reason']}")

    # An identical redo of flagged work arrives here with `changed` empty and
    # `restored` full -- the one reply where the quiet half and the loud half
    # are the same event, so this is appended to either branch above.
    for entry in restored:
        lines.append(f"cleared {entry['task']['name']} without a re-run: {entry['reason']}")
    return lines


def board_summary(swarm: Any) -> dict[str, Any]:
    """The swarm trimmed to what an agent reading the board needs.

    Fingerprints and run detail are dropped: a hash tells an agent nothing it can
    act on, and `check_freshness` is the tool for deciding anything. This is for
    orientation -- who else is here, what state are they in.
    """
    snapshot = required_dict(swarm, "snapshot", "a board read")
    tasks = required_list(snapshot, "tasks", "a board read")

    counts = {"registered": 0, "running": 0, "complete": 0, "stale": 0}
    summarized: list[dict[str, Any]] = []
    for record in tasks:
        if not isinstance(record, dict):
            continue
        status = record.get("status")
        if status in counts:
            counts[status] += 1
        mark = record.get("stale")
        summarized.append(
            {
                "urn": record.get("urn"),
                "name": record.get("name"),
                "title": record.get("title"),
                "status": status,
                "reads": short_names(record.get("reads") or []),
                "writes": short_names(record.get("writes") or []),
                "finishedAt": record.get("finishedAt"),
                "stale": (
                    {
                        "reason": mark.get("reason"),
                        "hops": mark.get("hops"),
                        "since": mark.get("since"),
                        # How many changes independently broke this, so an agent
                        # can tell "one thing to fix" from "several". A count
                        # rather than the list: the reason names the nearest
                        # cause already, and an agent acting on the rest reads
                        # `rerun_plan`. Marks written before causes were recorded
                        # carry one reason, which is one cause.
                        "causes": len(mark.get("causes") or []) or 1,
                    }
                    if isinstance(mark, dict)
                    else None
                ),
            }
        )

    return {
        "flow": snapshot.get("flow"),
        "at": snapshot.get("at"),
        "counts": counts,
        "tasks": summarized,
    }


def volatile_by_dataset(tasks: Sequence[Any]) -> dict[str, list[str]]:
    """Every declared volatile column list, keyed by dataset URN.

    Built from the whole board rather than from one task because a READER has to
    hash an input the same way its producer did, and the reader has no idea which
    task wrote it. Looking the list up by dataset answers that without the reader
    needing to resolve a producer at all.

    Two writers of one table declaring different lists is refused at
    registration, so a conflict here means the board is in a state obsel's own
    door should have prevented. Raised rather than resolved: silently picking one
    would have the two sides hash the table differently, which reads as an
    unreported change and blames nobody.
    """
    lists: dict[str, list[str]] = {}
    for record in tasks:
        if not isinstance(record, dict):
            continue
        declared = record.get("volatile")
        if not isinstance(declared, dict):
            continue
        for dataset, columns in declared.items():
            if not isinstance(columns, list):
                continue
            new = sorted(str(column) for column in columns)
            seen = lists.get(dataset)
            if seen is not None and seen != new:
                raise ObselReplyError(
                    f"two tasks declare different volatile columns for {dataset} "
                    f"({seen} and {new}). obsel refuses this at registration, so a board "
                    "carrying both is inconsistent; hashing it either way would make one "
                    "side's reads look like a change nobody reported."
                )
            lists[dataset] = new
    return lists


def rerun_summary(swarm: Any) -> dict[str, Any]:
    """The repair order obsel derived, trimmed for an agent to act on.

    obsel computes this; nothing here decides it. The server sends `rerun` on
    the swarm envelope, and this projects it: short table names instead of URNs,
    and the URN kept because that is what `announce_start` takes.

    An older obsel that predates the field sends nothing, which reads here as an
    empty plan rather than an error. That is honest -- no plan was offered -- and
    it keeps the tool usable against a server the agent did not start.

    **A row in this plan is not permission to skip anything.** It says what to
    redo first so a redo is not wasted; it says nothing about whether any task is
    sound, and finishing a task still means reporting it like any other run.
    """
    plan = swarm.get("rerun") if isinstance(swarm, dict) else None
    if not isinstance(plan, dict):
        return {"waves": [], "startableNow": [], "cyclic": [], "flagged": 0}

    def row(entry: Any) -> dict[str, Any]:
        return {
            "taskUrn": entry.get("urn"),
            "name": entry.get("name"),
            "title": entry.get("title"),
            "reads": short_names(entry.get("reads") or []),
            "writes": short_names(entry.get("writes") or []),
            "causedBy": (
                dataset_short_name(entry["causedBy"])
                if isinstance(entry.get("causedBy"), str)
                else None
            ),
        }

    waves = [
        [row(entry) for entry in wave if isinstance(entry, dict)]
        for wave in (plan.get("waves") or [])
        if isinstance(wave, list)
    ]
    cyclic = [row(entry) for entry in (plan.get("cyclic") or []) if isinstance(entry, dict)]
    return {
        "waves": waves,
        "startableNow": list(plan.get("startableNow") or []),
        "cyclic": cyclic,
        "flagged": sum(len(wave) for wave in waves) + len(cyclic),
    }


# --------------------------------------------------------------------------
# Self-check
# --------------------------------------------------------------------------


def _self_check() -> int:
    """Prove the refusals, because every one of them fails silently if it is wrong.

    Run directly: `python3 -m agents.mcp_core`
    """
    failures: list[str] = []

    def check(name: str, condition: bool, detail: str) -> None:
        print(f"  {'pass' if condition else 'FAIL'}  {name}: {detail}")
        if not condition:
            failures.append(name)

    def raises(error: type[BaseException], call: Any) -> str:
        try:
            call()
        except error as caught:
            return str(caught)
        except BaseException as caught:  # noqa: BLE001 -- the wrong type is the failure
            return f"WRONG TYPE {type(caught).__name__}: {caught}"
        return ""

    dataset = "urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.clean_orders,PROD)"
    revenue = "urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.daily_revenue,PROD)"
    clean_task = {
        "urn": "urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),clean)",
        "name": "clean",
        "status": "complete",
        "reads": ["urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.raw_orders,PROD)"],
        "writes": [dataset],
        "stale": None,
    }

    print("reading obsel's replies")

    missing = raises(ObselReplyError, lambda: required_list({"changedOutputs": []}, "affected", "x"))
    check(
        "a missing key is refused, not read as empty",
        "'affected'" in missing and "changedOutputs" in missing,
        "the error names the key that is absent and the keys that arrived",
    )
    check(
        "an empty list is an answer, not an absence",
        required_list({"affected": []}, "affected", "x") == [],
        "an identical re-run legitimately affects nothing",
    )
    check(
        "a null is refused rather than coerced",
        raises(ObselReplyError, lambda: required_list({"affected": None}, "affected", "x")) != "",
        "None is not an empty list",
    )
    check(
        "a non-object reply is refused",
        raises(ObselReplyError, lambda: required_list("nope", "affected", "x")) != "",
        "a string reply cannot be indexed into a pass",
    )
    check(
        "a dict where a list belongs is refused by type",
        "not a list" in raises(ObselReplyError, lambda: required_list({"affected": {}}, "affected", "x")),
        "the shape is checked, not just the presence",
    )

    print()
    print("urns in, short names out")

    check(
        "a dataset urn parses to its table name",
        dataset_short_name(dataset) == "clean_orders",
        f"{dataset} -> clean_orders",
    )
    check(
        "a task urn parsed as a dataset yields a plausible wrong answer",
        dataset_short_name(clean_task["urn"]) == "orders_pipeline",
        "the nested dataFlow's commas are not table separators, so this returns the "
        "flow name and raises nothing -- pinned because a wrong answer that looks "
        "right is why only dataset urns are ever passed here",
    )

    print()
    print("registration")

    check(
        "a plain table name and a namespaced one both pass",
        registration_problem("build_revenue", ["clean_orders"], ["daily_revenue"]) is None
        and registration_problem("clean_trips", ["obsel_taxi.raw_trips"], ["obsel_taxi.clean_trips"])
        is None,
        "the scale swarm registers qualified names and obsel passes them through",
    )
    check(
        "a comma in a table name is refused",
        (dataset_name_problem("clean_orders,PROD") or "").startswith("dataset name"),
        "it would build a urn whose readers recover 'clean_orders' and lose the rest",
    )
    check(
        "a second dot is refused",
        dataset_name_problem("a.b.c") is not None and dataset_name_problem("a.b") is None,
        "readers take the LAST dot-separated segment, so 'a.b.c' comes back as 'c'",
    )
    check(
        "a urn sent where a short name belongs is refused, and told why",
        "SHORT names" in (dataset_name_problem(dataset) or ""),
        "obsel would qualify it into obsel_demo.urn:li:dataset:(...), a different entity",
    )
    check(
        "an empty name is refused",
        task_name_problem("") is not None and dataset_name_problem("") is not None,
        "the URN would carry an empty segment rather than fail",
    )
    check(
        "a trailing newline is refused, the way the TypeScript door refuses it",
        task_name_problem("clean_orders\n") is not None
        and dataset_name_problem("clean_orders\n") is not None,
        "Python's `$` also matches before a final newline and JavaScript's does not",
    )
    check(
        "the message names the offending value and the shape wanted",
        "'Clean Orders'" in (dataset_name_problem("Clean Orders") or "")
        and "underscores" in (dataset_name_problem("Clean Orders") or ""),
        "a model fixing this needs the value it sent and the rule, not 'invalid name'",
    )
    check(
        "one bad name is reported, not five",
        registration_problem("ok_task", ["a,b", "c.d.e"], ["f g"]) == dataset_name_problem("a,b"),
        "a model fixes one name and calls again; a list of reasons for one typo reads as five faults",
    )

    check(
        "identical lineage in a different order still matches",
        lineage_matches(clean_task, ["raw_orders"], ["clean_orders"]),
        "the record holds urns and the agent passes short names",
    )
    check(
        "different lineage does not match",
        not lineage_matches(clean_task, ["raw_orders", "extra"], ["clean_orders"]),
        "a genuine redeclaration must not be mistaken for a repeat",
    )

    print()
    print("freshness")

    board = [
        clean_task,
        {
            "urn": "urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),revenue)",
            "name": "revenue",
            "status": "stale",
            "reads": [dataset],
            "writes": [revenue],
            "stale": {"reason": "clean_orders changed its columns", "hops": 1, "since": "2026-07-23T00:00:00Z"},
        },
    ]

    answer = freshness_verdicts(board, ["clean_orders", "daily_revenue", "raw_orders"])
    by_table = {verdict["table"]: verdict for verdict in answer["verdicts"]}

    check(
        "a finished producer reads fresh",
        by_table["clean_orders"]["status"] == "fresh",
        "clean is complete and unmarked",
    )
    check(
        "a marked producer reads stale and carries its reason",
        by_table["daily_revenue"]["status"] == "stale"
        and by_table["daily_revenue"]["stale"]["reason"] == "clean_orders changed its columns",
        "the mark is passed through untouched, not summarized",
    )
    check(
        "a table nothing produces is not called fresh",
        by_table["raw_orders"]["status"] == "no-registered-producer",
        "a seed table and a typo look the same from here; neither is a claim of freshness",
    )
    check(
        "the problem lists name the tables",
        answer["staleInputs"] == ["daily_revenue"] and answer["inFlightInputs"] == [],
        "an agent can say which input blocked it",
    )

    running = [{**clean_task, "status": "running"}]
    check(
        "a producer mid-run reads in-flight, not stale",
        freshness_verdicts(running, ["clean_orders"])["verdicts"][0]["status"] == "in-flight",
        "work in flight will pick up its own inputs; calling it stale is a false positive",
    )
    registered = [{**clean_task, "status": "registered"}]
    check(
        "a producer that has never finished reads not-yet-produced",
        freshness_verdicts(registered, ["clean_orders"])["verdicts"][0]["status"] == "not-yet-produced",
        "there is nothing on the other side of that name yet",
    )
    two_producers = [clean_task, {**clean_task, "name": "clean_again", "status": "stale",
                                 "stale": {"reason": "upstream moved", "hops": 1, "since": "2026-07-23T00:00:00Z"}}]
    check(
        "two producers take the worst verdict",
        freshness_verdicts(two_producers, ["clean_orders"])["verdicts"][0]["status"] == "stale",
        "one stale producer is enough for the answer to be no",
    )

    print()
    print("completion")

    good = {"clean_orders": {"columns": ["order_id", "order_total"], "rows": [{"order_id": 1, "order_total": 217}]}}
    body, prints = completion_body(clean_task, good, "2026-07-23T00:00:00Z")
    check(
        "fingerprints are keyed by the urn the task declared",
        list(prints) == [dataset],
        "the agent passed a short name and obsel is told a urn",
    )
    check(
        "the shape is sent even with no runner and no duration",
        body["run"]["outputs"][dataset]["columns"] == ["order_id", "order_total"],
        "obsel diffs these columns to name what moved; losing them coarsens every mark",
    )
    check(
        "and the unmeasured halves are null rather than invented",
        body["run"]["runner"] is None and body["run"]["ms"] is None,
        "a person typing a table at the bench ran nothing there is a duration for",
    )
    with_run, _ = completion_body(clean_task, good, "2026-07-23T00:00:00Z", runner="claude-code", ms=1234.6)
    check(
        "a complete run detail is sent and its ms is rounded",
        with_run["run"]["runner"] == "claude-code" and with_run["run"]["ms"] == 1235,
        "obsel's schema takes an integer millisecond count",
    )
    check(
        "no client key at all when the handshake said nothing",
        "client" not in body,
        "a null name recorded as though somebody sent it would be obsel inventing an identity",
    )
    named, _ = completion_body(
        clean_task,
        good,
        "2026-07-23T00:00:00Z",
        client={"name": "claude-code", "version": "2.1", "at": "2026-07-23T00:00:00Z"},
    )
    check(
        "the connecting client is sent beside the run, not inside it",
        named["client"] == {"name": "claude-code", "version": "2.1", "at": "2026-07-23T00:00:00Z"}
        and named["run"]["runner"] is None,
        "what spoke MCP and what did the work are two facts, and neither fills the other in",
    )
    check(
        "the run detail carries the shape that was actually hashed",
        with_run["run"]["outputs"][dataset] == {"rows": 1, "columns": ["order_id", "order_total"]},
        "the board shows what came out, from the same table the fingerprint came from",
    )

    float_form = {"clean_orders": {"columns": ["order_id", "order_total"], "rows": [{"order_id": 1, "order_total": 217.0}]}}
    _, float_prints = completion_body(clean_task, float_form, "2026-07-23T00:00:00Z")
    check(
        "217 and 217.0 reach one fingerprint",
        float_prints[dataset] == prints[dataset],
        "the same value written two ways is not a change; measured on a live run, "
        "and without this every re-run screams",
    )
    moved = {"clean_orders": {"columns": ["order_id", "order_total"], "rows": [{"order_id": 1, "order_total": 218}]}}
    _, moved_prints = completion_body(clean_task, moved, "2026-07-23T00:00:00Z")
    check(
        "a real change still moves the fingerprint",
        moved_prints[dataset]["content"] != prints[dataset]["content"],
        "canonicalizing must not flatten a genuine difference",
    )

    undeclared = raises(
        ToolInputError,
        lambda: completion_body(clean_task, {"invented_table": good["clean_orders"]}, "2026-07-23T00:00:00Z"),
    )
    check(
        "an undeclared output is refused, naming what was declared",
        "clean_orders" in undeclared and "invented_table" in undeclared,
        "obsel would accept the fingerprint and record it against lineage that does "
        "not exist, so the change could never cascade",
    )
    check(
        "reporting no outputs at all is refused",
        raises(ToolInputError, lambda: completion_body(clean_task, {}, "2026-07-23T00:00:00Z")) != "",
        "there is no fingerprint to compare, so there is nothing to report",
    )
    check(
        "a table with no columns is refused",
        raises(
            ToolInputError,
            lambda: completion_body(clean_task, {"clean_orders": {"columns": [], "rows": []}}, "2026-07-23T00:00:00Z"),
        ) != "",
        "rows are hashed by declared column, so an empty contract hashes nothing",
    )
    empty_rows, _ = completion_body(
        clean_task, {"clean_orders": {"columns": ["order_id"], "rows": []}}, "2026-07-23T00:00:00Z"
    )
    check(
        "a table with columns and no rows is accepted",
        dataset in empty_rows["fingerprints"],
        "an empty result is a real result, and a filter that removed everything is real work",
    )

    print()
    print("tables reported as paths to real files")

    # Real files in a real temporary directory, per the repo's rule: the missing
    # file is a path nothing wrote, the bad JSON is real bad JSON on disk.
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        table_file = tmp_dir / "clean_orders.json"
        table_file.write_text(json.dumps(good["clean_orders"]), encoding="utf-8")

        _, path_prints = completion_body(
            clean_task, {"clean_orders": {"path": str(table_file)}}, "2026-07-23T00:00:00Z"
        )
        check(
            "a path and the same table inline reach one fingerprint",
            path_prints[dataset] == prints[dataset],
            "the file form must not be a second definition of what was produced",
        )

        missing = raises(
            ToolInputError,
            lambda: completion_body(
                clean_task, {"clean_orders": {"path": str(tmp_dir / "never_written.json")}}, "t"
            ),
        )
        check(
            "a path with no file behind it is refused, naming path and working directory",
            "never_written.json" in missing and "working directory" in missing,
            "the agent chose the path, so the error must hand it what to fix",
        )

        bad_json = tmp_dir / "broken.json"
        bad_json.write_text("{not json", encoding="utf-8")
        check(
            "a file that is not JSON is refused as the agent's problem, not a crash",
            "not valid JSON"
            in raises(
                ToolInputError,
                lambda: completion_body(clean_task, {"clean_orders": {"path": str(bad_json)}}, "t"),
            ),
            "json.JSONDecodeError becomes a ToolInputError that names the file",
        )

        not_a_table = tmp_dir / "shape.json"
        not_a_table.write_text('{"nope": true}', encoding="utf-8")
        check(
            "a JSON file that is not a table is refused by shape",
            "columns"
            in raises(
                ToolInputError,
                lambda: completion_body(clean_task, {"clean_orders": {"path": str(not_a_table)}}, "t"),
            ),
            "the same shape rule as an inline table, so the two forms cannot drift",
        )

        check(
            "a value with both a path and inline keys is refused as ambiguous",
            "both"
            in raises(
                ToolInputError,
                lambda: completion_body(
                    clean_task,
                    {"clean_orders": {"path": str(table_file), "rows": []}},
                    "t",
                ),
            ),
            "hashing one and silently ignoring the other would hide a disagreement",
        )

        print()
        print("what the task read, alongside what it wrote")

        raw_file = tmp_dir / "raw_orders.json"
        raw_file.write_text(
            json.dumps({"columns": ["order_id"], "rows": [{"order_id": 1}]}), encoding="utf-8"
        )
        raw_urn = "urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.raw_orders,PROD)"

        with_inputs, _ = completion_body(
            clean_task, good, "2026-07-23T00:00:00Z", inputs={"raw_orders": {"path": str(raw_file)}}
        )
        observation = with_inputs["inputs"][raw_urn]
        check(
            "an observation carries both hashes and the columns, keyed by urn",
            set(observation) == {"schema", "content", "columns"}
            and observation["columns"] == ["order_id"],
            "the engine compares the hashes and the columns let a mismatch name what moved",
        )
        check(
            "a table this task never declared it reads is refused",
            "did not declare that it reads"
            in raises(
                ToolInputError,
                lambda: completion_body(
                    clean_task, good, "t", inputs={"clean_orders": good["clean_orders"]}
                ),
            ),
            "an observation filed against absent lineage is evidence nothing will ever find",
        )
        check(
            "a report without inputs sends none",
            "inputs" not in body,
            "optional means absent, not an empty object that implies an empty read",
        )

    print()
    print("reading the answer back")

    quiet = summarise_coordination(
        {"changedOutputs": [], "affected": [], "restored": [], "elapsedMs": 89}
    )
    check(
        "an identical re-run summarizes as nothing marked",
        quiet == ["no outputs changed; nothing was marked stale (89 ms)"],
        "the quiet case is the one that makes the loud case trustworthy",
    )
    loud = summarise_coordination(
        {
            "changedOutputs": [{"dataset": dataset, "kind": "schema"}],
            "affected": [
                {"task": {"name": "revenue"}, "mark": {"hops": 1, "reason": "clean_orders changed its columns"}},
                {"task": {"name": "docs"}, "mark": {"hops": 2, "reason": "daily_revenue changed"}},
            ],
            "restored": [],
            "elapsedMs": 213,
        }
    )
    check(
        "a cascade summarizes with each mark's own reason",
        loud[0] == "changed clean_orders (schema)"
        and "marked 2 finished task(s) stale in 213 ms" in loud[1]
        and "revenue (1 hop):" in loud[2]
        and "docs (2 hops):" in loud[3],
        "singular and plural hops, and the reason obsel recorded rather than a paraphrase",
    )
    check(
        "a reply missing affected is an error, not a quiet pass",
        raises(ObselReplyError, lambda: summarise_coordination({"changedOutputs": []})) != "",
        "this is the exact shape that would otherwise read as 'nothing was affected'",
    )
    redone = summarise_coordination(
        {
            "changedOutputs": [],
            "affected": [],
            "restored": [
                {"task": {"name": "docs"}, "reason": "revenue redid daily revenue and it came out identical"}
            ],
            "elapsedMs": 60,
        }
    )
    check(
        "an identical redo of flagged work summarizes the clears it earned",
        redone[0] == "no outputs changed; nothing was marked stale (60 ms)"
        and redone[1] == "cleared docs without a re-run: revenue redid daily revenue and it came out identical",
        "the quiet half and the loud half of the same event, in that order",
    )
    check(
        "a reply missing restored is an error, not a quiet pass",
        raises(
            ObselReplyError,
            lambda: summarise_coordination({"changedOutputs": [], "affected": []}),
        )
        != "",
        "reading a lost key as 'nothing was cleared' would hide work that flipped back to sound",
    )

    print()
    print("the board")

    summary = board_summary({"snapshot": {"flow": "urn:li:dataFlow:(obsel,orders_pipeline,prod)", "at": "now", "tasks": board}})
    check(
        "the board counts each status",
        summary["counts"] == {"registered": 0, "running": 0, "complete": 1, "stale": 1},
        "orientation, not decision: check_freshness is what an agent acts on",
    )
    check(
        "the board reports short table names and no fingerprints",
        summary["tasks"][0]["writes"] == ["clean_orders"] and "fingerprints" not in summary["tasks"][0],
        "a hash tells a reading agent nothing it can act on",
    )

    print()
    print("volatile columns, and who decides them")

    board = [
        {
            "urn": "urn:li:dataJob:(f,cleaner)",
            "volatile": {"urn:li:dataset:(p,t,PROD)": ["loaded_at", "batch_id"]},
        },
        {"urn": "urn:li:dataJob:(f,reader)"},
    ]
    check(
        "the lists are keyed by dataset, so a reader needs no producer lookup",
        volatile_by_dataset(board) == {"urn:li:dataset:(p,t,PROD)": ["batch_id", "loaded_at"]},
        "a reader hashes an input without knowing which task wrote it",
    )
    check(
        "a board declaring none reads as none",
        volatile_by_dataset([{"urn": "x"}]) == {},
        "almost every task declares nothing, and that is not an error",
    )
    conflicting = [
        {"urn": "a", "volatile": {"d": ["x"]}},
        {"urn": "b", "volatile": {"d": ["y"]}},
    ]
    check(
        "two writers disagreeing about one table is refused, not resolved",
        raises(ObselReplyError, lambda: volatile_by_dataset(conflicting)),
        "picking one would have producer and reader hash the same table differently",
    )

    print()
    print("the repair order, as an agent reads it")

    def _demo_urn(table: str) -> str:
        return f"urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.{table},PROD)"

    plan_swarm = {
        "snapshot": {"flow": "f", "at": "now", "tasks": []},
        "rerun": {
            "waves": [
                [
                    {
                        "urn": "urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),build_revenue)",
                        "name": "build_revenue",
                        "title": "Daily revenue",
                        "reads": [_demo_urn("clean_orders")],
                        "writes": [_demo_urn("daily_revenue")],
                        "causedBy": _demo_urn("clean_orders"),
                    }
                ],
                [
                    {
                        "urn": "urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),write_report)",
                        "name": "write_report",
                        "title": "Revenue report",
                        "reads": [_demo_urn("daily_revenue")],
                        "writes": [_demo_urn("revenue_report")],
                        "causedBy": _demo_urn("clean_orders"),
                    }
                ],
            ],
            "startableNow": [
                "urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),build_revenue)"
            ],
            "cyclic": [],
        },
    }
    plan = rerun_summary(plan_swarm)
    check(
        "the waves keep the order obsel derived",
        [[row["name"] for row in wave] for wave in plan["waves"]]
        == [["build_revenue"], ["write_report"]],
        "redoing the reader first rebuilds it from an input about to change",
    )
    check(
        "rows carry short names and the task urn",
        plan["waves"][0][0]["reads"] == ["clean_orders"]
        and plan["waves"][0][0]["causedBy"] == "clean_orders"
        and plan["waves"][0][0]["taskUrn"].endswith("build_revenue)"),
        "short names to read, the urn because announce_start takes it",
    )
    check(
        "the flagged total counts every row, cyclic included",
        plan["flagged"] == 2,
        "a count that skipped the cycle would understate the work left",
    )
    check(
        "a swarm with no plan reads as no work, not as an error",
        rerun_summary({"snapshot": {"tasks": []}}) == {
            "waves": [],
            "startableNow": [],
            "cyclic": [],
            "flagged": 0,
        },
        "an older obsel sends no plan, and that is not a failure to report",
    )

    print()
    if failures:
        print(f"FAILED: {', '.join(failures)}")
        return 1
    print("all checks hold")
    return 0


if __name__ == "__main__":
    raise SystemExit(_self_check())
