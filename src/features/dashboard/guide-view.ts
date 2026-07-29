/**
 * The shape of what the guide says, and the wording shared across its stages.
 *
 * House rule for every string built from this vocabulary: no sentence may claim
 * a fact the inputs do not carry, and none may use metaphor, aphorism, obsel's
 * own epistemology, or an internal identifier. `e2e/dashboard.spec.ts` fails the
 * build if a `DemoStep` id or a preflight key reaches the page. Two hand-edited
 * plain-language passes came and went before the rule was written down, and both
 * times the clever voice grew straight back, because the only guard on the copy
 * was a word count and an identifier is short.
 */

import type { DemoActivity, DemoStep, RunnerName } from "@/src/server/runner/types";
import type { TaskRecord } from "@/src/server/coordinator/types";

/**
 * The runner's product name, for "Four real ___ sessions".
 *
 * The product rather than the command, because that is the phrase: a session
 * belongs to Codex, and `codex` is what you type. `preflight.ts` keeps the same
 * pair for the same reason, and both lists have to hold the runners
 * `agents/runner_select.py` chooses between, or the board reports on one CLI
 * while the worker runs the other.
 *
 * Null is not "unknown yet" -- it is reached only when neither CLI is
 * installed, and "four real agent sessions" is true there while naming one of
 * them would send the reader to install a product they may not want. The
 * check's own detail names both.
 */
export function runnerProduct(name: RunnerName | null): string {
  if (name === null) return "agent";
  return name === "codex" ? "Codex" : "Claude Code";
}

/** The checklist row before any check has answered, when even which CLI is unknown. */
export const RUNNER_ROW_FALLBACK = "An agent CLI, signed in";

/**
 * The checklist row, which starts a line and so starts with a capital.
 *
 * Spelled out per runner rather than capitalised at the call site, because
 * "The Codex CLI" and "Claude Code" capitalise differently and a generic
 * first-letter uppercase would produce "The claude Code".
 */
export function runnerRowName(name: RunnerName | null): string {
  if (name === null) return RUNNER_ROW_FALLBACK;
  return name === "codex" ? "The Codex CLI, signed in" : "Claude Code, signed in";
}

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
  /**
   * The one action this stage's own sentence is asking for.
   *
   * **At most one per stage**, and a stage whose sentence points somewhere other
   * than a button carries none: the flagged board that holds neither obsel
   * pipeline tells the reader to change one of their own tables, so accenting
   * its reset would point at the one thing the sentence is not asking for.
   *
   * This is the table form's rule (`table-form.module.css`, "spending the board's accent
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
  "scale-register": "Setting up the forty-agent taxi run",
  "scale-run": "The forty-agent taxi run",
  "scale-change": "The requirement change",
  "scale-change-mid": "The forty-agent taxi run, with a change landing partway",
  "scale-repair": "The parallel repair",
};

/**
 * One prerequisite, as the setup screen shows it.
 *
 * This replaced `notes: string[]`, which rendered only the FAILING checks, each
 * prefixed with its own key in the preflight record: `venv:`, `runner:`,
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
export type StageView = GuideView;

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

// ---------------------------------------------------------------------------
// Shared derivations
// ---------------------------------------------------------------------------

export interface Blocker {
  name: "venv" | "runner" | "vocabulary" | "uvx";
  check: DemoActivity["preflight"]["venv"];
}

/** The last step ending badly is worth a line on any stage. */
export function lastStepProblem(activity: DemoActivity | null): string | null {
  if (activity === null || activity.running !== null) return null;
  const last = activity.lastResult;
  if (last === null || last.exitCode === 0) return null;
  // Neither the exit code nor the signal name reaches the reader. Both are in the
  // step's own output, one click away, which is where somebody who wants them will
  // already be looking; on the headline they are two numbers to be alarmed by and
  // nothing to do about.
  const how = last.exitCode === null ? "was stopped before it finished" : "did not finish";
  return `${STEP_NAME[last.step]} ${how}. Its output below says why. This page still shows what DataHub holds.`;
}
