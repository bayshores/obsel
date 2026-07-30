/**
 * The guide is a lens on observed state, never a stored script position.
 *
 * The tests that matter most are the awkward combinations: a step failing
 * behind the user's back, a stale task that is simultaneously re-running, the
 * machine broken while DataHub is fine. Each must land on the honest stage.
 */

import { describe, expect, it } from "vitest";

import { guide } from "@/src/features/dashboard/guide";
import type { TaskRecord } from "@/src/server/coordinator/types";
import type { StepResult } from "@/src/server/runner/types";
import {
  AT,
  FOUR_COMPLETE,
  activity,
  allText,
  changed,
  ds,
  identicalRerun,
  input,
  mark,
  ok,
  ran,
  runnerOk,
  task,
} from "./support/guide-fixtures";

describe("stage derivation", () => {
  it("connect when the swarm read is not trusted, whatever else is true", () => {
    const view = guide(input({ trusted: false, tasks: FOUR_COMPLETE }));
    expect(view.stage).toBe("connect");
    expect(view.actions).toEqual([]);
  });

  it("connect quotes the observed DataHub failure and its fix when preflight saw one", () => {
    const view = guide(
      input({
        trusted: false,
        activity: activity({
          preflight: {
            datahub: {
              ok: false,
              detail: "nothing answered at http://localhost:8080/config",
              fix: "datahub docker quickstart",
            },
            vocabulary: { ok: false, detail: "cannot be checked until DataHub answers", fix: null },
            venv: ok(),
            uvx: ok(),
            runner: runnerOk(),
          },
        }),
      }),
    );
    expect(allText(view)).toContain("nothing answered");
    expect(allText(view)).toContain("datahub docker quickstart");
  });

  /*
   * The runner row, in all three states it can be in.
   *
   * Two runners and a neither, because they go down one code path and the row's
   * subject is the part that is derived. A version of this test fixed to Codex
   * passed while the row printed `codex login` at somebody running Claude Code,
   * whose actual fix is a different command.
   */
  const RUNNER_ROWS = [
    {
      name: "Codex signed out",
      check: {
        ok: false,
        detail: "the Codex CLI is not signed in",
        fix: "codex login",
        name: "codex" as const,
      },
      says: "The Codex CLI, signed in",
      offers: "codex login",
      omits: "claude auth login",
    },
    {
      name: "Claude Code signed out",
      check: {
        ok: false,
        detail: "Claude Code is not signed in",
        fix: "claude auth login",
        name: "claude" as const,
      },
      says: "Claude Code, signed in",
      offers: "claude auth login",
      omits: "codex login",
    },
    {
      name: "neither installed",
      check: {
        ok: false,
        detail: "Neither the Codex CLI nor Claude Code is installed",
        fix: null,
        name: null,
      },
      says: "An agent CLI, signed in",
      // No command, because there is nothing to sign into until a product is
      // chosen, and naming one would send the reader to install the wrong one.
      offers: null,
      omits: "codex login",
    },
  ];

  for (const row of RUNNER_ROWS) {
    it(`prepare when the machine is broken while the swarm reads fine: ${row.name}`, () => {
      const view = guide(
        input({
          tasks: FOUR_COMPLETE,
          activity: activity({
            preflight: {
              datahub: ok(),
              vocabulary: ok(),
              venv: ok(),
              uvx: ok(),
              runner: row.check,
            },
          }),
        }),
      );
      expect(view.stage).toBe("prepare");
      expect(allText(view)).toContain(row.says);
      if (row.offers !== null) expect(allText(view)).toContain(row.offers);
      expect(allText(view)).not.toContain(row.omits);
    });
  }

  it("holds the board on prepare when uv is missing, which nothing else would report", () => {
    // The quietest prerequisite: with uv absent the engine still finds every
    // affected task and the tag write is the only thing that fails, so a board
    // that let this through would look correct and record nothing.
    const view = guide(
      input({
        tasks: FOUR_COMPLETE,
        activity: activity({
          preflight: {
            datahub: ok(),
            vocabulary: ok(),
            venv: ok(),
            uvx: {
              ok: false,
              detail: "obsel writes its tag through DataHub's own MCP server",
              fix: "brew install uv",
            },
            runner: runnerOk(),
          },
        }),
      }),
    );
    expect(view.stage).toBe("prepare");
    expect(view.checks.map((check) => check.name)).toContain(
      "uv, which obsel writes that tag through",
    );
    expect(allText(view)).toContain("brew install uv");
  });

  it("prepare offers setup as a button only when the venv can actually launch it", () => {
    const missingVocabulary = {
      datahub: ok(),
      vocabulary: {
        ok: false,
        detail: "the tag does not exist yet",
        fix: "agents/.venv/bin/python -m agents.run setup",
      },
      venv: ok(),
      uvx: ok(),
      runner: runnerOk(),
    };
    const withVenv = guide(input({ activity: activity({ preflight: missingVocabulary }) }));
    expect(withVenv.actions.map((action) => action.step)).toEqual(["setup"]);

    const withoutVenv = guide(
      input({
        activity: activity({
          preflight: {
            ...missingVocabulary,
            venv: {
              ok: false,
              detail: "agents/.venv does not exist",
              fix: "python3 -m venv agents/.venv",
            },
          },
        }),
      }),
    );
    expect(withoutVenv.actions).toEqual([]);
    expect(allText(withoutVenv)).toContain("python3 -m venv agents/.venv");
  });

  it("an unreadable activity feed never blocks the journey — unknown is not broken", () => {
    const view = guide(input({ activity: null, tasks: [] }));
    expect(view.stage).toBe("empty");
    expect(view.actions.map((action) => action.step)).toEqual([
      "run",
      "scale-change-mid",
      // The third door launches nothing, so it carries no step.
      undefined,
    ]);
  });

  it("empty offers both pipelines and the door for an agent somebody already has", () => {
    // The only stage with no graph on screen, so the only one that describes the
    // pipeline in words instead of drawing it. One button per pipeline: setting
    // the agents up is not a thing anybody wants done on its own, so `run`
    // declares whatever obsel has no record of and then runs.
    const view = guide(input({ tasks: [] }));
    expect(view.stage).toBe("empty");
    expect(view.actions.map((action) => action.step)).toEqual([
      "run",
      "scale-change-mid",
      undefined,
    ]);
    expect(allText(view)).toContain("No agents yet");
    expect(allText(view)).toContain("Each one reads a table that another one writes");
    expect(allText(view)).toContain("Declares them in DataHub, then runs them");
  });

  it("offers the bring-your-own door as a reveal, not as something obsel runs", () => {
    /*
     * The distinction the union exists for. The two demo buttons spawn agent
     * sessions on this machine; this one moves the reader to a panel that is
     * already there. A `step` on it would have the launcher try to run a step
     * called "joining", and the allowlist would refuse it.
     */
    const view = guide(input({ tasks: [] }));
    const door = view.actions.find((action) => action.reveal !== undefined);

    expect(door?.reveal).toBe("joining");
    expect(door?.step).toBeUndefined();
    // Never the accented one: the stage's sentence is about the demo agents.
    expect(door?.primary).toBeUndefined();
    expect(door?.label).toBe("Bring an agent you already have");
  });

  it("keeps the bring-your-own door off every stage that has a graph", () => {
    // It is an answer to "what is obsel for", which is only a live question on the
    // one screen with nothing on it. On a board with agents the tabs are the way
    // there, and a fourth button repeating one would be noise.
    for (const tasks of [
      [task("clean_orders", { status: "registered", finishedAt: null })],
      [task("clean_orders", { status: "complete" })],
    ]) {
      const view = guide(input({ tasks }));
      expect(view.actions.some((action) => action.reveal !== undefined)).toBe(false);
    }
  });

  it("registered counts the agents and points at the list rather than repeating it", () => {
    const view = guide(
      input({
        tasks: [
          task("clean_orders", {
            status: "registered",
            finishedAt: null,
            title: "Orders cleaner",
            description: "cleans the raw orders export into a tidy four-column table",
          }),
          task("build_revenue", {
            status: "registered",
            finishedAt: null,
            reads: [ds("clean_orders")],
            writes: [ds("daily_revenue")],
          }),
        ],
      }),
    );
    expect(view.stage).toBe("registered");
    expect(allText(view)).toContain("2 agents ready to run");

    /*
     * The roster must NOT be here. This stage used to push one
     * `Title, what it does` line per task. The graph draws all of them, with
     * their names and the tables between them, so a list in prose above it was
     * the same facts a second time in the slower medium. Asserting the absence is
     * the point of the test: nothing else fails if the duplication comes back.
     */
    const prose = allText(view);
    expect(prose).not.toContain("cleans the raw orders export");
    expect(prose).not.toContain("reads clean orders");
    // What it does carry is the one fact the graph cannot draw.
    expect(prose).toContain("obsel records what its table looked like");

    // Run leads; re-declare is reachable here because the empty stage never
    // recurs on a DataHub that has seen the pipeline before.
    expect(view.actions.map((action) => action.step)).toEqual(["run", "register"]);
  });

  it("a partial swarm — some finished, some not, nothing running — is registered with honest counts", () => {
    const view = guide(
      input({
        tasks: [
          task("clean_orders"),
          task("build_revenue", { status: "registered", finishedAt: null }),
        ],
      }),
    );
    expect(view.stage).toBe("registered");
    expect(allText(view)).toContain("1 of 2");
    // No re-declare once anything has finished: register resets every task's
    // status, which would demote finished work below the cascade's notice.
    expect(view.actions.map((action) => action.step)).toEqual(["run"]);
  });

  it("working while any task runs, with the elapsed the snapshot supports", () => {
    const view = guide(
      input({
        tasks: [
          task("clean_orders", {
            status: "running",
            finishedAt: null,
            startedAt: "2026-07-22T09:00:00.000Z",
          }),
          task("build_revenue", { status: "registered", finishedAt: null }),
        ],
      }),
    );
    expect(view.stage).toBe("working");
    expect(allText(view)).toContain("10.0 s in");
    expect(view.actions).toEqual([]);
  });

  it("working narrates no elapsed when startedAt is missing, rather than inventing one", () => {
    const view = guide(
      input({
        tasks: [
          task("clean_orders", {
            status: "running",
            finishedAt: null,
            title: "Orders cleaner",
          }),
        ],
      }),
    );
    expect(view.stage).toBe("working");
    expect(allText(view)).not.toMatch(/\d+\.\d+ s in/);
    expect(allText(view)).toContain("Orders cleaner is working");
  });

  it("a stale task that is re-running lands on working, because running wins", () => {
    /*
     * This used to also assert a "1 finished task(s) still carry their mark"
     * line. That line is gone from the guide, not from the board: a mark held by
     * work that is not itself stale renders as an amber OUTLINE on the node,
     * which is the rule `nodeTone` enforces and `dashboard-layout.test.ts` covers.
     * The guide stating it again was the same fact in the slower medium.
     */
    const view = guide(
      input({
        tasks: [
          task("clean_orders", { status: "running", finishedAt: null }),
          task("build_revenue", { status: "stale", stale: mark() }),
        ],
      }),
    );
    expect(view.stage).toBe("working");
    expect(view.actions).toEqual([]);
    expect(allText(view)).toContain("obsel waits until an agent finishes");
  });

  it("settled offers the two experiments once everything finished clean", () => {
    const view = guide(input({ tasks: FOUR_COMPLETE }));
    expect(view.stage).toBe("settled");
    /*
     * The change leads, and it did not until 2026-07-27.
     *
     * The reason for the order is symmetry with the taxi board rather than
     * taste: settled-taxi offers exactly one experiment and it is its change.
     * With the demo leading on the identical re-run, one stage taught two
     * different lessons depending on which swarm was on screen. The re-run is a
     * control experiment, and a control only means something to a reader who
     * already expects the other result, so it follows rather than leads.
     */
    expect(view.actions.map((action) => action.step)).toEqual(["change", "rerun-same"]);
    expect(view.actions.filter((action) => action.primary === true)).toHaveLength(1);
    expect(view.actions[0]?.primary).toBe(true);
  });

  /*
   * The bug these were written for, in the reporter's words: "why does it seem
   * like we always return to the same state when I boot obsel back on? there's
   * no option to redo."
   *
   * The board is DataHub's and survives a restart. The launcher's record of what
   * ran is this server's and does not. `walked` asked only the record, so
   * restarting obsel took the reset button off a board that had genuinely been
   * all the way round, with nothing about the board having changed.
   */
  describe("a walked board still reads as walked after a restart", () => {
    const WALKED = [changed("clean_orders"), task("build_revenue"), task("write_docs")];

    it("offers reset with an empty launcher history, which is what a restart leaves", () => {
      const view = guide(input({ tasks: WALKED, activity: activity({ history: [] }) }));
      expect(view.stage).toBe("settled");
      expect(view.actions.map((action) => action.step)).toContain("reset");
    });

    it("offers reset with no activity read at all", () => {
      // A server that has just started has not answered the activity poll yet.
      const view = guide(input({ tasks: WALKED, activity: null }));
      expect(view.actions.map((action) => action.step)).toContain("reset");
    });

    it("still withholds reset from a board that has only ever run", () => {
      // The gate is not being dropped, only re-evidenced. A board nobody has
      // changed is offered the experiments, not a button that undoes them.
      const view = guide(input({ tasks: FOUR_COMPLETE, activity: activity({ history: [] }) }));
      expect(view.stage).toBe("settled");
      expect(view.actions.map((action) => action.step)).not.toContain("reset");
    });

    it("does not count an identical re-run as having been round", () => {
      /*
       * The one case obsel exists to stay quiet about, and the one a check for
       * the key's presence rather than the hashes would get wrong. `engine.ts`
       * does not write a previous entry for an unchanged output at all, so this
       * board is stricter than a real one, which is the right direction.
       */
      const view = guide(
        input({
          tasks: [identicalRerun("clean_orders"), task("build_revenue")],
          activity: activity({ history: [] }),
        }),
      );
      expect(view.actions.map((action) => action.step)).not.toContain("reset");
    });

    it("forgets both routes after a reset", () => {
      // `resetSwarm` nulls the recorded previous fingerprints, and `sinceReset`
      // drops the history. If either half stopped clearing, the board would keep
      // offering to start over on a board that already had.
      const view = guide(
        input({
          tasks: FOUR_COMPLETE,
          activity: activity({ history: ran("register", "run", "change", "repair", "reset") }),
        }),
      );
      expect(view.actions.map((action) => action.step)).not.toContain("reset");
    });

    it("keeps the launcher's record as a second route, not a replacement", () => {
      // A repair that ran here counts even with nothing on the board to show for
      // it, which is the case a board-only signal would have lost.
      const view = guide(
        input({
          tasks: FOUR_COMPLETE,
          activity: activity({ history: ran("register", "run", "change", "repair") }),
        }),
      );
      expect(view.actions.map((action) => action.step)).toContain("reset");
    });
  });

  it("flagged counts the marks and calls out the transitive reach, without narrating the screen", () => {
    const view = guide(
      input({
        tasks: [
          task("clean_orders", { title: "Orders cleaner" }),
          task("build_revenue", {
            status: "stale",
            title: "Daily revenue",
            stale: mark({ hops: 1 }),
          }),
          task("write_report", {
            status: "stale",
            title: "Revenue report",
            stale: mark({ hops: 2 }),
          }),
          task("write_docs", { status: "stale", title: "Table docs", stale: mark({ hops: 2 }) }),
        ],
      }),
    );
    expect(view.stage).toBe("flagged");
    const text = allText(view);
    expect(text).toContain("3 of 4 finished agents are out of date");
    /*
     * It must NOT describe the screen, and it must NOT list the affected tasks.
     *
     * Two paragraphs used to do both: one pointing at the ledger's recorded
     * reasons, one naming the transitively marked tasks and explaining why
     * lineage matters. The graph now shows that reach directly, as an amber path
     * travelling outward from the changed table through each hop, continuously.
     */
    expect(text).not.toContain("ledger below");
    expect(text).not.toContain("never read the changed table");
    // Code identifiers never reach the screen, whatever the stage says.
    expect(text).not.toContain("write_report");
    expect(text).not.toContain("clean_orders");
    // The subline names the changed table, in words.
    expect(text).toContain("clean orders");
    // The repair leads, because it is the answer to the question a flagged
    // board asks. The identical re-run stays available — proving no new marks
    // arrive and the existing three stay put — alongside reset. `change` does
    // not: re-issuing the same changed job proves nothing further.
    expect(view.actions.map((action) => action.step)).toEqual(["repair", "rerun-same", "reset"]);
  });

  it("the repair action says what earns a flag off, without promising a wipe", () => {
    const view = guide(
      input({
        tasks: [
          task("clean_orders", { title: "Orders cleaner" }),
          task("build_revenue", { status: "stale", stale: mark({ hops: 1 }) }),
        ],
      }),
    );
    const repair = view.actions.find((action) => action.step === "repair");
    expect(repair).toBeDefined();
    // Imperative and concrete, like every other button.
    expect(repair?.label).toBe("Redo the work obsel flagged");
    /*
     * The detail carries the one rule that makes repair different from a reset:
     * flags come off through redone work, and an identical redo is itself the
     * proof that clears what was built on it. It must not read as "this button
     * clears the flags" — nothing clears a flag except a redo, and wording that
     * implies otherwise would promise the exact tool obsel refuses to be.
     */
    expect(repair?.detail).toContain("redo it in order");
    expect(repair?.detail).toContain("identical");
    expect(repair?.detail).not.toContain("removes");
    expect(repair?.detail).not.toContain("wipes");
  });

  it("flagged omits the detection timing when the mark carries none — never a fabricated number", () => {
    const view = guide(
      input({
        tasks: [task("build_revenue", { status: "stale", stale: mark({ detectedMs: null }) })],
      }),
    );
    const text = allText(view);
    expect(text).not.toContain("null");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("marked in");
  });
});

describe("a board holding exactly one task", () => {
  /*
   * The count every stage was written without.
   *
   * obsel's own demonstrations register four tasks or forty, so a count of one
   * never reached a stage until the board grew a form that registers one task at
   * a time. "1 agents ready to run" was on a real screen. Zero, four and forty
   * all pass a sentence written for the plural, which is why every stage that
   * counts something is checked here at one, and not only the stage that broke.
   */
  const one = (overrides: Partial<TaskRecord> = {}) => [task("clean_orders", overrides)];

  it("empty cannot be reached at one task, and its zero stays plural", () => {
    // Listed for completeness: `empty` is the stage where the swarm holds
    // nothing, so it has no count of one to get wrong. English wants the plural
    // for zero, which is what it already says.
    expect(guide(input({ tasks: [] })).headline).toBe("No agents yet");
  });

  it("registered says one agent, not one agents", () => {
    const view = guide(input({ tasks: one({ status: "registered", finishedAt: null }) }));
    expect(view.stage).toBe("registered");
    expect(view.headline).toBe("1 agent ready to run");
  });

  it("registered reads as a ratio, and agrees its noun with the swarm", () => {
    // Two tasks, one finished. This branch printed no noun at all — "1 of 2
    // finished", one of two what — while the flagged headline two acts later
    // said "finished agents". The noun agrees with the swarm rather than with
    // the count, which is what the sentence is about.
    const view = guide(
      input({
        tasks: [task("clean_orders"), task("build_revenue", { finishedAt: null })],
      }),
    );
    expect(view.headline).toBe("1 of 2 agents finished");
  });

  it("settled words the whole-swarm claim rather than saying all of one", () => {
    const view = guide(input({ tasks: one() }));
    expect(view.stage).toBe("settled");
    expect(view.headline).toBe("the one agent finished, nothing out of date");
    expect(view.headline).not.toContain("all 1");
  });

  it("flagged agrees its noun with the finished count and its verb with the marked count", () => {
    const view = guide(input({ tasks: one({ status: "stale", stale: mark() }) }));
    expect(view.stage).toBe("flagged");
    expect(view.headline).toBe("1 of 1 finished agent is out of date");
  });

  it("flagged keeps the plural noun when one of several finished agents is marked", () => {
    // The half of the rule a single ternary keyed to the marked count gets wrong:
    // the noun counts the finished work, so it stays plural here while the verb
    // goes singular.
    const view = guide(
      input({
        tasks: [
          task("clean_orders"),
          task("write_report"),
          task("build_revenue", { status: "stale", stale: mark() }),
        ],
      }),
    );
    expect(view.headline).toBe("1 of 3 finished agents is out of date");
  });

  it("the re-run button points at one mark with a demonstrative, not with a bare 1", () => {
    /*
     * Two tasks, not `one()`, and the difference is not incidental. The button
     * under test is the demo's own re-run, and `swarmKind` only recognises the
     * demo by seeing both `clean_orders` and `build_revenue` — a lone
     * `clean_orders` is an unknown swarm and correctly gets no pipeline
     * buttons at all.
     *
     * The wording this test is about keys off the MARKED count rather than the
     * task count, so one mark on a two-task board exercises exactly the branch
     * it always did.
     */
    const view = guide(
      input({
        tasks: [task("clean_orders"), task("build_revenue", { status: "stale", stale: mark() })],
      }),
    );
    const rerun = view.actions.find((action) => action.step === "rerun-same");
    expect(rerun?.detail).toBe("Nothing new should go out of date, and this one should stay.");
  });

  it("working already named the single agent, and still does", () => {
    // Not a fix, a guard. This stage takes the one-task path deliberately, and a
    // sweep that replaced every count with a plural helper could undo it.
    const view = guide(
      input({ tasks: one({ status: "running", finishedAt: null, title: "Orders cleaner" }) }),
    );
    expect(view.stage).toBe("working");
    expect(view.headline).toContain("Orders cleaner is working");
    expect(view.headline).not.toContain("1 agent");
  });

  it("no stage puts a number next to a word that disagrees with it", () => {
    /*
     * The sweep the individual cases above cannot do. Any stage reachable with a
     * single task gets its whole text scanned for `1 <plural noun>`, so a count
     * added to a sentence later fails here rather than in a browser.
     */
    const boards: { name: string; tasks: TaskRecord[] }[] = [
      { name: "registered", tasks: one({ status: "registered", finishedAt: null }) },
      { name: "working", tasks: one({ status: "running", finishedAt: null }) },
      { name: "settled", tasks: one() },
      { name: "flagged", tasks: one({ status: "stale", stale: mark() }) },
    ];
    for (const { name, tasks } of boards) {
      const text = allText(guide(input({ tasks })));
      expect(text, name).not.toMatch(/\b1 [a-z]+s\b/);
    }
  });
});

describe("the running step and the failed step", () => {
  const running = { step: "run" as const, startedAt: AT };

  it("actions disappear while a launched step is live, and the narration says which", () => {
    const view = guide(input({ tasks: [], activity: activity({ running }) }));
    expect(view.actions).toEqual([]);
    expect(allText(view)).toContain("The agent run is running now");
  });

  it("a failed last step is flagged on whatever stage the board is in", () => {
    const lastResult: StepResult = {
      step: "rerun-same",
      exitCode: 1,
      signal: null,
      startedAt: AT,
      finishedAt: AT,
      durationMs: 61_000,
    };
    const view = guide(input({ tasks: FOUR_COMPLETE, activity: activity({ lastResult }) }));
    expect(view.stage).toBe("settled");
    expect(view.attention).toContain("The unchanged re-run");
    // Not "exited 1". The exit code is in the step's own output, one click away.
    expect(view.attention).toContain("did not finish");
  });

  it("a clean last step raises no attention", () => {
    const lastResult: StepResult = {
      step: "run",
      exitCode: 0,
      signal: null,
      startedAt: AT,
      finishedAt: AT,
      durationMs: 134_000,
    };
    const view = guide(input({ tasks: FOUR_COMPLETE, activity: activity({ lastResult }) }));
    expect(view.attention).toBeNull();
  });

  /*
   * The signal name used to be quoted here, and is not any more. A step killed by
   * SIGTERM and one that exited 3 are two different things to a maintainer and the
   * same thing to somebody watching a demo: it stopped early. Both names are in
   * the step's own output, which this line points at.
   */
  it("a step killed by a signal is reported as stopped, not as an exit code", () => {
    const lastResult: StepResult = {
      step: "run",
      exitCode: null,
      signal: "SIGTERM",
      startedAt: AT,
      finishedAt: AT,
      durationMs: 10_000,
    };
    const view = guide(input({ tasks: [], activity: activity({ lastResult }) }));
    expect(view.attention).toContain("was stopped before it finished");
  });

  it("while a step runs, an old failure is not still waved around", () => {
    const lastResult: StepResult = {
      step: "rerun-same",
      exitCode: 1,
      signal: null,
      startedAt: AT,
      finishedAt: AT,
      durationMs: 61_000,
    };
    const view = guide(
      input({ tasks: FOUR_COMPLETE, activity: activity({ running, lastResult }) }),
    );
    expect(view.attention).toBeNull();
  });
});
