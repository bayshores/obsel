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
 *
 * **The second house rule, and the one this file kept breaking: a sentence on
 * screen has to be readable by someone who has never opened the README.**
 *
 * That forbids four things, and every one of them was here:
 *
 * - **Metaphor.** "if obsel flags anything, it cried wolf" is a good line and it
 *   assumes the reader already knows what a false alarm would cost.
 * - **Aphorism.** "now try to break it" is an instruction only to a reader who
 *   already knows what "it" does and what breaking it would show.
 * - **Epistemology.** "every number is withheld until a read succeeds" and "work
 *   in flight is never judged" answer questions a newcomer has not asked. They are
 *   obsel explaining its principles to somebody still working out what it is.
 * - **Internal names.** The `DemoStep` ids the launcher takes, and the keys of the
 *   preflight record, are strings this repository chose. A reader has nowhere to
 *   look them up. `e2e/cockpit.spec.ts` fails the build if one reaches the page.
 *
 * Two hand-edited plain-language passes came and went before this rule was
 * written down, and both times the clever voice grew straight back, because the
 * only guard on the copy was a word count and an identifier is short.
 */

import { boardSawAChange } from "./fingerprints";
import { agreeing, datasetTitle, taskTitle } from "./naming";
import { formatDuration, inFlightMs } from "./progress";
import type { DemoStep, DemoActivity, StepResult } from "@/src/server/runner/types";
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

/** A real action: one button, one launched demo step, nothing canned. */
export interface GuideAction {
  step: DemoStep;
  label: string;
  /** What genuinely happens when pressed, one sentence. */
  detail: string;
  /**
   * The one action this stage's own sentence is asking for.
   *
   * **At most one per stage**, and a stage whose sentence points somewhere other
   * than a button carries none: the flagged board that holds neither obsel
   * pipeline tells the reader to change one of their own tables, so accenting
   * its reset would point at the one thing the sentence is not asking for.
   *
   * This is the bench's rule (`bench.module.css`, "spending the board's accent
   * on the single irreversible action in the panel is the whole of the visual
   * hierarchy here") applied to a panel where more than one button is
   * legitimate. Every action rendered identically until 2026-07-27, so on a
   * flagged board "Redo the work obsel flagged" and "Reset and start over" were
   * the same object with different text, and the reader had to read both to find
   * out which one the board was asking for.
   *
   * The accent is spent on colour and elevation, never on size. Both labels stay
   * 13px and both details 12px: `docs/verification.md` records three guides that
   * failed by adding what mattered at footnote size, and the secondary here gets
   * MORE contrast than it had, not less.
   */
  primary?: true;
}

/**
 * The same action with its accent given up, for a stage where something else
 * earns it.
 *
 * Copy-then-delete rather than naming the fields to keep, so that a field added
 * to `GuideAction` later travels through this instead of being silently dropped.
 */
function unaccented(action: GuideAction): GuideAction {
  const copy = { ...action };
  delete copy.primary;
  return copy;
}

/**
 * What each demo step is called in a sentence.
 *
 * The board used to print the `DemoStep` id itself: "`rerun-same` is running now",
 * "The last step, `change`, exited 3". Those are strings this repository picked for
 * its own launcher, and a reader has nowhere to look them up.
 *
 * Deliberately NOT the button labels. Those are imperative and long by design
 * ("Run the orders cleaner again, no changes"), which is right on a button and
 * unreadable in the middle of a sentence about what is happening.
 *
 * Capitalised, because every place one of these is used it opens a sentence: the
 * running line, the failure line, and the finished-step summary in
 * `guide-panel.tsx`.
 */
export const STEP_NAME: Record<DemoStep, string> = {
  setup: "The DataHub setup",
  register: "Setting up the agents",
  run: "The agent run",
  "rerun-same": "The unchanged re-run",
  change: "The instruction change",
  repair: "The repair",
  reset: "The reset",
  "scale-register": "Setting up the taxi swarm",
  "scale-run": "The taxi swarm run",
  "scale-change": "The requirement change",
  "scale-change-mid": "The taxi swarm run, with a change landing partway",
  "scale-repair": "The parallel repair",
};

/**
 * One prerequisite, as the setup screen shows it.
 *
 * This replaced `notes: string[]`, which rendered only the FAILING checks, each
 * prefixed with its own key in the preflight record: `venv:`, `codex:`,
 * `vocabulary:`. Three opaque labels, no ordering, and no way to tell whether that
 * was the first problem of one or the last of four.
 *
 * The data is identical -- `DemoActivity.preflight` always carried all four. Only
 * the passing ones were being thrown away, and they are the half that tells a
 * reader how far along they are.
 */
export interface GuideCheck {
  /** What is being checked, in words the reader can act on. */
  name: string;
  done: boolean;
  /** What obsel observed. Null when it passed and there is nothing to add. */
  detail: string | null;
  /** The command that fixes it, verbatim and copyable. */
  fix: string | null;
}

export interface GuideView {
  stage: GuideStage;
  /**
   * The one sentence the board leads with, set large.
   *
   * This replaced `narration: string[]`, which was up to four paragraphs and
   * measured 156 words on screen in the flagged state. The board was 604 words in
   * total with nothing set larger than 13px, so nothing led and a reader had no
   * entry point: the only way in was to read all of it. A headline plus one line
   * is the whole budget now, and the graph carries the rest.
   */
  headline: string;
  /** One short line under the headline. Null when the headline says it all. */
  subline: string | null;
  /**
   * The prerequisites, for the setup and connection stages only.
   *
   * Empty on every stage a judge watching the demo will see. It exists because
   * `connect` and `prepare` have to hand over a shell command that fixes a broken
   * machine, and compressing that into one line would trade a usable instruction
   * for a word count nobody is counting on those stages.
   */
  checks: GuideCheck[];
  actions: GuideAction[];
  /**
   * One line that must not be missed, independent of stage. Currently the last
   * step ending badly. Null when there is nothing to flag.
   */
  attention: string | null;
}

/** A stage's own half of the view. Every field of `GuideView` is one. */
type StageView = GuideView;

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

/*
 * `WHAT_OBSEL_IS` used to sit here: a 24-word product definition described as
 * "reused wherever the story is told", and referenced from nowhere at all. It was
 * left behind when the tagline came off the header, so the board went from stating
 * its purpose badly to not stating it while still carrying the sentence.
 *
 * What replaced it is on screen. The graph panel's heading in `cockpit.tsx` is the
 * question obsel answers, and the graph beneath it is the answer, which is a job 24
 * words of prose above a picture could never do as well as the picture.
 */

/**
 * Which pipeline's buttons this board should offer.
 *
 * The buttons launch specific pipelines — "run the orders cleaner again" drives
 * the four-agent demo and nothing else — so offering them on a board holding a
 * different swarm would be a button that acts on work that is not on screen.
 * Recognition is by the pipelines' own task names, checked here and never
 * rendered: a swarm containing neither (a judge's own agents, joined over MCP)
 * gets the actions that are safe anywhere and no pipeline-specific ones.
 *
 * The taxi markers win when both pipelines are somehow registered together,
 * because the forty-task journey is the one a mixed board most likely belongs
 * to mid-switch, and its buttons never touch the demo's tables.
 */
function swarmKind(tasks: TaskRecord[]): "demo" | "taxi" | "other" {
  const names = new Set(tasks.map((task) => task.name));
  if (names.has("clean_trips") && names.has("daily_trips")) return "taxi";
  if (names.has("clean_orders") && names.has("build_revenue")) return "demo";
  return "other";
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
          subline: `${STEP_NAME[running.step]} is running now, and the board updates as it goes`,
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
  return withActions(registered(tasks, finished, attention));
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

function connect(input: GuideInput, attention: string | null): StageView {
  const datahub = input.activity?.preflight.datahub;
  return {
    stage: "connect",
    headline: input.everRead ? "The board lost its connection" : "Starting up",
    // Says what obsel is doing about it, not why obsel believes it is the right
    // thing to do. The reasoning is real and it belongs in the code comment on
    // BLANK in cockpit.tsx, where the people it is meant for will find it.
    subline: "obsel hides its numbers rather than show old ones",
    checks:
      datahub && !datahub.ok
        ? [{ name: "DataHub", done: false, detail: datahub.detail, fix: datahub.fix }]
        : [],
    actions: [],
    attention,
  };
}

/**
 * The checklist, in the order the things have to be done.
 *
 * Not the order of the `preflight` record, which is alphabetical by accident of
 * how it is built. DataHub has to answer before its tag can be looked for, and
 * the tag is created by a script that needs the Python packages, so this order is
 * a real dependency chain and following it top to bottom always works.
 *
 * Codex is last because it is the only one nothing else depends on: it is needed
 * to run the agents, not to set anything up.
 */
const CHECK_ORDER: readonly { key: Blocker["name"] | "datahub"; name: string }[] = [
  { key: "datahub", name: "DataHub" },
  { key: "venv", name: "Python packages for the demo agents" },
  { key: "vocabulary", name: "obsel's tag in DataHub" },
  { key: "uvx", name: "uv, which obsel writes that tag through" },
  { key: "codex", name: "The Codex CLI, signed in" },
];

function prepare(input: GuideInput, blockers: Blocker[]): StageView {
  const preflight = input.activity?.preflight;
  const actions: GuideAction[] = [];

  const checks: GuideCheck[] = CHECK_ORDER.map(({ key, name }) => {
    const check = preflight?.[key];
    const done = check?.ok === true;
    return {
      name,
      done,
      /*
       * A passing check says only its name, and the names above are short noun
       * phrases so that a failing one's detail adds something.
       *
       * Both halves were learned by looking at the rendered screen. The first
       * version showed the detail on every row, so a done check read "The Codex
       * CLI is signed in" and then "The Codex CLI is signed in." The second kept
       * full-sentence names, so a failing check read "The demo agents have their
       * Python packages" above "The demo agents do not have their Python packages
       * installed yet" -- the same fact, negated, in a list whose tick already
       * said which way round it was. Every detail in `preflight.ts` now carries a
       * fact the name does not: a URL, a consequence, or what else to try.
       */
      detail: done ? null : (check?.detail ?? null),
      fix: done ? null : (check?.fix ?? null),
    };
  });

  // The one prerequisite that is itself a demo step, so it can be a button rather
  // than a command to copy. Offered only once the Python packages are in place,
  // because that is what runs it.
  if (blockers.some((blocker) => blocker.name === "vocabulary") && venvOk(input)) {
    actions.push({
      primary: true,
      step: "setup",
      label: "Add obsel's tag to DataHub",
      detail: "Runs once. obsel cannot create the tag later.",
    });
  }

  const left = checks.filter((check) => !check.done).length;
  return {
    stage: "prepare",
    headline: left === 1 ? "One more thing to set up" : `${left} things to set up`,
    subline: "obsel checked each of these on this computer a moment ago",
    checks,
    actions,
    attention: lastStepProblem(input.activity),
  };
}

function empty(attention: string | null): StageView {
  return {
    stage: "empty",
    headline: "No agents yet",
    // The only stage that states what obsel is for, because it is the only one
    // with no graph on screen to show it.
    subline: "The demo has four agents. Each one reads a table that another one writes.",
    checks: [],
    /*
     * "the demo agents", never "the four agents".
     *
     * These three labels said four, and the headline above them counts whatever
     * DataHub actually holds. On a board with seven jobs on it that reads as a
     * contradiction, and neither half is wrong: the count is what is registered,
     * and the button really does drive only the demo's own pipeline.
     *
     * A number here is a promise this file cannot keep. obsel's whole point is
     * that any MCP-capable agent can join a swarm, so a board carrying more than
     * the demo's own agents is the expected case rather than a fault, and a label
     * that names a count goes stale the first time somebody joins one.
     */
    actions: [
      {
        step: "register",
        label: "Set up the demo agents",
        detail: "Adds them to DataHub. Nothing runs yet.",
        primary: true,
      },
      {
        step: "scale-register",
        label: "Set up the taxi swarm instead",
        detail: "Forty agents over a week of real taxi trips. Nothing runs yet.",
      },
    ],
    attention,
  };
}

function registered(tasks: TaskRecord[], finished: number, attention: string | null): StageView {
  /*
   * Says nothing about which agents exist, and nothing about what they do.
   *
   * Both were here once, as a line per task. The graph draws all four boxes with
   * their names and the tables between them, so a roster in prose above it was
   * the same four facts a second time, in the slower medium. This stage now
   * carries one fact the graph cannot show: what obsel does when a task finishes.
   */
  const kind = swarmKind(tasks);
  const taxi = kind === "taxi";

  /*
   * Nothing to offer on a board holding neither pipeline, for the reason
   * `settled` and `flagged` below record: every button here starts a specific
   * pipeline's agents, and none of that pipeline is on this board. Somebody
   * else's registered tasks are started by whatever registered them, or by
   * writing their table at the bench.
   */
  if (kind === "other") {
    return {
      stage: "registered",
      headline:
        finished === 0
          ? `${tasks.length} ${agreeing(tasks.length, "agent")} ready to run`
          : // The noun was missing here and nowhere else: "4 of 5 finished" is
            // four of five what, on a board whose flagged headline says "3 of 4
            // finished agents are out of date" two stages later.
            `${finished} of ${tasks.length} ${agreeing(tasks.length, "agent")} finished`,
      subline: "When an agent finishes, obsel records what its table looked like",
      checks: [],
      actions: [],
      attention,
    };
  }

  const actions: GuideAction[] = [
    taxi
      ? {
          step: "scale-change-mid",
          label: "Start the taxi swarm",
          detail:
            "Forty real Codex sessions, running up to eight at once. Partway through, one requirement changes.",
          primary: true,
        }
      : {
          step: "run",
          label: "Start the demo agents",
          detail: "Four real Codex sessions. Takes a few minutes.",
          primary: true,
        },
  ];
  if (finished === 0) {
    // Without this, `register` is only reachable while the swarm is empty, which
    // on a returning DataHub it never is again, and a pipeline definition change
    // could not be re-declared from the board at all.
    actions.push(
      taxi
        ? {
            step: "scale-register",
            label: "Set up the taxi swarm again",
            detail: "Safe to repeat while nothing has run yet.",
          }
        : {
            step: "register",
            label: "Set up the demo agents again",
            detail: "Safe to repeat while nothing has run yet.",
          },
    );
  }
  return {
    stage: "registered",
    headline:
      finished === 0
        ? `${tasks.length} ${agreeing(tasks.length, "agent")} ready to run`
        : // Four of five what. The noun was missing on both branches of this
          // stage and nowhere else, on a board whose flagged headline says
          // "3 of 4 finished agents are out of date" two acts later.
          `${finished} of ${tasks.length} ${agreeing(tasks.length, "agent")} finished`,
    subline: "When an agent finishes, obsel records what its table looked like",
    checks: [],
    actions,
    attention,
  };
}

function working(input: GuideInput, attention: string | null): StageView {
  const live = input.tasks.filter((task) => task.status === "running");
  const elapsed = live.length === 1 ? inFlightMs(live[0], input.snapshotAt) : null;
  const since = elapsed === null ? "" : `, ${formatDuration(elapsed)} in`;

  return {
    stage: "working",
    headline:
      live.length === 1
        ? `${taskTitle(live[0])} is working${since}`
        : `${live.length} agents are working`,
    subline: "obsel waits until an agent finishes before it checks anything",
    checks: [],
    actions: [],
    attention,
  };
}

function settled(tasks: TaskRecord[], attention: string | null, walked: boolean): StageView {
  const kind = swarmKind(tasks);
  const taxi = kind === "taxi";

  /*
   * A board holding neither pipeline gets no buttons and a sentence instead.
   *
   * `swarmKind` has always promised this — "a swarm containing neither (a
   * judge's own agents, joined over MCP) gets the actions that are safe
   * anywhere and no pipeline-specific ones" — and until the bench existed there
   * was almost no way to reach a settled board made only of somebody else's
   * tasks, so the promise went unimplemented and untested. It offered "Run the
   * orders cleaner again" on a board with no orders cleaner on it: a button
   * acting on work that is not on screen, which is the one thing the comment
   * above `swarmKind` says must never happen.
   *
   * The sentence points at the bench, which is the thing on this board that
   * genuinely does what those buttons would have done.
   */
  if (kind === "other") {
    return {
      stage: "settled",
      headline:
        tasks.length === 1
          ? "the one agent finished, nothing out of date"
          : `all ${tasks.length} finished, nothing out of date`,
      subline: "Change a column in one of your tables below and report it again",
      checks: [],
      actions: [],
      attention,
    };
  }

  const experiments: GuideAction[] = taxi
    ? [
        {
          // No counts in this sentence, same rule as the demo labels above:
          // the flag set is whatever is genuinely downstream on the day, and
          // an agent that joined the swarm would falsify any number here.
          step: "scale-change",
          label: "Change one requirement",
          detail: "One agent renames a column. Only work built on that table should flag.",
          primary: true,
        },
      ]
    : [
        /*
         * The change leads, and the identical re-run follows it.
         *
         * The order was the other way round until 2026-07-27, and the argument
         * for turning it is symmetry rather than taste: the settled taxi board
         * offers exactly one experiment and it is the change. With the demo
         * board leading on the re-run, the same stage taught two different
         * lessons depending on which swarm a reader happened to be looking at.
         *
         * The re-run is a control experiment, and a control only means anything
         * to somebody who already expects the other result. It stays, second and
         * unaccented, for the reader who has seen the cascade and wants to know
         * whether obsel cries wolf.
         */
        {
          step: "change",
          label: "Change one agent's instructions",
          detail: "It renames a column. Nobody downstream is told.",
          primary: true,
        },
        {
          step: "rerun-same",
          label: "Run the orders cleaner again, no changes",
          detail: "It writes the same table, so nothing should go out of date.",
        },
      ];

  const restart: GuideAction[] = walked
    ? [
        {
          step: "reset",
          // Word for word the label the flagged board uses, because it is the
          // same action: the same button under two circumstances must not be two
          // different names for a reader learning their way around.
          label: "Reset and start over",
          detail: "Puts every agent back to up to date. They stay set up.",
          // The subline above literally says "Reset to walk it again", so on a
          // walked board this is the action the sentence is asking for, and the
          // experiments hand their accent over below.
          primary: true,
        },
      ]
    : [];

  return {
    stage: "settled",
    // "all 1 finished" is what the counted form produces on a one-task board, so
    // the singular is worded rather than counted. Same reason as the one-agent
    // branch in `flaggedSubline`: the number is the whole swarm, and saying "all"
    // of one thing reads as a bug.
    headline:
      tasks.length === 1
        ? "the one agent finished, nothing out of date"
        : `all ${tasks.length} finished, nothing out of date`,
    /*
     * A board that has been all the way round says so, and offers the way back
     * to the start.
     *
     * Without this a completed walk reads exactly like one that never started:
     * every act ticked on the rail, and a line underneath telling the reader to
     * try the things they have just finished trying. The walk is meant to be
     * repeatable, and this is where the loop closes.
     */
    subline: walked
      ? "Every act has run. Reset to walk it again."
      : taxi
        ? "Try changing one requirement and watch how far it reaches"
        : "Try one of these and watch what obsel does",
    checks: [],
    /*
     * The restart first, when there is one: it is the answer to the sentence
     * above it, and the two experiments below it have both already been run.
     *
     * The experiments give up their accent to it rather than competing, because
     * the rule on `GuideAction.primary` is at most one per stage and this is the
     * only place two candidates meet. Written as a strip rather than as a
     * condition inside each experiment so that adding a third experiment cannot
     * quietly reintroduce a second accent.
     */
    actions: [...restart, ...(walked ? experiments.map(unaccented) : experiments)],
    attention,
  };
}

/**
 * The one line that has to explain obsel to a stranger.
 *
 * Built from the mark's own recorded change rather than from any stored script.
 * When obsel recorded which columns moved, it names them: "clean orders lost
 * order_total and gained order_total_usd" is the sentence that makes the whole
 * premise land, and it is the fact the board used to render as `s f7b62a66`.
 *
 * Says lost and gained, never renamed. A column leaving while another arrives is
 * indistinguishable from a drop plus an unrelated addition, and the reader can
 * draw that conclusion without obsel asserting it.
 */
function changeLine(mark: NonNullable<TaskRecord["stale"]>): string {
  const table = datasetTitle(mark.causedBy);
  const columns = mark.columns;

  if (columns) {
    // "the column order_total" rather than "order_total". A bare identifier in the
    // middle of a sentence reads as a word the reader is expected to recognise,
    // and this one is invented by the demo two minutes before it appears here.
    const noun = (names: readonly string[]): string =>
      `${names.length === 1 ? "the column" : "the columns"} ${names.join(", ")}`;
    const lost = columns.removed.length > 0 ? `lost ${noun(columns.removed)}` : null;
    const gained = columns.added.length > 0 ? `gained ${noun(columns.added)}` : null;
    const both = [lost, gained].filter((part): part is string => part !== null).join(" and ");
    return `${table} ${both} after they finished`;
  }

  // No column record: describe the kind of change, which is always known.
  if (mark.changeKind === "content") return `the rows in ${table} changed after they finished`;
  return `the columns in ${table} changed after they finished`;
}

/**
 * How many flagged tasks never read the table that changed.
 *
 * This is the fact obsel exists for and the board has never said in words. Until
 * now it was on screen only as `· 2 hops` on two boxes, which is readable to
 * someone who already knows what a hop is and invisible to everyone else. Anybody
 * can watch a table change and flag whatever read it; flagging work that is two
 * removes away, correctly, is the part that needs a lineage graph.
 *
 * Derived from `reads`, deliberately, and not from `hops > 1`. "Never read it" is a
 * claim about what the task consumes, and `reads` is that claim directly, checkable
 * against the record. Hops measure distance through the graph, which usually agrees
 * and is not the same statement: a task could sit two hops out and still read the
 * changed table on a second edge, and the sentence would then be false while the
 * hop count stayed honest.
 */
function neverReadIt(marked: readonly TaskRecord[], causedBy: string): number {
  return marked.filter((task) => !task.reads.includes(causedBy)).length;
}

/**
 * The one line under the headline: what changed, and why it is not obvious.
 *
 * Three phrasings, because one template cannot say all three truthfully:
 *
 * - **None indirect** — the clause is dropped entirely. Every flagged task read the
 *   changed table, so there is nothing counterintuitive on that board and "and 0 of
 *   the 3 never read it" would spend words reporting an absence.
 * - **All indirect, more than one** — "none of the 3 ever read it", because "3 of
 *   the 3" is a ratio a reader has to do arithmetic on to find out it is all of them.
 * - **All indirect, exactly one** — spelled out. "1 of the 1 never read it" is what
 *   the ratio form produces here, and it reads like a bug.
 */
function flaggedSubline(
  mark: NonNullable<TaskRecord["stale"]>,
  marked: readonly TaskRecord[],
): string {
  const indirect = neverReadIt(marked, mark.causedBy);
  const change = changeLine(mark);
  if (indirect === 0) return change;
  // A full stop rather than a comma. These are two separate facts, and the
  // comma spliced them into one 20-word sentence a reader had to hold whole.
  if (indirect < marked.length) {
    return `${change}. ${indirect} of the ${marked.length} never read that table.`;
  }
  return marked.length === 1
    ? `${change}. The one agent that went out of date never read that table.`
    : `${change}. None of the ${marked.length} ever read that table.`;
}

function flagged(tasks: TaskRecord[], attention: string | null): StageView {
  const marked = tasks.filter(
    (task): task is TaskRecord & { stale: NonNullable<TaskRecord["stale"]> } => task.stale !== null,
  );
  const finished = tasks.filter((task) => task.finishedAt !== null).length;

  /*
   * Two paragraphs used to live here, 62 words between them: one saying no task
   * re-ran or failed, one naming the transitively affected tasks and explaining
   * why lineage matters. Both are now visible rather than described. The graph
   * shows the amber path travelling outward from the changed table through each
   * hop, which is the transitive reach the second paragraph was spelling out, and
   * it shows it continuously rather than in a sentence a reader has to hold.
   */
  const newest = marked.reduce<NonNullable<TaskRecord["stale"]> | null>((best, task) => {
    if (best === null) return task.stale;
    return Date.parse(task.stale.since) > Date.parse(best.since) ? task.stale : best;
  }, null);

  const kind = swarmKind(tasks);

  /*
   * The same withholding `settled` does, and here it matters more.
   *
   * Both pipeline-specific buttons act on tables that are not on this board:
   * the repair re-runs the demo's own agents, and the re-run replays the demo's
   * orders cleaner. Offered on somebody else's flagged swarm they would look
   * like the answer to the flag on screen and do something else entirely.
   *
   * The reset stays, and it is the one that can: `resetSwarm` puts every task
   * on the flow back to registered, whoever registered it, so it means exactly
   * what it says here. The redo a visitor's board needs is the bench below —
   * report the flagged task's table again — and that is what the line says.
   */
  const actionsFor = (): GuideAction[] => {
    if (kind === "other") {
      // No accent anywhere on this board, deliberately. Its own sentence sends
      // the reader to the bench below to report the flagged table again, so the
      // accent would be spent pointing at a reset the sentence is not asking
      // for, and a reset is the one action here that throws work away.
      return [
        {
          step: "reset",
          label: "Reset and start over",
          detail: "Puts every agent back to up to date. They stay set up.",
        },
      ];
    }
    if (kind === "taxi") {
      return [
        {
          // First for the same reason the demo's repair is first: it is the
          // answer to the question a flagged board asks. The parallel form is
          // the difference worth a word: independent redos run at the same
          // time, and a redo that proves other work sound takes its re-runs off
          // the plan entirely.
          primary: true,
          step: "scale-repair",
          label: "Redo the work obsel flagged, in parallel",
          detail:
            "Independent redos run at once. A table that comes out identical clears the flags on work built on it, and those re-runs never happen.",
        },
        {
          step: "reset",
          label: "Reset and start over",
          detail: "Puts every agent back to up to date. They stay set up.",
        },
      ];
    }
    return [
      {
        // First, because it is the answer to the question a flagged board asks.
        // A flag with nothing to do about it is a dashboard; this is the doing.
        // There is no button that clears a flag directly, on purpose: the only
        // way a flag comes off is real redone work, this button's or obsel's
        // own proof that an identical redo made a re-run unnecessary.
        primary: true,
        step: "repair",
        label: "Redo the work obsel flagged",
        detail:
          "Agents redo it in order. A table that comes out identical clears the flags on work built on it.",
      },
      {
        // The re-run stays offered here on purpose. It replays whatever the
        // cleaner was last told to do, so even now it produces the same table and
        // obsel must add nothing to what is already marked. A tool that only
        // avoids false alarms on a calm board has not proved much.
        step: "rerun-same",
        label: "Run the orders cleaner again, no changes",
        detail: `Nothing new should go out of date, and ${marked.length === 1 ? "this one" : `these ${marked.length}`} should stay.`,
      },
      {
        step: "reset",
        label: "Reset and start over",
        detail: "Puts every agent back to up to date. They stay set up.",
      },
    ];
  };

  return {
    stage: "flagged",
    // The noun agrees with the denominator and the verb with the numerator: "1 of
    // 3 finished agents is out of date" is right on both counts, and keying either
    // to the wrong number is how "1 of 1 finished agents are" got onto a board.
    headline: `${marked.length} of ${finished} finished ${agreeing(finished, "agent")} ${agreeing(marked.length, "is", "are")} out of date`,
    subline: newest === null ? null : flaggedSubline(newest, marked),
    checks: [],
    actions: actionsFor(),
    attention,
  };
}

// ---------------------------------------------------------------------------
// Shared derivations
// ---------------------------------------------------------------------------

interface Blocker {
  name: "venv" | "codex" | "vocabulary" | "uvx";
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
  if (!preflight.uvx.ok) blockers.push({ name: "uvx", check: preflight.uvx });
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
  // Neither the exit code nor the signal name reaches the reader. Both are in the
  // step's own output, one click away, which is where somebody who wants them will
  // already be looking; on the headline they are two numbers to be alarmed by and
  // nothing to do about.
  const how = last.exitCode === null ? "was stopped before it finished" : "did not finish";
  return `${STEP_NAME[last.step]} ${how}. Its output below says why. The board still shows what DataHub holds.`;
}
