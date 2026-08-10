"""Turning an erasure coverage report into work an agent can actually do.

Its own module, and it must stay that way: the staleness half of `mcp_core.py`
defaults to "nothing is wrong" where there is no recorded claim, which is right
there and would be a certificate of erasure here. Nothing in this file may
import that default.

**Nothing here marks an asset covered.** There is no function, argument or
return value that can, and the self-check below asserts it. What closes a gap is
the lookup table `_STEP_FOR` and nothing else: the mapping is fixed, and a model
choosing an action per row would produce variation where the answer does not
vary.
"""

from __future__ import annotations

from typing import Any, Sequence

from agents.mcp_core import dataset_short_name, required_dict, required_list


#: What would close each kind of gap. Keyed by the residue reason obsel reports.
#:
#: This is the whole of the agent's usefulness on an erasure board and it is a
#: lookup table on purpose. Deciding what closes a gap is a fact about the rule
#: in `erasure.ts`, not a judgement, so a model choosing an action per row would
#: be inventing variation where the correct answer is fixed. What the model is
#: for is everything around it: which owner to ask, how to phrase it, when to
#: give up and say so.
_NEXT_STEP: dict[str, tuple[str, str]] = {
    "no-attestation": (
        "direct-check",
        "nobody has looked. Ask this asset's owner for a direct absence check "
        "against the version standing now.",
    ),
    "attested-other-version": (
        "direct-check",
        "somebody looked, and the asset has been written since. The earlier "
        "attestation still stands for the version it named; this version needs "
        "its own.",
    ),
    "unattested-input": (
        "upstream-first",
        "this was built from something that is itself unattested. Close the "
        "upstream first; this asset may follow without anyone querying it.",
    ),
    "not-total": (
        "physical-deletion",
        "the run that wrote it did not rewrite the whole table, so a rebuild "
        "cannot account for what it left behind. This needs a direct check or "
        "physical deletion.",
    ),
    "partitions-uncovered": (
        "direct-check",
        "part of the table is covered and the rest is not. The uncovered "
        "partitions are the work.",
    ),
    "not-sole-producer": (
        "direct-check",
        "more than one run contributed to this version, so no single rebuild "
        "explains all of it. A direct check is the only route.",
    ),
    "no-recorded-lineage": (
        "catalog-gap",
        "DataHub records no upstream lineage here, so a rebuild claim has "
        "nothing to be checked against. This is a cataloguing gap before it is "
        "an erasure gap.",
    ),
    "closure-mismatch": (
        "redeclare-inputs",
        "the rebuild left out an input DataHub records as feeding this asset. "
        "Either the declaration is wrong or the lineage is.",
    ),
    "predicate-gap": (
        "direct-check",
        "the attestation searched for fewer identifiers than the request "
        "covers, so part of the question is unanswered.",
    ),
    "predicate-split": (
        "direct-check",
        "the identifiers were searched for, but across separate attestations "
        "and never all of them by one. Ask for a single check covering all of "
        "them over the whole version.",
    ),
    "unverified-signature": (
        "attestor-setup",
        "an attestation arrived that obsel could not verify. Check the key is "
        "registered and the signature is over the record as sent.",
    ),
}

#: The order work is offered in. Gaps that unblock other gaps come first, then
#: the ones an owner can act on today, then the ones that need someone else.
_PRIORITY = {
    "upstream-first": 0,
    "direct-check": 1,
    "redeclare-inputs": 2,
    "attestor-setup": 3,
    "physical-deletion": 4,
    "catalog-gap": 5,
    "unknown": 6,
}


def next_step_for(residue: Sequence[Any]) -> tuple[str, str]:
    """What would close this asset's gap, and why, from its residue.

    The first reason wins. `erasure.ts` orders residue with the most
    fundamental problem first, and an asset with three problems is closed by
    fixing the first one, not by being told about all three at once.
    """
    for reason in residue:
        if isinstance(reason, dict):
            found = _NEXT_STEP.get(str(reason.get("kind")))
            if found:
                return found
    return ("unknown", "obsel reports no reason obsel knows how to act on.")


def open_obligations(report: Any, scope: Sequence[str] | None = None) -> dict[str, Any]:
    """The assets nobody has spoken for, as work rather than as a list.

    Every unattested row comes back with a named next step, sorted so the
    gaps that unblock other gaps are offered first. `scope`, when given, is the
    set of URN prefixes the calling agent can actually act on, and rows outside
    it are still returned but marked, because an agent that silently dropped
    everything it could not do would report a smaller problem than exists.

    **This tool cannot mark anything covered.** It reads. Coverage changes only
    when a signed attestation obsel verified arrives, and there is deliberately
    no tool, route or argument anywhere that takes an asset and calls it done.
    """
    coverage = required_list(report, "coverage", "an erasure report")
    summary = required_dict(report, "summary", "an erasure report")

    open_rows: list[dict[str, Any]] = []
    for row in coverage:
        if not isinstance(row, dict):
            continue
        state = row.get("state")
        if state == "ATTESTED":
            continue
        asset = str(row.get("asset") or "")
        action, why = next_step_for(row.get("residue") or [])
        open_rows.append(
            {
                "asset": asset,
                "table": dataset_short_name(asset) if asset else "",
                "version": row.get("version"),
                "state": state,
                "action": action,
                "why": why,
                "obselSays": row.get("explanation"),
                "inScope": _in_scope(scope, asset),
            }
        )

    open_rows.sort(key=lambda row: (_PRIORITY.get(row["action"], 9), row["asset"]))

    return {
        "request": (report or {}).get("request", {}).get("request")
        if isinstance(report, dict)
        else None,
        # Stated as a count against a total, never as a percentage on its own.
        # "96% covered" invites a reader to round up to done, and the remainder
        # is the entire reason the report exists.
        "covered": summary.get("attested"),
        "unattested": summary.get("unproven"),
        "contradicted": summary.get("contradicted"),
        "total": summary.get("total"),
        "obligations": open_rows,
        "actionable": sum(1 for row in open_rows if row["inScope"]),
    }


def _in_scope(scope: Sequence[str] | None, asset: str) -> bool:
    if scope is None:
        return True
    return any(
        asset.startswith(entry[:-1]) if entry.endswith("*") else asset == entry for entry in scope
    )


# --------------------------------------------------------------------------
# Self-check
# --------------------------------------------------------------------------


def _self_check() -> int:
    """Prove the refusals, because every one of them fails silently if it is wrong.

    Run directly: `python3 -m agents.mcp_erasure`
    """
    failures: list[str] = []

    def check(name: str, condition: bool, detail: str) -> None:
        print(f"  {'pass' if condition else 'FAIL'}  {name}: {detail}")
        if not condition:
            failures.append(name)

    print("erasure coverage as work")
    print()
    print("erasure coverage as work")

    def row(asset: str, state: str, residue: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "asset": f"urn:li:dataset:(urn:li:dataPlatform:snowflake,db.sch.{asset},PROD)",
            "state": state,
            "version": "v1",
            "residue": residue,
            "explanation": f"{asset} is unattested",
        }

    report = {
        "request": {"request": "dsr-1"},
        "summary": {"total": 5, "attested": 1, "unproven": 4, "contradicted": 0},
        "coverage": [
            row("covered", "ATTESTED", []),
            row("no_lineage", "UNPROVEN", [{"kind": "no-recorded-lineage"}]),
            row("derived", "UNPROVEN", [{"kind": "unattested-input", "input": "x"}]),
            row("untouched", "UNPROVEN", [{"kind": "no-attestation"}]),
            row("merged", "UNPROVEN", [{"kind": "not-total", "materialization": "merge"}]),
        ],
    }

    work = open_obligations(report)
    check(
        "an attested asset is not offered as work",
        all(item["table"] != "covered" for item in work["obligations"]),
        "the board's whole value is the list of what is NOT covered",
    )
    check(
        "an unattested upstream is offered before the assets built on it",
        work["obligations"][0]["table"] == "derived",
        "closing the upstream may close the downstream without anyone querying it",
    )
    check(
        "a cataloguing gap sorts last, because it is somebody else's job first",
        work["obligations"][-1]["table"] == "no_lineage",
        "an owner cannot answer a question about lineage DataHub never recorded",
    )
    check(
        "a merge is never offered as a rebuild",
        next_step_for([{"kind": "not-total"}])[0] == "physical-deletion",
        "a run that did not rewrite the whole table cannot account for what it left",
    )
    check(
        "a reason obsel does not name is refused rather than guessed at",
        next_step_for([{"kind": "something-new"}])[0] == "unknown",
        "inventing an action for an unknown gap is how an agent sends someone the wrong way",
    )
    check(
        "counts are reported against a total, never as a bare percentage",
        work["covered"] == 1 and work["total"] == 5 and work["unattested"] == 4,
        "'96% covered' invites a reader to round up to done, and the remainder is the point",
    )
    check(
        "out-of-scope work is marked, not dropped",
        len(open_obligations(report, scope=["urn:li:dataset:(urn:li:dataPlatform:looker,*"])["obligations"]) == 4,
        "an agent that hid what it could not do would report a smaller problem than exists",
    )
    check(
        "and the actionable count reflects the scope",
        open_obligations(report, scope=["urn:li:dataset:(urn:li:dataPlatform:looker,*"])["actionable"] == 0,
        "nothing here is on a platform this agent can reach",
    )
    check(
        "no function here returns anything that marks an asset covered",
        "ATTESTED" not in str(work),
        "a tool that could declare work done is a tool for silencing the one thing obsel is for",
    )

    print()
    if failures:
        print(f"FAILED: {', '.join(failures)}")
        return 1
    print("all checks hold")
    return 0


if __name__ == "__main__":
    raise SystemExit(_self_check())
