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
    expect(view.narration.join("\n")).toContain("nothing answered");
    expect(view.narration.join("\n")).toContain("datahub docker quickstart");
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
    expect(view.narration.join("\n")).toContain("codex login");
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
    expect(withoutVenv.narration.join("\n")).toContain("python3 -m venv agents/.venv");
  });

  it("an unreadable activity feed never blocks the journey — unknown is not broken", () => {
    const view = guide(input({ activity: null, tasks: [] }));
    expect(view.stage).toBe("empty");
    expect(view.actions.map((action) => action.step)).toEqual(["register"]);
  });

  it("empty offers register and tells the product story", () => {
    const view = guide(input({ tasks: [] }));
    expect(view.stage).toBe("empty");
    expect(view.actions.map((action) => action.step)).toEqual(["register"]);
    expect(view.narration[0]).toContain("obsel");
  });

  it("registered introduces each agent by its registered description, or its lineage when it has none", () => {
    const view = guide(
      input({
        tasks: [
          task("clean_orders", {
            status: "registered",
            finishedAt: null,
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
    expect(view.narration[0]).toContain("2 tasks are declared");
    expect(view.narration).toContain(
      "clean_orders — cleans the raw orders export into a tidy four-column table",
    );
    expect(view.narration).toContain("build_revenue — reads clean_orders, writes daily_revenue");
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
    expect(view.narration[0]).toContain("1 of 2");
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
    expect(view.narration[0]).toContain("in flight for 10.0 s");
    expect(view.actions).toEqual([]);
  });

  it("working narrates no elapsed when startedAt is missing, rather than inventing one", () => {
    const view = guide(
      input({ tasks: [task("clean_orders", { status: "running", finishedAt: null })] }),
    );
    expect(view.stage).toBe("working");
    expect(view.narration[0]).not.toContain("in flight for");
    expect(view.narration[0]).toContain("clean_orders is working");
  });

  it("a stale task that is re-running lands on working — running wins, and the held mark is counted", () => {
    const view = guide(
      input({
        tasks: [
          task("clean_orders", { status: "running", finishedAt: null }),
          task("build_revenue", { status: "stale", stale: mark() }),
        ],
      }),
    );
    expect(view.stage).toBe("working");
    expect(view.narration.join("\n")).toContain("1 finished task(s) still carry their mark");
  });

  it("settled offers the two experiments once everything finished clean", () => {
    const view = guide(input({ tasks: FOUR_COMPLETE }));
    expect(view.stage).toBe("settled");
    expect(view.actions.map((action) => action.step)).toEqual(["rerun-same", "change"]);
  });

  it("flagged counts the marks, directs to the ledger's recorded reasons, and calls out the transitive reach", () => {
    const view = guide(
      input({
        tasks: [
          task("clean_orders"),
          task("build_revenue", { status: "stale", stale: mark({ hops: 1 }) }),
          task("write_report", { status: "stale", stale: mark({ hops: 2 }) }),
          task("write_docs", { status: "stale", stale: mark({ hops: 2 }) }),
        ],
      }),
    );
    expect(view.stage).toBe("flagged");
    const text = view.narration.join("\n");
    expect(text).toContain("3 of 4 finished tasks");
    expect(text).toContain("ledger below");
    expect(text).toContain("write_report and write_docs never read the changed table");
    // The identical re-run stays available on a flagged board — proving no new
    // marks arrive and the existing three stay put — alongside reset. `change`
    // does not: re-issuing the same changed job proves nothing further.
    expect(view.actions.map((action) => action.step)).toEqual(["rerun-same", "reset"]);
  });

  it("flagged omits the detection timing when the mark carries none — never a fabricated number", () => {
    const view = guide(
      input({
        tasks: [task("build_revenue", { status: "stale", stale: mark({ detectedMs: null }) })],
      }),
    );
    const text = view.narration.join("\n");
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
    expect(view.narration.join("\n")).toContain("`run` is running now");
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
    expect(view.attention).toContain("`rerun-same`");
    expect(view.attention).toContain("exited 1");
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
    expect(view.attention).toContain("stopped by SIGTERM");
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
