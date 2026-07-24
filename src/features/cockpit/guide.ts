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

import { datasetTitle, taskTitle } from "./naming";
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
  reset: "The reset",
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

export function guide(input: GuideInput): GuideView {
  const attention = lastStepProblem(input.activity);
  const running = input.activity?.running ?? null;

  // While a launched step is live, the buttons go away rather than grey out. The
  // launcher would refuse a second step anyway (they share the tables), and a
  // disabled button with no explanation is a puzzle, not guidance.
  const withActions = (view: GuideView): GuideView =>
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
  if (finished === tasks.length) return withActions(settled(tasks, attention));
  return withActions(registered(tasks, finished, attention));
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

function connect(input: GuideInput, attention: string | null): GuideView {
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
  { key: "codex", name: "The Codex CLI, signed in" },
];

function prepare(input: GuideInput, blockers: Blocker[]): GuideView {
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

function empty(attention: string | null): GuideView {
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
      },
    ],
    attention,
  };
}

function registered(tasks: TaskRecord[], finished: number, attention: string | null): GuideView {
  /*
   * Says nothing about which agents exist, and nothing about what they do.
   *
   * Both were here once, as a line per task. The graph draws all four boxes with
   * their names and the tables between them, so a roster in prose above it was
   * the same four facts a second time, in the slower medium. This stage now
   * carries one fact the graph cannot show: what obsel does when a task finishes.
   */
  const actions: GuideAction[] = [
    {
      step: "run",
      label: "Start the demo agents",
      detail: "Four real Codex sessions. Takes a few minutes.",
    },
  ];
  if (finished === 0) {
    // Without this, `register` is only reachable while the swarm is empty, which
    // on a returning DataHub it never is again, and a pipeline definition change
    // could not be re-declared from the board at all.
    actions.push({
      step: "register",
      label: "Set up the demo agents again",
      detail: "Safe to repeat while nothing has run yet.",
    });
  }
  return {
    stage: "registered",
    headline:
      finished === 0
        ? `${tasks.length} agents ready to run`
        : `${finished} of ${tasks.length} finished`,
    subline: "When an agent finishes, obsel records what its table looked like",
    checks: [],
    actions,
    attention,
  };
}

function working(input: GuideInput, attention: string | null): GuideView {
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

function settled(tasks: TaskRecord[], attention: string | null): GuideView {
  return {
    stage: "settled",
    headline: `all ${tasks.length} finished, nothing out of date`,
    subline: "Try one of these and watch what obsel does",
    checks: [],
    actions: [
      {
        step: "rerun-same",
        label: "Run the orders cleaner again, no changes",
        detail: "It writes the same table, so nothing should go out of date.",
      },
      {
        step: "change",
        label: "Change one agent's instructions",
        detail: "It renames a column. Nobody downstream is told.",
      },
    ],
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

function flagged(tasks: TaskRecord[], attention: string | null): GuideView {
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

  return {
    stage: "flagged",
    headline: `${marked.length} of ${finished} finished agents are out of date`,
    subline: newest === null ? null : flaggedSubline(newest, marked),
    checks: [],
    actions: [
      {
        // The re-run stays offered here on purpose. It replays whatever the
        // cleaner was last told to do, so even now it produces the same table and
        // obsel must add nothing to what is already marked. A tool that only
        // avoids false alarms on a calm board has not proved much.
        step: "rerun-same",
        label: "Run the orders cleaner again, no changes",
        detail: `Nothing new should go out of date, and these ${marked.length} should stay.`,
      },
      {
        step: "reset",
        label: "Reset and start over",
        detail: "Puts every agent back to up to date. They stay set up.",
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
  // Neither the exit code nor the signal name reaches the reader. Both are in the
  // step's own output, one click away, which is where somebody who wants them will
  // already be looking; on the headline they are two numbers to be alarmed by and
  // nothing to do about.
  const how = last.exitCode === null ? "was stopped before it finished" : "did not finish";
  return `${STEP_NAME[last.step]} ${how}. Its output below says why. The board still shows what DataHub holds.`;
}
