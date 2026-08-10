/**
 * What a completion must carry before obsel records anything from it.
 *
 * Pure: a task record in, a sentence or `null` out. No network, no clock. The
 * check needs the finishing task's declared writes, which only the snapshot
 * holds, so it cannot live in the route's schema the way `register`'s
 * volatile-must-be-a-write check does. `decideCompletion` calls it as its first
 * act, before any write, and the route turns the sentence into a 400.
 *
 * Both refusals were already made one door over, by `resolve_outputs` in
 * `agents/mcp_core.py`, and neither was made here. The MCP door is not a gate
 * on this one: `agents/worker.py` and `agents/report.py` post to
 * `/api/tasks/complete` directly, and so can anything else holding the token.
 */

import type { OutputFingerprint, TaskRecord } from "./types";
import { taskLabel } from "./staleness";

/**
 * The sentence to refuse this completion with, or `null` to carry on.
 *
 * Two rules, and each one exists because breaking it produces a specific wrong
 * answer:
 *
 * **A completion carrying no fingerprint is a claim with no evidence.**
 * `recordCompletion` takes the reporter's own flag and its DataHub tag off
 * whenever the flagged task reports, and with an empty map there is nothing to
 * compare it against. That is a flag cleared by assertion rather than by redone
 * work, which `CLAUDE.md` forbids. Refused whatever the task declared. A task
 * registered with no writes is still flagged as a reader when an upstream
 * output moves, and `recordCompletion` still takes that flag off when it
 * reports, so the empty map clears it with nothing compared there too. The two
 * cases need different sentences, because the refusal for a task with no
 * declared writes has no dataset to name and cannot ask for the tables it
 * produced.
 *
 * **A fingerprint for an undeclared dataset is evidence about a table this task
 * has no `Produces` edge to.** It becomes obsel's baseline for that dataset,
 * and the next completion that moves it marks every finished reader stale and
 * names an author that wrote nothing.
 *
 * The comparison is over whole URNs, because that is the space
 * `decideCompletion` keys `finishing.fingerprints` in and the space every
 * caller sends: `register` builds the URNs from short names and hands them
 * back, and both `mcp_core.completion_body` and `agents/worker.py` key their
 * report off the record's own `writes`. Comparing short names would accept a
 * fingerprint of `finance.clean_orders` as evidence about
 * `obsel_demo.clean_orders`.
 *
 * The undeclared datasets are named as they arrived, in full, rather than
 * shortened. The whole failure is a URN the recorder would not have matched, so
 * a message that prints the short name would show the caller the spelling it
 * already believes it sent.
 */
export function evidenceProblem(
  finishing: TaskRecord,
  fingerprints: Record<string, OutputFingerprint>,
): string | null {
  const declared = finishing.writes;
  const reported = Object.keys(fingerprints);

  if (reported.length === 0) {
    if (declared.length === 0) {
      return (
        `${taskLabel(finishing)} is registered as writing nothing, and this completion ` +
        "carried no output fingerprint, so obsel has nothing to compare. Register the task " +
        "with the tables it writes and report those. If it really produces none, leave the " +
        "completion unreported: a stale flag comes off only through redone work."
      );
    }
    return (
      `${taskLabel(finishing)} declared that it writes ${declared.join(", ")}, and this ` +
      "completion carried no output fingerprint. Report the tables it produced. If it " +
      "genuinely produced nothing, do not report completion: there is nothing to compare, " +
      "and a stale flag comes off only through redone work."
    );
  }

  const undeclared = reported.filter((dataset) => !declared.includes(dataset)).sort();
  if (undeclared.length > 0) {
    return (
      `${taskLabel(finishing)} did not declare that it writes ${undeclared.join(", ")}. ` +
      `It declared: ${declared.join(", ") || "nothing"}. Register the task with the tables ` +
      "it really writes, or fix the spelling."
    );
  }

  return null;
}

/**
 * A completion obsel read and would not act on, as opposed to a body it could
 * not parse or work it attempted and could not finish.
 *
 * Its own class so the route can answer 400 for it and keep answering 500 for
 * everything else `coordinateCompletion` throws. A refusal reported as a 500
 * reads to the caller as obsel being broken, and the fix it needs is in the
 * caller's report.
 */
export class UnevidencedCompletion extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnevidencedCompletion";
  }
}
