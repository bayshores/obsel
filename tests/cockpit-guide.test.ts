/**
 * The guide is a lens on observed state, never a stored script position.
 *
 * The tests that matter most are the awkward combinations: a step failing
 * behind the user's back, a stale task that is simultaneously re-running, the
 * machine broken while DataHub is fine. Each must land on the honest stage —
 * and no stage may narrate a number its inputs do not carry.
 */

import { describe, expect, it } from "vitest";

import { STEP_NAME, guide, sinceReset } from "@/src/features/cockpit/guide";
import { TOUR, settledIndex } from "@/src/features/cockpit/tour/steps";
import type { GuideInput } from "@/src/features/cockpit/guide";
import type { StaleMark, TaskRecord, TaskStatus } from "@/src/server/coordinator/types";
import type {
  DemoActivity,
  DemoStep,
  RunnerCheck,
  RunnerName,
  StepResult,
} from "@/src/server/runner/types";

const AT = "2026-07-22T09:00:10.000Z";

function ds(name: string): string {
  return `urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.${name},PROD)`;
}

function task(name: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  const status: TaskStatus = overrides.status ?? "complete";
  return {
    urn: `urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),${name})`,
    name,
    reads: [ds("raw_orders")],
    writes: [ds(name)],
    status,
    fingerprints: {},
    finishedAt: status === "complete" || status === "stale" ? AT : null,
    startedAt: null,
    run: null,
    stale: null,
    ...overrides,
  };
}

/**
 * A finished task whose recorded output moved: what a change leaves in DataHub.
 *
 * The hashes differ, which is the whole point. `engine.ts` writes a previous
 * entry only when the fingerprints genuinely moved, so this is the shape a real
 * board carries after a change and after a repair, and it is not the shape an
 * identical re-run produces. `identicalRerun` below is that one.
 */
function changed(name: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return task(name, {
    fingerprints: { [ds(name)]: { schema: "s2", content: "c2" } },
    previousFingerprints: { [ds(name)]: { schema: "s1", content: "c1" } },
    ...overrides,
  });
}

/** The key present and the hashes equal, which must not read as a change. */
function identicalRerun(name: string): TaskRecord {
  return task(name, {
    fingerprints: { [ds(name)]: { schema: "s1", content: "c1" } },
    previousFingerprints: { [ds(name)]: { schema: "s1", content: "c1" } },
  });
}

function mark(overrides: Partial<StaleMark> = {}): StaleMark {
  return {
    causedBy: ds("clean_orders"),
    causedByTask: null,
    hops: 1,
    changeKind: "schema",
    reason: "clean_orders changed its columns after this task finished",
    since: AT,
    detectedMs: 2591,
    ...overrides,
  };
}

function ok(detail = "fine") {
  return { ok: true, detail, fix: null };
}

/**
 * A passing runner check. Defaults to Codex because that is what detection
 * picks when both are installed, so it is the state most boards are in.
 */
function runnerOk(name: RunnerName = "codex"): RunnerCheck {
  return { ok: true, detail: "fine", fix: null, name };
}

function activity(overrides: Partial<DemoActivity> = {}): DemoActivity {
  return {
    running: null,
    lastResult: null,
    log: [],
    history: [],
    preflight: { datahub: ok(), vocabulary: ok(), venv: ok(), uvx: ok(), runner: runnerOk() },
    joinCommand: "claude mcp add obsel -- /tmp/x/agents/.venv/bin/python -m agents.mcp_server",
    ...overrides,
  };
}

/** Steps that ran and passed, in order, as the launcher would have recorded them. */
function ran(...steps: DemoStep[]): StepResult[] {
  return steps.map((step) => ({
    step,
    exitCode: 0,
    signal: null,
    startedAt: AT,
    finishedAt: AT,
    durationMs: 1000,
  }));
}

/** One step that ran and failed, which must never tick its act. */
function failed(step: DemoStep): StepResult {
  return { step, exitCode: 3, signal: null, startedAt: AT, finishedAt: AT, durationMs: 1000 };
}

function input(overrides: Partial<GuideInput> = {}): GuideInput {
  return {
    trusted: true,
    everRead: true,
    tasks: [],
    snapshotAt: AT,
    activity: activity(),
    ...overrides,
  };
}

const FOUR_COMPLETE = [
  task("clean_orders"),
  task("build_revenue"),
  task("write_report"),
  task("write_docs"),
];

/**
 * Every word a stage puts on screen, as one string.
 *
 * The view used to expose `narration: string[]`, and most assertions here read
 * `narration.join("\n")`. That field is gone: a stage now yields a headline, one
 * optional subline, and a prerequisite checklist on the setup and connection
 * stages. These tests are about which facts a stage states, not about which field
 * carries them, so they assert against the whole rendered text.
 */
function allText(view: ReturnType<typeof guide>): string {
  return [
    view.headline,
    view.subline ?? "",
    ...view.checks.flatMap((check) => [check.name, check.detail ?? "", check.fix ?? ""]),
    view.attention ?? "",
    ...view.actions.flatMap((a) => [a.label, a.detail]),
  ].join("\n");
}

describe("no em dash reaches the screen", () => {
  /*
   * A guard, not a preference dressed as one.
   *
   * The owner asked for em dashes to go. Ten rounds of hand-editing copy had
   * already put 194 of them into this directory and 10 onto the board at once, so
   * the only version of "removed" that survives another pass of edits is one the
   * build enforces. `e2e/cockpit.spec.ts` makes the same assertion against the
   * fully rendered page; this one covers every stage, including the failure and
   * setup stages a browser test would have to break the machine to reach.
   */
  const EM_DASH = "—";

  function everyStage(): { name: string; view: ReturnType<typeof guide> }[] {
    const failing: StepResult = {
      step: "run",
      exitCode: 1,
      signal: null,
      durationMs: 4000,
      startedAt: AT,
      finishedAt: AT,
    };
    return [
      { name: "connect", view: guide(input({ trusted: false })) },
      {
        name: "connect with a fix to offer",
        view: guide(
          input({
            trusted: false,
            activity: activity({
              preflight: {
                datahub: {
                  ok: false,
                  detail: "nothing answered",
                  fix: "datahub docker quickstart",
                },
                vocabulary: ok(),
                venv: ok(),
                uvx: ok(),
                runner: runnerOk(),
              },
            }),
          }),
        ),
      },
      {
        name: "prepare",
        view: guide(
          input({
            activity: activity({
              preflight: {
                datahub: ok(),
                vocabulary: { ok: false, detail: "the tag is missing", fix: null },
                venv: ok(),
                uvx: ok(),
                runner: {
                  ok: false,
                  detail: "not installed",
                  fix: "brew install codex",
                  name: "codex",
                },
              },
            }),
          }),
        ),
      },
      { name: "empty", view: guide(input({ tasks: [] })) },
      {
        name: "registered",
        view: guide(input({ tasks: [task("clean_orders", { finishedAt: null })] })),
      },
      {
        name: "working",
        view: guide(
          input({
            tasks: [
              task("clean_orders", {
                status: "running",
                finishedAt: null,
                startedAt: "2026-07-22T09:00:00.000Z",
              }),
            ],
          }),
        ),
      },
      { name: "settled", view: guide(input({ tasks: FOUR_COMPLETE })) },
      {
        name: "flagged",
        view: guide(
          input({
            tasks: [
              task("clean_orders"),
              task("build_revenue", { status: "stale", stale: mark() }),
            ],
          }),
        ),
      },
      {
        name: "flagged with a named column change",
        view: guide(
          input({
            tasks: [
              task("clean_orders"),
              task("build_revenue", {
                status: "stale",
                stale: mark({ columns: { added: ["order_total_usd"], removed: ["order_total"] } }),
              }),
            ],
          }),
        ),
      },
      {
        name: "a failed step",
        view: guide(input({ activity: activity({ lastResult: failing }) })),
      },
      {
        name: "a live step",
        view: guide(
          input({
            tasks: FOUR_COMPLETE,
            activity: activity({ running: { step: "run", startedAt: AT } }),
          }),
        ),
      },
    ];
  }

  it("never puts one in a headline, a subline, a note, an action or an attention line", () => {
    for (const { name, view } of everyStage()) {
      expect(allText(view), name).not.toContain(EM_DASH);
    }
  });

  it("covers every stage the guide can produce, so none can slip through unchecked", () => {
    // Without this, adding a stage and forgetting to list it above would leave
    // the guard passing while the new stage went unchecked.
    const covered = new Set(everyStage().map(({ view }) => view.stage));
    expect([...covered].sort()).toEqual([
      "connect",
      "empty",
      "flagged",
      "prepare",
      "registered",
      "settled",
      "working",
    ]);
  });
});

describe("the change line names the columns that moved", () => {
  /*
   * These fixtures read the changed table on purpose.
   *
   * A directly flagged task is one that consumed `clean_orders`, and saying so keeps
   * these assertions about the column wording alone: a task marked without reading
   * the changed table also earns the "never read it" clause, which belongs in its own
   * block below rather than tangled into every column case.
   */
  function directlyFlagged(overrides: Partial<StaleMark> = {}): TaskRecord {
    return task("build_revenue", {
      status: "stale",
      reads: [ds("clean_orders")],
      stale: mark(overrides),
    });
  }

  it("says lost and gained, never renamed, because a rename cannot be observed", () => {
    const view = guide(
      input({
        tasks: [
          task("clean_orders"),
          directlyFlagged({ columns: { added: ["order_total_usd"], removed: ["order_total"] } }),
        ],
      }),
    );
    expect(view.subline).toBe(
      "clean orders lost the column order_total and gained the column order_total_usd after they finished",
    );
    expect(view.subline).not.toContain("renamed");
  });

  it("falls back to the kind of change when no columns were recorded", () => {
    // Marks written before obsel recorded column lists, and every content-only
    // change. The line still has to say something true.
    const schema = guide(input({ tasks: [directlyFlagged({ columns: null })] }));
    expect(schema.subline).toBe("the columns in clean orders changed after they finished");

    const content = guide(
      input({ tasks: [directlyFlagged({ changeKind: "content", columns: null })] }),
    );
    expect(content.subline).toBe("the rows in clean orders changed after they finished");
  });

  it("reports a one-sided change without a dangling conjunction", () => {
    const added = guide(
      input({ tasks: [directlyFlagged({ columns: { added: ["refund_total"], removed: [] } })] }),
    );
    expect(added.subline).toBe("clean orders gained the column refund_total after they finished");

    const removed = guide(
      input({ tasks: [directlyFlagged({ columns: { added: [], removed: ["order_total"] } })] }),
    );
    expect(removed.subline).toBe("clean orders lost the column order_total after they finished");
  });
});

describe("the subline names work flagged without touching the change", () => {
  /*
   * The fact obsel exists for, and the one the board only ever showed as `· 2 hops`.
   *
   * Every count here is derived from `reads`, never from `hops`, so these fixtures
   * set hop counts that would give a different answer where it matters. "Never read
   * it" is a claim about what a task consumes; hops measure distance through the
   * graph. They usually agree, and the sentence has to be true when they do not.
   */
  const changed = ds("clean_orders");

  it("counts the indirect ones, and says so in words rather than in hops", () => {
    const view = guide(
      input({
        tasks: [
          task("clean_orders"),
          task("build_revenue", {
            status: "stale",
            reads: [changed],
            stale: mark({ hops: 1 }),
          }),
          task("write_report", {
            status: "stale",
            reads: [ds("daily_revenue")],
            stale: mark({ hops: 2 }),
          }),
          task("write_docs", {
            status: "stale",
            reads: [ds("daily_revenue")],
            stale: mark({ hops: 2 }),
          }),
        ],
      }),
    );
    expect(view.subline).toContain("2 of the 3 never read that table");
  });

  it("says nothing extra when every flagged task read the changed table", () => {
    const view = guide(
      input({
        tasks: [
          task("build_revenue", { status: "stale", reads: [changed], stale: mark({ hops: 1 }) }),
          task("write_report", { status: "stale", reads: [changed], stale: mark({ hops: 1 }) }),
        ],
      }),
    );
    expect(view.subline).not.toContain("never read");
    expect(view.subline).not.toContain("0 of");
  });

  it("counts by what a task reads, not by how far away the graph puts it", () => {
    // Two hops out and still reading the changed table on a second edge. The hop
    // count is honest; "never read it" would not be, so it must not be claimed.
    const view = guide(
      input({
        tasks: [
          task("build_revenue", { status: "stale", reads: [changed], stale: mark({ hops: 1 }) }),
          task("write_report", {
            status: "stale",
            reads: [ds("daily_revenue"), changed],
            stale: mark({ hops: 2 }),
          }),
        ],
      }),
    );
    expect(view.subline).not.toContain("never read");
  });

  it("spells out the all-indirect cases instead of stating a ratio of one to one", () => {
    const alone = guide(
      input({
        tasks: [
          task("write_docs", { status: "stale", reads: [ds("daily_revenue")], stale: mark() }),
        ],
      }),
    );
    expect(alone.subline).toContain("The one agent that went out of date never read that table");
    expect(alone.subline).not.toContain("1 of the 1");

    const several = guide(
      input({
        tasks: [
          task("write_report", { status: "stale", reads: [ds("daily_revenue")], stale: mark() }),
          task("write_docs", { status: "stale", reads: [ds("daily_revenue")], stale: mark() }),
        ],
      }),
    );
    expect(several.subline).toContain("None of the 2 ever read that table");
  });
});

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
    expect(view.actions.map((action) => action.step)).toEqual(["register", "scale-register"]);
  });

  it("empty offers both pipelines and says what is about to be set up", () => {
    // The only stage with no graph on screen, so the only one that describes the
    // pipeline in words instead of drawing it. Two setup buttons: the four-agent
    // demo and the forty-task taxi swarm are both one press away from nothing.
    const view = guide(input({ tasks: [] }));
    expect(view.stage).toBe("empty");
    expect(view.actions.map((action) => action.step)).toEqual(["register", "scale-register"]);
    expect(allText(view)).toContain("No agents yet");
    expect(allText(view)).toContain("Each one reads a table that another one writes");
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
     * which is the rule `nodeTone` enforces and `cockpit-layout.test.ts` covers.
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
     * is what the bench under the graph is for.
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
          preflight: { datahub: ok(), vocabulary: ok(), venv: ok(), uvx: ok(), runner },
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
      "register",
      "run",
      "change",
      "reached",
      "repair",
      "yours",
      // The erasure tab, last, because it asks a different question of the same
      // graph and needs the graph the previous ten steps taught the reader to
      // read. A `read` step: opening a request writes to the ledger with a token
      // the browser does not hold, so an act here could never complete.
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

  it("waits on the first action until something is actually registered", () => {
    expect(showing(FIRST_ACT, { tasks: [] })).toBe("register");
    // And the moment tasks exist it moves on by itself, with nobody pressing
    // anything: the board is the only thing that can advance an action step.
    expect(showing(FIRST_ACT, { tasks: REGISTERED })).toBe("run");
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
    expect(TOUR[settledIndex(FIRST_ACT, failedRun)].id).toBe("register");
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
