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
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from agents.fingerprint import fingerprint
from agents.worker import canonicalise_numbers

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

    Refuses a table this task never declared it writes. obsel would accept the
    fingerprint -- the completion route takes whatever URN map it is given -- and
    record evidence about a dataset with no `Produces` edge to this task, so a real
    change to it could never reach anything downstream. The failure would be
    silent and permanent, which is why it is refused here rather than reported.
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
    """
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
        fingerprints[urn] = fingerprint(canonical["rows"], canonical["columns"])
        shapes[urn] = {"rows": len(canonical["rows"]), "columns": list(canonical["columns"])}
        if urn in paths:
            shapes[urn]["path"] = str(paths[urn])

    body: dict[str, Any] = {
        "taskUrn": record.get("urn"),
        "fingerprints": fingerprints,
        "finishedAt": finished_at,
    }
    if runner and ms is not None:
        body["run"] = {"runner": runner, "ms": round(float(ms)), "outputs": shapes}

    if inputs:
        observations: dict[str, dict[str, Any]] = {}
        for urn, table in resolve_inputs(record, inputs).items():
            canonical = canonicalise_numbers(table)
            observations[urn] = {
                **fingerprint(canonical["rows"], canonical["columns"]),
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
    # way: a lost key read as an empty list would summarise "nothing was
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
    summarised: list[dict[str, Any]] = []
    for record in tasks:
        if not isinstance(record, dict):
            continue
        status = record.get("status")
        if status in counts:
            counts[status] += 1
        mark = record.get("stale")
        summarised.append(
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
        "tasks": summarised,
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
        "the mark is passed through untouched, not summarised",
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
        "the run detail is omitted unless runner and ms both arrive",
        "run" not in body,
        "obsel's schema requires the whole object; half of one is refused at the route",
    )
    with_run, _ = completion_body(clean_task, good, "2026-07-23T00:00:00Z", runner="claude-code", ms=1234.6)
    check(
        "a complete run detail is sent and its ms is rounded",
        with_run["run"]["runner"] == "claude-code" and with_run["run"]["ms"] == 1235,
        "obsel's schema takes an integer millisecond count",
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
        "canonicalising must not flatten a genuine difference",
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
        "an identical re-run summarises as nothing marked",
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
        "a cascade summarises with each mark's own reason",
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
        "an identical redo of flagged work summarises the clears it earned",
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
    if failures:
        print(f"FAILED: {', '.join(failures)}")
        return 1
    print("all checks hold")
    return 0


if __name__ == "__main__":
    raise SystemExit(_self_check())
