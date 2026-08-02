/**
 * The tour: what a stranger is taught, in order, as data.
 *
 * Three guides came before this one and all three were status displays: a rail
 * of act names, a sentence saying where to look, rings on the graph. Each was
 * derived correctly and none of them guided anybody, because a guide is not a
 * report on where you are. It goes through the app *with* you, one thing at a
 * time, and it does not hand over the whole flow at once and leave.
 *
 * So the unit here is a step somebody reads and then does, not a stage the
 * board happens to be in. Two kinds, and the difference is who advances it:
 *
 * - **`read`** — an explanation. The reader presses next when they have read it.
 *   These are the ones that teach the screen, and nothing about the board
 *   changes while they are on screen.
 * - **`act`** — something to do. There is **no next button**. The step names a
 *   real control, and it advances when `done` says the real thing genuinely
 *   happened on the board. A tour that let you press next past an action would
 *   sooner or later be describing a board that does not exist, which is the one
 *   failure this repository refuses everywhere else.
 *
 * `done` and `progress` are pure functions of the same `GuideInput` the guide
 * panel is built from: the snapshot obsel read from DataHub, plus what the
 * launcher on this machine has run. Nothing is stored about how far the reader
 * has got through chapter two — it is derived, every poll, from the board. The
 * one thing that *is* stored is which explanation they had reached, because
 * that is a fact about the reader rather than about the board.
 */

import { boardSawAChange } from "../fingerprints";
import { performedSteps } from "../guide/guide";
import type { GuideInput } from "../guide/guide";
import type { DemoStep } from "@/src/server/runner/types";

/** Which region of the board a step points at, or nothing. */
export type TourTarget =
  | "none"
  | "guide"
  | "graph"
  | "trace"
  | "numbers"
  | "joining"
  | "erasure"
  /** A control in the guide panel, named by the demo steps it might launch. */
  | "action";

interface Base {
  /** Stable, and used by the stored bookmark, so renaming one resets a reader. */
  id: string;
  /** 1 teaches the screen, 2 walks the demonstration. Painted on the card. */
  chapter: 1 | 2;
  title: string;
  /** Two or three short sentences. Plain words, no vocabulary to learn. */
  body: string;
  target: TourTarget;
}

export interface ReadStep extends Base {
  kind: "read";
}

export interface ActStep extends Base {
  kind: "act";
  target: "action";
  /**
   * The demo steps whose button this act is about, most specific first.
   *
   * A list rather than one, because the four-agent demonstration and the
   * forty-agent taxi swarm reach the same place through differently named
   * buttons. The card asks the guide which of these it is currently offering
   * and quotes that button's real label, so the instruction always names a
   * control that is genuinely on screen rather than one this file assumed.
   */
  launches: readonly DemoStep[];
  /** True once the board itself shows the thing happened. Never a step record alone. */
  done: (input: GuideInput) => boolean;
  /** What to show while it is in progress, or null when there is nothing to say. */
  progress: (input: GuideInput) => string | null;
}

export type TourStep = ReadStep | ActStep;

/** Every task on the board has finished at least once. */
function allFinished(input: GuideInput): boolean {
  return input.tasks.length > 0 && input.tasks.every((task) => task.finishedAt !== null);
}

/**
 * The next action after a given position, or the end of the tour when there is
 * none left to do.
 *
 * Passing -1 gives the first action, which is where a board with nothing on it
 * sits: everything before it is explanation, and the tour is free to be anywhere
 * in that.
 */
function nextActAfter(index: number): number {
  for (let i = index + 1; i < TOUR.length; i += 1) {
    if (TOUR[i].kind === "act") return i;
  }
  return TOUR.length - 1;
}

/** How many have finished, out of how many, while some have not. */
function finishedCount(input: GuideInput): string | null {
  if (input.tasks.length === 0) return null;
  const done = input.tasks.filter((task) => task.finishedAt !== null).length;
  return `${done} of ${input.tasks.length} finished`;
}

/**
 * The steps, in the order they are taught.
 *
 * Chapter one is the screen: what it is, then the picture, then the record of
 * what obsel did, then the two numbers. About a minute, and somebody who stops
 * here can still read the board, which is the point of splitting it.
 *
 * Chapter two is the demonstration itself, and it is deliberately the real one.
 * The agents that run are real sessions of a coding CLI doing real work, which
 * takes real minutes, and the card shows the count climbing rather than
 * pretending it is quick.
 *
 * Which CLI, and how long it takes, are on the button the card is pointing at,
 * derived there from the runner actually selected. This card does not repeat
 * them: it carries the one thing the button does not say, which is what obsel
 * records as each agent finishes.
 */
export const TOUR: readonly TourStep[] = [
  {
    id: "what",
    chapter: 1,
    kind: "read",
    target: "guide",
    title: "what this screen is",
    body: "Four agents work one after another. Each reads a table the one before it wrote. This screen shows all of them, and marks finished work when the table it was built on has changed since.",
  },
  {
    id: "graph",
    chapter: 1,
    kind: "read",
    target: "graph",
    title: "the agents and their tables",
    body: "A box with a coloured bar down its left edge is an agent. A plain filled box is a table. The arrows show which tables each agent reads and writes. Point at any box to preview it and light the arrows around it; click to pin everything obsel holds about it.",
  },
  {
    id: "trace",
    chapter: 1,
    kind: "read",
    target: "trace",
    title: "what obsel is doing",
    body: "Every step obsel takes appears here as it happens: which table it compared, what it found, and what it marked. None of it is written in advance.",
  },
  {
    id: "numbers",
    chapter: 1,
    kind: "read",
    target: "numbers",
    title: "the two measurements",
    body: "How long obsel took to notice the change, and how many of its marks it has written back into DataHub. Both stay blank until obsel has actually measured them, rather than showing a number from earlier.",
  },
  /*
   * One act where there were two: `register` then `run`.
   *
   * The two buttons behind them became one, so a second act pointing at a
   * button that no longer exists would strand a reader on a step with no way
   * forward -- an act step has no next button by design. A bookmark stored at
   * the retired `register` id no longer matches any step and falls back to the
   * first, which restarts the walk rather than desyncing it, so the stored
   * shape in `use-tour.ts` needs no version bump.
   */
  {
    id: "run",
    chapter: 2,
    kind: "act",
    target: "action",
    launches: ["run", "scale-change-mid"],
    title: "put the agents on the graph and let them work",
    body: "This records which tables each agent reads and writes, then runs them. As each one finishes, obsel writes down exactly what its table looked like at that moment. You can close this window and come back.",
    done: allFinished,
    progress: finishedCount,
  },
  {
    id: "change",
    chapter: 2,
    kind: "act",
    target: "action",
    launches: ["change", "scale-change"],
    title: "now change something upstream",
    body: "One agent is told to rename a column in the table it writes. Nothing that reads that table is told. This is the situation obsel exists for, and it is the one nothing else reports.",
    /*
     * The board first, and the record only where the board has forgotten.
     *
     * Marks standing is the obvious answer and it is not the whole one: a repair
     * takes them off again, so a board that has been changed and then repaired
     * reads exactly like one that was never changed. Without the record a reader
     * who had finished the whole walk would arrive back here, be asked to change
     * something they already had, and have no way forward, because an action step
     * has no next button by design.
     *
     * Same limit as the repair act below: a change driven from a terminal never
     * reaches this server's launcher. It is also the case that leaves marks on
     * the board, so the first half of this answers it anyway.
     */
    done: (input) => {
      if (input.tasks.some((task) => task.stale !== null)) return true;
      // Marks are the loud evidence and they are gone once the repair lands, so
      // this act would read not-done again on a repaired board after a restart
      // took the launcher's record with it. The recorded change survives both.
      if (boardSawAChange(input.tasks)) return true;
      const performed = performedSteps(input.activity);
      return (
        performed.has("change") ||
        performed.has("scale-change") ||
        performed.has("scale-change-mid")
      );
    },
    progress: (input) => (input.activity?.running === null ? null : "working on it"),
  },
  {
    id: "reached",
    chapter: 2,
    kind: "read",
    target: "graph",
    title: "look at what it reached",
    body: "The amber boxes are finished work built on the table that changed. The furthest one never read that table at all. obsel found it by following the links between them, one at a time, and it wrote the reason onto every mark.",
  },
  {
    id: "repair",
    chapter: 2,
    kind: "act",
    target: "action",
    launches: ["repair", "scale-repair"],
    title: "the only way a mark comes off",
    body: "The agents redo the work. A mark clears when the work behind it is genuinely done again, or when a redo comes out identical and proves the work below it was fine. There is no button anywhere that just dismisses one.",
    /*
     * A repaired board is clean and finished. So is a board that merely ran and
     * was never changed. They are the same picture, and what tells them apart is
     * that something was redone.
     *
     * This consulted only the step record until 2026-07-27, and that record does
     * not survive a server restart while the board does, so restarting obsel
     * walked this act backwards on a board that had genuinely been repaired.
     * DataHub's own record of an output moving answers it and survives, and
     * `resetSwarm` nulls it, so pressing reset still puts this act back to
     * not-done along with the board. See `../fingerprints.ts`.
     *
     * The step record stays as the second route: it is the stronger evidence
     * where it exists, because it says the repair itself ran. It also carries
     * the known limit both halves of this act had before, that a repair driven
     * from a terminal never reaches this server's launcher; the board half now
     * covers that case, since a terminal repair still moves an output.
     */
    done: (input) => {
      if (!allFinished(input) || input.tasks.some((task) => task.stale !== null)) return false;
      if (boardSawAChange(input.tasks)) return true;
      const performed = performedSteps(input.activity);
      return performed.has("repair") || performed.has("scale-repair");
    },
    progress: (input) => {
      const left = input.tasks.filter((task) => task.stale !== null).length;
      return left === 0 ? null : `${left} still marked`;
    },
  },
  {
    id: "yours",
    chapter: 2,
    kind: "read",
    target: "joining",
    title: "now with your own agents",
    body: "That is the whole loop. This tab has the one command that connects your own agents to obsel, and the tab beside it takes a table by hand if you would rather not wire anything up yet.",
  },
  /*
   * The second question, and the last thing the tour shows.
   *
   * Last because it is a different obligation from the one the previous ten
   * steps walked through, and because it needs the graph the reader has by now
   * learned to read: the same lineage walk, the same boxes, a different question
   * asked of them.
   *
   * A `read` step. Every act in this tour waits on the board genuinely changing,
   * and opening an erasure request is kept an operator action for the reasons
   * `erasure-tab.tsx` records. An act the board offers no control for could
   * never complete, and would strand a reader at the end of the tour.
   *
   * The wording is held to the same rule as the panel itself: what somebody
   * attested, never what is true.
   */
  {
    id: "erasure",
    chapter: 2,
    kind: "read",
    target: "erasure",
    title: "the same graph, asked a different question",
    body: "obsel walks this graph for a second reason. When somebody asks to have their data erased, it starts from the tables known to hold them and holds every asset it reaches as unattested until a signed attestation says otherwise. This tab reports what each one is, and which ones nobody has spoken for.",
  },
];

/**
 * Which step should be on screen, given where the reader had got to and what
 * the board actually shows.
 *
 * This is the whole honesty rule of the tour, and it works in both directions.
 *
 * **It cannot get ahead of the board.** The position is first pulled back to
 * the first action the board has not done, so the tour can never be asking for
 * a repair on a board with nothing marked. That case is not hypothetical: it is
 * what a reader gets by pressing reset, which really does put every task back to
 * registered, and it is what they get by coming back tomorrow to a board
 * somebody else has cleared.
 *
 * **It cannot lag behind it either.** From there it walks forward past every
 * action already done, so a reader who ran the demonstration this morning, or
 * drove it from a terminal, opens the tour at the act that genuinely comes next.
 *
 * **Explanations are the reader's.** A read step is not something a board can
 * have done, so nothing here moves anybody off one. Somebody reading about the
 * graph stays there whatever the swarm is doing, in both directions: they are
 * never pulled back past it and never pushed forward through it.
 */
export function settledIndex(from: number, input: GuideInput): number {
  const bookmark = Math.max(0, Math.min(from, TOUR.length - 1));

  /*
   * How far the board has got: one step past the last action it has done.
   *
   * The **last** one done rather than the first one not done, and the
   * difference is the whole repair act. A board that has been changed and then
   * repaired is clean and finished, which is exactly what a board that has only
   * ever run looks like — so `change` reads as not-done again the moment the
   * repair lands. Taking the first not-done would therefore drag a reader who
   * has just finished the walk back to "now change something upstream", on a
   * board where they already have.
   */
  let lastDone = -1;
  for (let i = TOUR.length - 1; i >= 0; i -= 1) {
    const step = TOUR[i];
    if (step.kind === "act" && step.done(input)) {
      lastDone = i;
      break;
    }
  }

  /*
   * The ceiling is the next action after that, not the step after it.
   *
   * The explanations in between are the reader's to be past: `reached` sits
   * between the change and the repair, and somebody who has read it should be
   * allowed to sit on the repair. Only the next *action* is a wall, because that
   * is the thing the board has not done.
   */
  const ceiling = nextActAfter(lastDone);

  let at = Math.min(bookmark, ceiling);
  while (at < TOUR.length - 1) {
    const step = TOUR[at];
    if (step.kind !== "act" || !step.done(input)) break;
    at += 1;
  }
  return at;
}
