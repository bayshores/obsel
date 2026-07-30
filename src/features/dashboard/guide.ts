/**
 * The guide: what a newcomer should understand and do next, derived entirely
 * from observed state.
 *
 * This is a lens, not a script. There is no stored "current step" anywhere —
 * every render recomputes the stage from what DataHub actually holds and what
 * the demo runner actually reports, so driving a step from the terminal
 * instead of the buttons, a step failing halfway, or a task changing under us
 * all land on the honest stage rather than desyncing a stored position.
 *
 * The shape of a view and the wording shared across stages are in
 * `guide-view.ts`; each stage's own copy is in `guide-stages.ts`.
 */

import { boardSawAChange } from "./fingerprints";
import { STEP_NAME, lastStepProblem } from "./guide-view";
import type { Blocker, GuideInput, GuideView, StageView } from "./guide-view";
import { connect, empty, flagged, prepare, registered, settled, working } from "./guide-stages";
import type { DemoActivity, DemoStep, StepResult } from "@/src/server/runner/types";

/**
 * The steps that end a walk and begin the next one.
 *
 * Only what ran **after** the last reset counts, which is what makes the walk
 * repeatable rather than a one-way trip: pressing reset puts every task back to
 * registered, and the rail has to agree with the board it is describing.
 */
const RESETS: readonly DemoStep[] = ["reset", "register", "scale-register"];

/**
 * The steps performed since this walk began, oldest first.
 *
 * Everything before the last reset belongs to a previous walk and is not this
 * one's evidence. Without this the rail would be complete forever after the
 * first full run, and pressing reset — which really does put every task back to
 * registered — would leave the rail describing a board that no longer exists.
 *
 * The boundary step is included, because registering is itself the first act.
 */
export function sinceReset(history: readonly StepResult[]): StepResult[] {
  let start = 0;
  history.forEach((result, index) => {
    if (result.exitCode === 0 && RESETS.includes(result.step)) start = index;
  });
  return history.slice(start);
}

/**
 * The steps that ran since this walk began and exited cleanly.
 *
 * Exit 0 is the step's own assertions passing. A step that failed did not
 * demonstrate its claim, so neither the rail nor the watch line may say it did.
 *
 * Shared by the rail and the watch line, because the two would otherwise answer
 * "has the unchanged re-run happened" from the same record by two routes, and a
 * board where the rail ticks `same again` while the line under the headline
 * talks about something else is worse than either alone.
 */
export function performedSteps(activity: DemoActivity | null): Set<DemoStep> {
  return new Set(
    sinceReset(activity?.history ?? [])
      .filter((result) => result.exitCode === 0)
      .map((result) => result.step),
  );
}

/**
 * The whole lens: which stage the board is in, and what to say about it.
 *
 * `walked` separates a settled board that has been all the way through the
 * demonstration from one nobody has touched. They are the same picture, and the
 * board offers "start over" only on the first.
 *
 * This asked the launcher's record of what ran here, and nothing else, until
 * 2026-07-27. That record lives in `globalThis` and `runner/types.ts` says
 * plainly that it does not survive a server restart. The board does: it is
 * DataHub's, and DataHub was still running. So quitting obsel and starting it
 * again took the reset button off an unchanged board, which is exactly the
 * complaint that found this ("I boot obsel back on and there is no option to
 * redo").
 *
 * The board can answer it after all. An output that moved is recorded on the
 * task, survives the restart because DataHub holds it, and is nulled by
 * `resetSwarm` so it reads false again afterwards. `fingerprints.ts` has the
 * four facts that make it the right question to ask.
 *
 * The launcher's record stays as a second route rather than being replaced. It
 * is the stronger evidence where it exists, because it says the repair step
 * itself ran rather than that something moved, and keeping it costs one clause.
 */
export function guide(input: GuideInput): GuideView {
  const performed = performedSteps(input.activity);
  const walked =
    boardSawAChange(input.tasks) || performed.has("repair") || performed.has("scale-repair");
  return stageOf(input, walked);
}

function stageOf(input: GuideInput, walked: boolean): StageView {
  const attention = lastStepProblem(input.activity);
  const running = input.activity?.running ?? null;

  // While a launched step is live, the buttons go away rather than grey out. The
  // launcher would refuse a second step anyway (they share the tables), and a
  // disabled button with no explanation is a puzzle, not guidance.
  const withActions = (view: StageView): StageView =>
    running === null
      ? view
      : {
          ...view,
          actions: [],
          subline: `${STEP_NAME[running.step]} is running now, and this page updates as it goes`,
        };

  if (!input.trusted) return connect(input, attention);

  const blockers = failedChecks(input);
  if (blockers.length > 0) return withActions(prepare(input, blockers));

  const tasks = input.tasks;
  if (tasks.some((task) => task.status === "running")) return working(input, attention);
  if (tasks.some((task) => task.stale !== null)) return withActions(flagged(tasks, attention));
  if (tasks.length === 0) return withActions(empty(attention));

  const finished = tasks.filter((task) => task.finishedAt !== null).length;
  if (finished === tasks.length) return withActions(settled(tasks, attention, walked));
  return withActions(
    registered(tasks, finished, attention, input.activity?.preflight.runner.name ?? null),
  );
}

/**
 * Prerequisite failures that would block the user's next move.
 *
 * DataHub itself is absent from this list: if it were down, the swarm read
 * would have failed and the guide would already be on `connect`. And when the
 * activity read itself failed there is nothing to report — unknown is not
 * broken, so the journey proceeds and the launcher still refuses honestly.
 */
function failedChecks(input: GuideInput): Blocker[] {
  const preflight = input.activity?.preflight;
  if (!preflight) return [];
  const blockers: Blocker[] = [];
  if (!preflight.venv.ok) blockers.push({ name: "venv", check: preflight.venv });
  if (!preflight.runner.ok) blockers.push({ name: "runner", check: preflight.runner });
  if (!preflight.vocabulary.ok) blockers.push({ name: "vocabulary", check: preflight.vocabulary });
  if (!preflight.uvx.ok) blockers.push({ name: "uvx", check: preflight.uvx });
  return blockers;
}

export { STEP_NAME } from "./guide-view";
export type { GuideInput, GuideView } from "./guide-view";
