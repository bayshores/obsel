/**
 * Which buttons a board offers, and the walk they belong to.
 *
 * A button launches one specific pipeline, so a board holding a different swarm
 * must not be offered it. Recognition is by the pipelines' own task names. The
 * tour's boundary is here for the same reason: what counts as this walk's
 * evidence is everything since the last reset, and nothing before it.
 */

import { describe, expect, it } from "vitest";

import { STEP_NAME, guide, sinceReset } from "@/src/features/dashboard/guide/guide";
import { TOUR, settledIndex } from "@/src/features/dashboard/tour/steps";
import type { GuideInput } from "@/src/features/dashboard/guide/guide";
import type { TaskRecord } from "@/src/server/coordinator/types";
import type { RunnerCheck } from "@/src/server/runner/types";
import {
  FOUR_COMPLETE,
  activity,
  ds,
  failed,
  input,
  mark,
  ok,
  ran,
  runnerOk,
  task,
} from "./support/guide-fixtures";

describe("the taxi swarm gets its own buttons, recognised by its own task names", () => {
  // Markers, never counts: recognition is the pipelines' task names, so a
  // judge's own agents joined over MCP change nothing, and a mixed board
  // resolves to the swarm whose buttons cannot touch the other's tables.
  const taxiTask = (name: string, overrides: Partial<TaskRecord> = {}) =>
    task(name, {
      urn: `urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),${name})`,
      ...overrides,
    });
  const TAXI_REGISTERED = [
    taxiTask("clean_trips", { status: "registered", finishedAt: null }),
    taxiTask("daily_trips", { status: "registered", finishedAt: null }),
    taxiTask("city_week", { status: "registered", finishedAt: null }),
  ];

  it("registered offers the run whose requirement changes partway", () => {
    const view = guide(input({ tasks: TAXI_REGISTERED }));
    expect(view.stage).toBe("registered");
    expect(view.actions.map((action) => action.step)).toEqual([
      "scale-change-mid",
      "scale-register",
    ]);
  });

  it("settled offers the requirement change, without promising counts", () => {
    const view = guide(
      input({ tasks: [taxiTask("clean_trips"), taxiTask("daily_trips"), taxiTask("city_week")] }),
    );
    expect(view.stage).toBe("settled");
    expect(view.actions.map((action) => action.step)).toEqual(["scale-change"]);
    // The label rule the demo buttons already follow: a count in a button is a
    // promise the board cannot keep once an outside agent joins the swarm.
    expect(/\b(nine|thirty|forty)\b/i.test(view.actions[0].detail)).toBe(false);
  });

  it("flagged leads with the parallel repair and keeps no demo-specific button", () => {
    const view = guide(
      input({
        tasks: [
          taxiTask("clean_trips"),
          taxiTask("daily_trips"),
          taxiTask("city_week", { status: "stale", stale: mark({ causedBy: ds("daily_trips") }) }),
        ],
      }),
    );
    expect(view.stage).toBe("flagged");
    expect(view.actions.map((action) => action.step)).toEqual(["scale-repair", "reset"]);
  });

  it("a swarm that is neither pipeline gets no pipeline-specific buttons on the flagged board", () => {
    const view = guide(
      input({
        tasks: [
          task("their_ingest"),
          task("their_report", { status: "stale", stale: mark({ causedBy: ds("their_ingest") }) }),
        ],
      }),
    );
    expect(view.stage).toBe("flagged");
    /*
     * Reset alone, and this used to be the demo's three buttons.
     *
     * The old assertion only forbade the TAXI buttons here and recorded the
     * demo's as a fallback that was "honest only while its labels name their
     * own scope". They do not: "Run the orders cleaner again" on a board with
     * no orders cleaner names a scope that is not on screen, and "Redo the work
     * obsel flagged" would start the demo's agents against the demo's tables
     * while pointing at somebody else's flag.
     *
     * Reset survives because `resetSwarm` puts every task on the flow back to
     * registered, whoever registered it, so it means exactly what it says on
     * any board. The redo this board needs is reporting the table again, which
     * is what the table form under the graph is for.
     */
    expect(view.actions.map((action) => action.step)).toEqual(["reset"]);
  });

  it("a swarm that is neither pipeline is offered nothing to launch when it settles", () => {
    const view = guide(input({ tasks: [task("their_ingest"), task("their_report")] }));
    expect(view.stage).toBe("settled");
    expect(view.actions).toEqual([]);
    // And the line has to replace what the buttons were saying, or the board
    // reaches its most interesting state with no idea what to do next.
    expect(view.subline).toBe("Change a column in one of your tables below and report it again");
  });

  it("a swarm that is neither pipeline is offered nothing to launch before it runs", () => {
    // The stage where the demo would otherwise offer "Start the demo agents" on
    // a board holding none of them.
    const view = guide(
      input({
        tasks: [
          task("their_ingest", { status: "registered", finishedAt: null }),
          task("their_report", { status: "registered", finishedAt: null }),
        ],
      }),
    );
    expect(view.stage).toBe("registered");
    expect(view.actions).toEqual([]);
    expect(view.headline).toBe("2 agents ready to run");
  });
});

describe("the run button says which agent product is about to start", () => {
  /*
   * The one sentence on the board that tells somebody what is about to happen on
   * their machine, and for a long time it said Codex whatever was installed.
   *
   * It is derived from the same preflight field the checklist row uses, so the
   * two cannot disagree. The third case is the one with no answer yet: naming a
   * product nobody has installed would be a guess, and "four real agent
   * sessions" is true without being one.
   */
  const REGISTERED = [
    task("clean_orders", { status: "registered", finishedAt: null }),
    task("build_revenue", { status: "registered", finishedAt: null }),
    task("write_report", { status: "registered", finishedAt: null }),
    task("write_docs", { status: "registered", finishedAt: null }),
  ];

  function detailFor(runner: RunnerCheck): string {
    const view = guide(
      input({
        tasks: REGISTERED,
        activity: activity({
          preflight: {
            datahub: ok(),
            vocabulary: ok(),
            venv: ok(),
            uvx: ok(),
            runner,
            token: ok(),
          },
        }),
      }),
    );
    expect(view.stage).toBe("registered");
    const start = view.actions.find((action) => action.step === "run");
    if (start === undefined) throw new Error("the registered stage offered no run button");
    return start.detail;
  }

  it("names Codex when Codex is the runner", () => {
    expect(detailFor(runnerOk("codex"))).toBe("Four real Codex sessions. Takes a few minutes.");
  });

  it("names Claude Code when Claude Code is the runner", () => {
    expect(detailFor(runnerOk("claude"))).toBe(
      "Four real Claude Code sessions. Takes a few minutes.",
    );
  });

  it("names neither when the check could not find one, and still reads as a sentence", () => {
    // Reached when the activity read itself failed, so there is no preflight to
    // ask. "Four real an agent CLI sessions" is what a single shared label
    // produced, which is why the product word is separate from the row's.
    const view = guide(input({ tasks: REGISTERED, activity: null }));
    const start = view.actions.find((action) => action.step === "run");
    expect(start?.detail).toBe("Four real agent sessions. Takes a few minutes.");
  });
});

/**
 * The tour, and the one property that makes it trustworthy: **it cannot get
 * ahead of the board.**
 *
 * Three guides came before it, all of them status displays, and the reason this
 * one is different is that its second chapter is not a script anybody can page
 * through. An action step advances when the board itself shows the action
 * happened, and never because somebody pressed next. These tests are that rule,
 * one situation at a time.
 *
 * Everything here is `settledIndex`, which is the whole reconciliation: given
 * where the reader's bookmark says they were, and the board as it actually is,
 * which step should be on screen.
 */
describe("the tour", () => {
  const REGISTERED = FOUR_COMPLETE.map((each) => ({
    ...each,
    status: "registered" as const,
    finishedAt: null,
  }));

  const FLAGGED = [
    task("clean_orders"),
    task("build_revenue", { status: "stale", stale: mark() }),
    task("write_report", { status: "stale", stale: mark({ hops: 2 }) }),
  ];

  /** The step a reader would be looking at, by id, from a given bookmark. */
  function showing(from: number, over: Partial<GuideInput> = {}): string {
    return TOUR[settledIndex(from, input(over))].id;
  }

  /** Where the run chapter starts, so the tests below name it once. */
  const FIRST_ACT = TOUR.findIndex((step) => step.kind === "act");

  it("teaches the screen first, and the run after", () => {
    expect(TOUR.filter((step) => step.chapter === 1).map((step) => step.id)).toEqual([
      "what",
      "graph",
      "trace",
      "numbers",
    ]);
    expect(TOUR.filter((step) => step.chapter === 2).map((step) => step.id)).toEqual([
      // One act declares the agents and runs them, because the two buttons
      // behind it became one.
      "run",
      "change",
      "reached",
      "repair",
      "yours",
      // The erasure tab, last, because it asks a different question of the same
      // graph and needs the graph the previous ten steps taught the reader to
      // read. A `read` step: the board offers no control that opens a request,
      // for the reasons `erasure-tab.tsx` records, so an act here could never
      // complete.
      "erasure",
    ]);
  });

  /*
   * The explanations are the reader's, entirely. Nothing about the board may
   * move them along or hold them back: somebody reading about the graph on a
   * fully flagged board stays on that card until they press next.
   */
  it("never moves a reader off an explanation", () => {
    for (const at of [0, 1, 2, 3]) {
      expect(showing(at, { tasks: FLAGGED })).toBe(TOUR[at].id);
      expect(showing(at, { tasks: [] })).toBe(TOUR[at].id);
    }
  });

  it("waits on the first action until every agent has finished", () => {
    // Registering is no longer a step of its own, so a board with tasks on it
    // and nothing finished is still waiting on the same act.
    expect(showing(FIRST_ACT, { tasks: [] })).toBe("run");
    expect(showing(FIRST_ACT, { tasks: REGISTERED })).toBe("run");
    // And the moment the work is done it moves on by itself, with nobody
    // pressing anything: the board is the only thing that can advance an act.
    expect(showing(FIRST_ACT, { tasks: FOUR_COMPLETE })).toBe("change");
  });

  it("waits through the run and moves on when every agent has finished", () => {
    const halfway = [FOUR_COMPLETE[0], ...REGISTERED.slice(1)];
    expect(showing(FIRST_ACT, { tasks: halfway })).toBe("run");
    expect(showing(FIRST_ACT, { tasks: FOUR_COMPLETE })).toBe("change");
  });

  it("moves on from the change only once something is marked", () => {
    expect(showing(FIRST_ACT, { tasks: FOUR_COMPLETE })).toBe("change");
    // Stops at `reached`, which is an explanation: the reader is given a beat
    // to look at what obsel marked before being asked to do anything else.
    expect(showing(FIRST_ACT, { tasks: FLAGGED })).toBe("reached");
  });

  it("asks for the repair while anything is still marked", () => {
    const at = TOUR.findIndex((step) => step.id === "repair");
    expect(showing(at, { tasks: FLAGGED })).toBe("repair");
  });

  /*
   * A reader who has read the explanation between the change and the repair is
   * allowed to sit on the repair. Only the next *action* is a wall, because that
   * is the thing the board has not done; the explanations in between are theirs.
   */
  it("lets a reader past the explanation that sits between two actions", () => {
    const reached = TOUR.findIndex((step) => step.id === "reached");
    expect(showing(reached, { tasks: FLAGGED })).toBe("reached");
    expect(showing(reached + 1, { tasks: FLAGGED })).toBe("repair");
  });

  /*
   * The reason chapter two stores nothing. A reader who ran the demonstration
   * yesterday, drove it from a terminal, or reloaded halfway through opens the
   * tour at the act that genuinely comes next, not at whichever card they last
   * closed it on.
   */
  it("fast-forwards a bookmark that the board has already overtaken", () => {
    expect(showing(FIRST_ACT, { tasks: FLAGGED })).toBe("reached");
  });

  it("never runs off either end, whatever the bookmark says", () => {
    const board = input({ tasks: FOUR_COMPLETE });
    expect(settledIndex(99, board)).toBeLessThanOrEqual(TOUR.length - 1);
    expect(settledIndex(-4, board)).toBe(0);
  });

  /*
   * The case that only shows up after a full walk, and the one that would have
   * ruined the demonstration: a repaired board is clean and finished, which is
   * exactly what a board that only ever ran looks like. Without the record, the
   * change would read as undone again the moment the repair landed and the tour
   * would drag a reader who had just finished back to "now change something".
   */
  it("stays at the end after a repair, rather than asking for the change again", () => {
    const walked = input({
      tasks: FOUR_COMPLETE,
      activity: activity({ history: ran("register", "run", "change", "repair") }),
    });
    expect(TOUR[settledIndex(TOUR.length - 1, walked)].id).toBe("erasure");

    // And the same board with nothing behind it is at the change, because that
    // is genuinely what has not happened on it.
    expect(showing(TOUR.length - 1, { tasks: FOUR_COMPLETE })).toBe("change");
  });

  /*
   * A reset really does put every task back to registered, so the tour has to
   * walk back with it. It does, without being told, because nothing about
   * where it had got to was written down.
   */
  it("walks back to the run when the board is reset", () => {
    const after = TOUR.findIndex((step) => step.id === "repair");
    expect(showing(after, { tasks: REGISTERED })).toBe("run");
  });

  it("does not count a step that failed", () => {
    // The board is what counts, and a step that fell over left nothing on it.
    // The step record cannot advance the tour at all, which is why a failed run
    // and a run nobody started are the same situation here.
    const failedRun = input({
      tasks: [],
      activity: activity({ history: [...ran("register"), failed("run")] }),
    });
    expect(TOUR[settledIndex(FIRST_ACT, failedRun)].id).toBe("run");
  });

  /*
   * The boundary everything about repeatability rests on. `performedSteps` is
   * built on this, and it is the reason pressing reset genuinely puts the repair
   * act back to not-done rather than leaving a record of one from a walk that
   * has since been undone.
   */
  it("counts only what ran since the last reset, including the reset itself", () => {
    const history = [...ran("register", "run", "change", "repair", "reset", "run")];
    expect(sinceReset(history).map((result) => result.step)).toEqual(["reset", "run"]);

    // A reset that failed did not reset anything, so it does not begin a walk.
    const broken = [...ran("register", "run"), failed("reset"), ...ran("change")];
    expect(sinceReset(broken).map((result) => result.step)).toEqual([
      "register",
      "run",
      "reset",
      "change",
    ]);
  });

  it("reads the taxi swarm's board the same way", () => {
    // Different pipeline, different button names, same four questions: is
    // anything registered, has it all finished, is anything marked, is it clean
    // again. The card quotes whichever button the guide is offering.
    const taxi = [task("daily_trips"), task("clean_trips", { status: "stale", stale: mark() })];
    expect(showing(FIRST_ACT, { tasks: taxi })).toBe("reached");
  });

  it("every step says something, in plain words", () => {
    for (const step of TOUR) {
      expect(step.title.length, step.id).toBeGreaterThan(0);
      expect(step.body.length, step.id).toBeGreaterThan(0);
      // The vocabulary rule this repository keeps everywhere else. These are the
      // words a newcomer has no way to look up, and the guide is the one place
      // on the board where reaching for them is most tempting.
      for (const jargon of ["cascade", "lineage", "urn", "fingerprint", "downstream"]) {
        expect(step.body.toLowerCase(), `${step.id} says "${jargon}"`).not.toContain(jargon);
        expect(step.title.toLowerCase(), `${step.id} says "${jargon}"`).not.toContain(jargon);
      }
    }
  });

  it("every action step names at least one real demo step", () => {
    // The card reads its label off the guide's live action list by matching
    // these. A step naming one the launcher does not have would render an action
    // card with no button behind it and no way to advance.
    for (const step of TOUR) {
      if (step.kind !== "act") continue;
      expect(step.launches.length, step.id).toBeGreaterThan(0);
      for (const launch of step.launches) {
        expect(Object.keys(STEP_NAME), step.id).toContain(launch);
      }
    }
  });
});
