/**
 * The guide is a lens on observed state, never a stored script position.
 *
 * The tests that matter most are the awkward combinations: a step failing
 * behind the user's back, a stale task that is simultaneously re-running, the
 * machine broken while DataHub is fine. Each must land on the honest stage —
 * and no stage may narrate a number its inputs do not carry.
 */

import { describe, expect, it } from "vitest";

import { guide } from "@/src/features/cockpit/guide";
import type { GuideInput } from "@/src/features/cockpit/guide";
import type { StaleMark, TaskRecord, TaskStatus } from "@/src/server/coordinator/types";
import type { DemoActivity, StepResult } from "@/src/server/runner/types";

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

function activity(overrides: Partial<DemoActivity> = {}): DemoActivity {
  return {
    running: null,
    lastResult: null,
    log: [],
    preflight: { datahub: ok(), vocabulary: ok(), venv: ok(), codex: ok() },
    joinCommand: "claude mcp add obsel -- /tmp/x/agents/.venv/bin/python -m agents.mcp_server",
    ...overrides,
  };
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
                codex: ok(),
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
                codex: { ok: false, detail: "not installed", fix: "brew install codex" },
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
            codex: ok(),
          },
        }),
      }),
    );
    expect(allText(view)).toContain("nothing answered");
    expect(allText(view)).toContain("datahub docker quickstart");
  });

  it("prepare when the machine is broken while the swarm reads fine", () => {
    const view = guide(
      input({
        tasks: FOUR_COMPLETE,
        activity: activity({
          preflight: {
            datahub: ok(),
            vocabulary: ok(),
            venv: ok(),
            codex: { ok: false, detail: "the Codex CLI is not signed in", fix: "codex login" },
          },
        }),
      }),
    );
    expect(view.stage).toBe("prepare");
    expect(allText(view)).toContain("codex login");
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
      codex: ok(),
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
    expect(view.actions.map((action) => action.step)).toEqual(["rerun-same", "change"]);
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
    // The demo actions still appear for now — the demo pipeline is the
    // fallback — which is honest only while its labels name their own scope.
    // What must never appear is a taxi button driving tables this board lacks.
    expect(view.actions.map((action) => action.step)).not.toContain("scale-repair");
  });
});
