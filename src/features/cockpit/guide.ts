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
   * Extra lines, for setup and failure stages only.
   *
   * Empty on every stage a judge watching the demo will see. It exists because
   * `connect` and `prepare` have to hand over a shell command that fixes a broken
   * machine, and compressing that into one line would trade a usable instruction
   * for a word count nobody is counting on those stages.
   */
  notes: string[];
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
          subline: `\`${running.step}\` is running now, and the board follows it live`,
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
    headline: input.everRead ? "can't reach obsel" : "connecting",
    subline: "every number is withheld until a read succeeds",
    notes: [
      ...(fix && !fix.ok ? [`Observed: ${fix.detail}.`] : []),
      ...(fix && !fix.ok && fix.fix ? [`Fix it in a terminal: \`${fix.fix}\``] : []),
    ],
    actions: [],
    attention,
  };
}

function prepare(input: GuideInput, blockers: Blocker[]): GuideView {
  const notes: string[] = [];
  const actions: GuideAction[] = [];

  for (const blocker of blockers) {
    notes.push(`${blocker.name}: ${blocker.check.detail}.`);
    if (blocker.name === "vocabulary" && venvOk(input)) {
      // The one prerequisite that is itself a demo step, so it can be a button.
      actions.push({
        step: "setup",
        label: "Set up DataHub for obsel",
        detail: "registers obsel's tag and pipeline, once",
      });
    } else if (blocker.check.fix !== null) {
      notes.push(`Fix it in a terminal: \`${blocker.check.fix}\``);
    }
  }

  return {
    stage: "prepare",
    headline: "one-time setup",
    subline: "each item below was checked a moment ago, not assumed",
    notes,
    actions,
    attention: lastStepProblem(input.activity),
  };
}

function empty(attention: string | null): GuideView {
  return {
    stage: "empty",
    headline: "nothing registered yet",
    // The only stage that states what obsel is for, because it is the only one
    // with no graph on screen to show it.
    subline: "four agents, each one reading a table another one writes",
    notes: [],
    actions: [
      {
        step: "register",
        label: "Set up the four agents",
        detail: "declares them in DataHub, nothing runs yet",
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
      label: "Start the four agents",
      detail: "real Codex sessions, a few minutes",
    },
  ];
  if (finished === 0) {
    // Without this, `register` is only reachable while the swarm is empty, which
    // on a returning DataHub it never is again, and a pipeline definition change
    // could not be re-declared from the board at all.
    actions.push({
      step: "register",
      label: "Set up the four agents again",
      detail: "safe to repeat before anything runs",
    });
  }
  return {
    stage: "registered",
    headline:
      finished === 0
        ? `${tasks.length} agents ready to run`
        : `${finished} of ${tasks.length} finished`,
    subline: "when one finishes, obsel records a fingerprint of what it produced",
    notes: [],
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
    subline: "work in flight is never judged, only finished work can go stale",
    notes: [],
    actions: [],
    attention,
  };
}

function settled(tasks: TaskRecord[], attention: string | null): GuideView {
  return {
    stage: "settled",
    headline: `all ${tasks.length} finished, nothing out of date`,
    subline: "now try to break it",
    notes: [],
    actions: [
      {
        step: "rerun-same",
        label: "Run the orders cleaner again, no changes",
        detail: "if obsel flags anything, it cried wolf",
      },
      {
        step: "change",
        label: "Change one agent's instructions",
        detail: "renames a column, tells nothing downstream",
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
    const lost = columns.removed.length > 0 ? `lost ${columns.removed.join(", ")}` : null;
    const gained = columns.added.length > 0 ? `gained ${columns.added.join(", ")}` : null;
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
  if (indirect < marked.length) {
    return `${change}, and ${indirect} of the ${marked.length} never read it`;
  }
  return marked.length === 1
    ? `${change}, and the one flagged agent never read it`
    : `${change}, and none of the ${marked.length} ever read it`;
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
    notes: [],
    actions: [
      {
        // The re-run stays offered here on purpose. It replays whatever the
        // cleaner was last told to do, so even now it produces the same table and
        // obsel must add nothing to what is already marked. A tool that only
        // avoids false alarms on a calm board has not proved much.
        step: "rerun-same",
        label: "Run the orders cleaner again, no changes",
        detail: "no new marks, and these three must stay",
      },
      {
        step: "reset",
        label: "Reset and start over",
        detail: "clears the marks, keeps the lineage",
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
  return `The last step, \`${last.step}\`, ${how}. Its own output below says why. The board still shows exactly what DataHub holds.`;
}
