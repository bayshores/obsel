/**
 * The forty-task taxi board, recorded off a real run.
 *
 * **These are not invented, and that is the whole point of the file.** Every
 * other fixture beside this one is hand-written: plausible shapes, made-up
 * digests, four tasks. That is fine for the states they cover, and it is stated
 * plainly in their headers. It stops being fine at forty, for two reasons.
 *
 * A hand-written forty-task graph is a hand-written claim about what dagre does
 * with a real pipeline's fan-out, and the layout is the thing these tests exist
 * to check. Whatever shape somebody typed out is the shape it would pass on.
 *
 * And forty tasks is where the board's guards stop being about copy and start
 * being about scale. A word comparison calibrated on an invented graph measures the
 * author's patience for typing node names.
 *
 * So these two files are `GET /api/swarm` verbatim, captured from the live
 * dashboard reading a live DataHub, on the flow `obsel_scale_v2`:
 *
 * - `scale-settled.json`, forty real Codex sessions finished, nothing marked.
 * - `scale-flagged.json`, the same board after one task re-ran and renamed a
 *   column, with the nine tasks obsel reached and the nine tags DataHub
 *   confirmed.
 *
 * Both are recorded in `docs/verification.md` with the run that produced them.
 * The fingerprints are real sha256 output over tables real agents wrote; the
 * `reason` on every mark is the sentence `staleness.ts` built at the time; the
 * hop numbers are the traversal's own.
 *
 * What recording them does NOT buy, stated as plainly as the cost is stated in
 * `mount.ts`: the server half is still absent from this suite. These files are
 * a snapshot of one true answer, replayed. That obsel would compute this answer
 * again is what `tests/live/` is for.
 */

import settled from "./captures/scale-settled.json";
import flagged from "./captures/scale-flagged.json";
import type { SwarmResponse } from "@/src/features/dashboard/hooks/use-swarm";

/**
 * Structural conformance for an imported JSON file.
 *
 * `resolveJsonModule` widens every literal in a capture to its base type, so a
 * capture cannot be assigned to `SwarmResponse` directly: `"complete"` arrives
 * as `string` and no union will take it. This relaxes exactly that, and nothing
 * else. Every required field must still be present, correctly nested, and of
 * the right kind, including the nullability of `stale`, `finishedAt`,
 * `startedAt` and `run` — delete one from a capture and `pnpm typecheck` fails.
 *
 * Copied from the recipe in `examples/README.md`, which exists for the same
 * reason and explains it at length.
 */
type JsonShape<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends null
        ? null
        : T extends readonly (infer E)[]
          ? JsonShape<E>[]
          : T extends object
            ? string extends keyof T
              ? { [K in keyof T]: JsonShape<T[K]> | undefined }
              : { [K in keyof T]: JsonShape<T[K]> }
            : T;

/*
 * The half the type check above cannot see.
 *
 * TypeScript reads `"status": "stale"` in a capture as `string`, so a capture
 * holding `"stalé"` or `"complet"` type-checks perfectly and renders as an
 * unknown status with no colour. Asserted here at import instead, over the real
 * bytes, so a bad capture fails the whole suite on its first line rather than
 * producing a board that is subtly wrong in a screenshot.
 *
 * Deliberately not a schema library. Three unions and a count is the entire
 * surface a capture can drift on, and a dependency to check three unions would
 * be more code to keep true than the check.
 */
const STATUSES = new Set(["registered", "running", "complete", "stale", "failed"]);
const KINDS = new Set(["schema", "content", "both"]);

function check(capture: JsonShape<SwarmResponse>, file: string, tasks: number): SwarmResponse {
  const problems: string[] = [];
  const seen = capture.snapshot.tasks;
  if (seen.length !== tasks) problems.push(`${seen.length} tasks, expected ${tasks}`);
  for (const task of seen) {
    if (!STATUSES.has(task.status)) problems.push(`${task.name}: status "${task.status}"`);
    const mark = task.stale;
    if (mark !== null && !KINDS.has(mark.changeKind)) {
      problems.push(`${task.name}: changeKind "${mark.changeKind}"`);
    }
    // A mark with no traceable cause is the one thing obsel must never store,
    // so a capture holding one is a capture of a bug, not a fixture.
    if (mark !== null && (mark.reason.length === 0 || mark.causedBy.length === 0)) {
      problems.push(`${task.name}: a mark with no reason or no cause`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`${file} is not a usable capture: ${problems.join("; ")}`);
  }
  return capture as SwarmResponse;
}

/** Forty agents finished, nothing out of date. */
export function scaleSettled(): SwarmResponse {
  return check(settled, "scale-settled.json", 40);
}

/**
 * The same forty after one renamed column, nine of them marked.
 *
 * One hop for the five tasks that read the renamed table, two for the four
 * built on those, three for the one at the end of the longest chain. Thirty
 * tasks stand outside it and none of them is flagged, which is the claim the
 * scale board exists to make and the one a four-task graph cannot show.
 */
export function scaleFlagged(): SwarmResponse {
  return check(flagged, "scale-flagged.json", 40);
}

/** The task names obsel marked in the flagged capture, in the order it walked. */
export function markedNames(): string[] {
  return scaleFlagged()
    .snapshot.tasks.filter((task) => task.stale !== null)
    .map((task) => task.name);
}
