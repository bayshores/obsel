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
 * House rule, same as the rest of the cockpit: no sentence here may claim a
 * fact the inputs do not carry. Counts are counted, marks quote their own
 * recorded reason, and a number that was not measured is omitted rather than
 * approximated.
 */

import { flowLine, taskTitle } from "./naming";
import { formatDuration, inFlightMs } from "./progress";
import type { DemoStep, DemoActivity } from "@/src/server/runner/types";
import type { TaskRecord } from "@/src/server/coordinator/types";

/** Where the journey stands. Derived, never stored. */
export type GuideStage =
  /** obsel cannot read the swarm, so nothing else can be said. */
  | "connect"
  /** Connected, but a machine prerequisite fails and would block the next move. */
  | "prepare"
  /** Connected and the swarm is empty: nothing has been registered yet. */
  | "empty"
  /** Tasks are declared and idle; not everything has finished. */
  | "registered"
  /** At least one agent is working right now. */
  | "working"
  /** Everything finished and nothing is marked: the interesting part starts here. */
  | "settled"
  /** Finished work is marked as built on something that changed. */
  | "flagged";

/** A real action: one button, one launched demo step, nothing canned. */
export interface GuideAction {
  step: DemoStep;
  label: string;
  /** What genuinely happens when pressed, one sentence. */
  detail: string;
}

export interface GuideView {
  stage: GuideStage;
  headline: string;
  /** Short plain-language paragraphs, rendered in order. */
  narration: string[];
  actions: GuideAction[];
  /**
   * One line that must not be missed, independent of stage — currently the
   * last step ending badly. Null when there is nothing to flag.
   */
  attention: string | null;
}

export interface GuideInput {
  /** Did the last swarm read succeed — `data !== null && error === null`. */
  trusted: boolean;
  /** Has any read ever settled, so "connecting" and "broken" read differently. */
  everRead: boolean;
  /** Tasks from the last successful read; empty when there has been none. */
  tasks: TaskRecord[];
  /** The snapshot's own timestamp, for in-flight elapsed. */
  snapshotAt: string | null;
  /** The demo runner's report, or null when it could not be read. */
  activity: DemoActivity | null;
}

/** The one-sentence product definition, reused wherever the story is told. */
export const WHAT_OBSEL_IS =
  "When agents build on each other's data, an upstream change quietly invalidates finished work downstream. obsel watches for exactly that.";

export function guide(input: GuideInput): GuideView {
  const attention = lastStepProblem(input.activity);
  const running = input.activity?.running ?? null;

  // While a launched step is live, the buttons go away rather than grey out —
  // the launcher would refuse a second step anyway (they share the tables),
  // and a disabled button with no explanation is a puzzle, not guidance.
  const withActions = (view: GuideView): GuideView =>
    running === null
      ? view
      : {
          ...view,
          actions: [],
          narration: [
            ...view.narration,
            `\`${running.step}\` is running now — its own output is streaming below, and the board above follows it live.`,
          ],
        };

  if (!input.trusted) return connect(input, attention);

  const blockers = failedChecks(input);
  if (blockers.length > 0) return withActions(prepare(input, blockers));

  const tasks = input.tasks;
  if (tasks.some((task) => task.status === "running")) return working(input, attention);
  if (tasks.some((task) => task.stale !== null)) return withActions(flagged(tasks, attention));
  if (tasks.length === 0) return withActions(empty(attention));

  const finished = tasks.filter((task) => task.finishedAt !== null).length;
  if (finished === tasks.length) return withActions(settled(tasks, attention));
  return withActions(registered(tasks, finished, attention));
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

function connect(input: GuideInput, attention: string | null): GuideView {
  const fix = input.activity?.preflight.datahub;
  return {
    stage: "connect",
    headline: input.everRead ? "obsel cannot read the swarm" : "connecting",
    narration: [
      WHAT_OBSEL_IS,
      "Right now obsel cannot read DataHub, so nothing on this board can be trusted — every number is withheld rather than guessed.",
      ...(fix && !fix.ok ? [`What was observed: ${fix.detail}.`] : []),
      ...(fix && !fix.ok && fix.fix ? [`Fix it in a terminal: \`${fix.fix}\``] : []),
    ],
    actions: [],
    attention,
  };
}

function prepare(input: GuideInput, blockers: Blocker[]): GuideView {
  const narration: string[] = [
    "obsel is connected, but this machine is not ready to run the demo agents yet. Each item below was genuinely checked a moment ago, not assumed.",
  ];
  const actions: GuideAction[] = [];

  for (const blocker of blockers) {
    narration.push(`${blocker.name}: ${blocker.check.detail}.`);
    if (blocker.name === "vocabulary" && venvOk(input)) {
      // The one prerequisite that is itself a demo step, so it can be a button.
      actions.push({
        step: "setup",
        label: "Set up DataHub for obsel",
        detail:
          "registers obsel's stale tag and the demo pipeline's DataFlow — one-time, obsel cannot create them mid-run",
      });
    } else if (blocker.check.fix !== null) {
      narration.push(`Fix it in a terminal: \`${blocker.check.fix}\``);
    }
  }

  return {
    stage: "prepare",
    headline: "one-time preparation",
    narration,
    actions,
    attention: lastStepProblem(input.activity),
  };
}

function empty(attention: string | null): GuideView {
  return {
    stage: "empty",
    headline: "nothing is registered yet",
    narration: [
      WHAT_OBSEL_IS,
      "The board is empty because no work has been declared. Register the demo pipeline: four agents, each reading a table another one writes. Each becomes a real node in DataHub, wired to the data it reads and the data it produces — that wiring is what obsel walks later.",
    ],
    actions: [
      {
        step: "register",
        label: "Set up the four agents",
        detail: "declares the four tasks and their lineage in DataHub — no agent runs yet",
      },
    ],
    attention,
  };
}

function registered(tasks: TaskRecord[], finished: number, attention: string | null): GuideView {
  /*
   * Deliberately does NOT list the agents.
   *
   * It used to push one `Title — what it does` line per task here, which was
   * right when the ledger showed a job description only before a task had run.
   * The ledger now carries that line on every row in every state, so this loop
   * was printing a second copy of the same four-item roster one panel above the
   * first — the duplication the owner pointed at, and about 60px of the vertical
   * budget that the stat ribbon needed to stay above the fold.
   *
   * So this says where the list is instead of being it. One roster, in the place
   * that keeps it current.
   */
  const narration: string[] = [
    finished === 0
      ? `${tasks.length} agents are declared and none has run yet. Each one is listed below with the job it registered, and what it reads and writes are already lineage edges in DataHub — the graph is drawn from those edges, not from a diagram.`
      : `${finished} of ${tasks.length} tasks have finished; the rest have not started. Putting the agents to work runs whatever is ready.`,
  ];
  narration.push(
    "When an agent finishes, obsel records a fingerprint of what it produced — a receipt of the exact columns and rows. Everything that follows rests on comparing those receipts.",
  );
  const actions: GuideAction[] = [
    {
      step: "run",
      label: "Start the four agents",
      detail:
        "each task becomes a live Codex session that reads its input and writes its table — expect a few minutes of real work",
    },
  ];
  if (finished === 0) {
    // Without this, `register` is only reachable while the swarm is empty —
    // which on a returning DataHub it never is again, and a pipeline
    // definition change (a new task, a reworded job) could not be re-declared
    // from the board at all.
    actions.push({
      step: "register",
      label: "Set up the four agents again",
      detail:
        "writes the four tasks, their lineage and their job descriptions again — safe to repeat before anything runs",
    });
  }
  return {
    stage: "registered",
    headline: "the pipeline is declared",
    narration,
    actions,
    attention,
  };
}

function working(input: GuideInput, attention: string | null): GuideView {
  const live = input.tasks.filter((task) => task.status === "running");
  const held = input.tasks.filter((task) => task.stale !== null).length;
  const narration = live.map((task) => {
    const elapsed = inFlightMs(task, input.snapshotAt);
    const since = elapsed === null ? "" : ` — in flight for ${formatDuration(elapsed)}`;
    return `${taskTitle(task)} is working${since}. It ${flowLine(task)}.`;
  });
  narration.push(
    "A task that is still running is never judged: its outputs are not final, and it will pick up any new input itself. Only finished work can go stale.",
  );
  if (held > 0) {
    narration.push(
      `${held} finished task(s) still carry their mark from the last change — a mark is only earned back by a run that completes.`,
    );
  }
  return {
    stage: "working",
    headline: `${live.length} agent${live.length === 1 ? " is" : "s are"} working`,
    narration,
    actions: [],
    attention,
  };
}

function settled(tasks: TaskRecord[], attention: string | null): GuideView {
  return {
    stage: "settled",
    headline: "all finished, nothing out of date",
    narration: [
      `All ${tasks.length} tasks finished and obsel holds a fingerprint for every output. Everything each task was built on is still true — for now.`,
      "This is where obsel earns or loses trust, so try to break it. Both buttons run the same real agent again; the difference is whether its requirement changed.",
    ],
    actions: [
      {
        step: "rerun-same",
        label: "Run the orders cleaner again — no changes",
        detail:
          "same instruction, same input — if obsel flags anything on an identical re-run, it cried wolf and you should not trust it",
      },
      {
        step: "change",
        label: "Change one agent's instructions",
        detail:
          "the money column is renamed order_total_usd and nothing downstream is told — exactly how finished work goes quietly wrong",
      },
    ],
    attention,
  };
}

function flagged(tasks: TaskRecord[], attention: string | null): GuideView {
  const marked = tasks.filter(
    (task): task is TaskRecord & { stale: NonNullable<TaskRecord["stale"]> } => task.stale !== null,
  );
  const finished = tasks.filter((task) => task.finishedAt !== null).length;
  const narration: string[] = [
    // Ends at "underneath them". A third sentence used to follow — "Each amber
    // row in the ledger below carries obsel's recorded reason for that task, not
    // a summary" — which was commentary about the screen rather than about the
    // work, addressed to a reader who can already see the amber rows and their
    // reasons a few hundred pixels below. Cutting it took one wrapped line off
    // the tallest stage of the guide.
    `${marked.length} of ${finished} finished tasks are built on something that changed. None of them re-ran and none of them failed — their work simply stopped being true underneath them.`,
  ];
  const transitive = marked.filter((task) => task.stale.hops > 1);
  if (transitive.length > 0) {
    narration.push(
      `${transitive.map((task) => taskTitle(task)).join(" and ")} never read the changed table at all — the change reached ${transitive.length === 1 ? "it" : "them"} through what ${transitive.length === 1 ? "it" : "they"} built on. That transitive reach is why the tasks are wired into DataHub's lineage graph.`,
    );
  }
  // That the marks are also written into DataHub itself is stated once — by the
  // trace panel's footer, beside the steps that did the writing — rather than
  // repeated here.
  return {
    stage: "flagged",
    headline: "finished work just went out of date",
    narration,
    actions: [
      {
        // The re-run stays offered here on purpose — it replays whatever the
        // cleaner was last told to do, so even now it produces the same table
        // and obsel must add nothing to what is already marked. A tool that
        // only avoids false alarms on a calm board has not proved much.
        step: "rerun-same",
        label: "Run the orders cleaner again — no changes",
        detail:
          "the same agent runs its current job again — the same table should come out, no new marks, and the three existing marks must stay exactly as they are",
      },
      {
        step: "reset",
        label: "Reset and start over",
        detail:
          "clears obsel's task state and the marks so the run can start over — the tasks and their lineage stay",
      },
    ],
    attention,
  };
}

// ---------------------------------------------------------------------------
// Shared derivations
// ---------------------------------------------------------------------------

interface Blocker {
  name: "venv" | "codex" | "vocabulary";
  check: DemoActivity["preflight"]["venv"];
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
  if (!preflight.codex.ok) blockers.push({ name: "codex", check: preflight.codex });
  if (!preflight.vocabulary.ok) blockers.push({ name: "vocabulary", check: preflight.vocabulary });
  return blockers;
}

function venvOk(input: GuideInput): boolean {
  return input.activity?.preflight.venv.ok === true;
}

/** The last step ending badly is worth a line on any stage. */
function lastStepProblem(activity: DemoActivity | null): string | null {
  if (activity === null || activity.running !== null) return null;
  const last = activity.lastResult;
  if (last === null || last.exitCode === 0) return null;
  const how =
    last.exitCode === null
      ? `was stopped${last.signal ? ` by ${last.signal}` : ""} before it finished`
      : `exited ${last.exitCode}`;
  return `The last step, \`${last.step}\`, ${how}. Its own output below says why — the board still shows exactly what DataHub holds.`;
}
