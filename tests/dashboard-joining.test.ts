/**
 * The joining guide is a lens on the swarm, never a stored position.
 *
 * The cases that matter are the ones where a tick would be a lie: obsel's own
 * demonstrations ticking somebody else's progress, an identical re-run counting
 * as a change, and a board with nothing on it claiming any step at all.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DEMO_TASKS,
  TAXI_NAMESPACE,
  isVisitor,
  joining,
} from "@/src/features/dashboard/joining/joining";
import type { JoinInput } from "@/src/features/dashboard/joining/joining";
import type { OutputFingerprint, StaleMark, TaskRecord } from "@/src/server/coordinator/types";

const AT = "2026-07-24T09:00:10.000Z";

function ds(namespace: string, name: string): string {
  return `urn:li:dataset:(urn:li:dataPlatform:obsel,${namespace}.${name},PROD)`;
}

function print(schema: string, content: string): OutputFingerprint {
  return { schema, content };
}

function task(name: string, namespace: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    urn: `urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),${name})`,
    name,
    reads: [ds(namespace, "source")],
    writes: [ds(namespace, name)],
    status: "complete",
    fingerprints: {},
    finishedAt: null,
    startedAt: null,
    run: null,
    stale: null,
    ...overrides,
  };
}

/**
 * A visiting agent's task, shaped the way the MCP door actually emits one.
 *
 * `obsel_demo`, not some namespace of its own, and that is the whole point.
 * `register_task` takes short names and `datasetUrn` qualifies them under the
 * demo namespace, so this is what a stranger's table genuinely looks like. An
 * earlier version of this file gave visitors a `finance.` prefix no caller
 * produces, and the classifier it was checking was broken in exactly the way
 * the fixture hid.
 */
function yourData(name: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return task(name, "obsel_demo", overrides);
}

function mark(): StaleMark {
  return {
    causedBy: ds("finance", "expenses"),
    causedByTask: null,
    hops: 1,
    changeKind: "schema",
    reason: "expenses changed its columns after this task finished",
    since: AT,
    detectedMs: 2591,
  };
}

function view(tasks: TaskRecord[], command: string | null = "claude mcp add obsel -- x") {
  const input: JoinInput = { trusted: true, tasks, command };
  return joining(input);
}

describe("whose task it is: obsel's own work is the closed set", () => {
  it("names the same four tasks obsel's own demonstration registers", () => {
    // Read out of the Python that registers them, not restated from belief.
    const pipeline = readFileSync(new URL("../agents/pipeline.py", import.meta.url), "utf8");
    const declared = [...pipeline.matchAll(/^\s+name="([a-z_]+)",$/gm)].map((hit) => hit[1]);
    expect(declared.length, "agents/pipeline.py no longer declares tasks by name").toBe(4);
    expect([...DEMO_TASKS].sort()).toEqual([...declared].sort());
  });

  it("names the same taxi namespace the scale swarm builds URNs from", () => {
    // Drift here would classify all forty of obsel's own taxi tasks as
    // somebody's visiting agent, and tick the guide off against obsel's own demo.
    const scale = readFileSync(new URL("../agents/scale.py", import.meta.url), "utf8");
    const declared = /^NAMESPACE\s*=\s*"([^"]+)"/m.exec(scale);
    expect(
      declared,
      "agents/scale.py no longer declares NAMESPACE at the top level",
    ).not.toBeNull();
    expect(TAXI_NAMESPACE).toBe(declared?.[1]);
  });

  it("does not count obsel's own demonstrations as anybody's agent", () => {
    for (const name of DEMO_TASKS) expect(isVisitor(task(name, "obsel_demo"))).toBe(false);
    expect(isVisitor(task("mart_manhattan", "obsel_taxi"))).toBe(false);
  });

  it("counts an agent whose tables landed in obsel's own namespace, which is all of them", () => {
    /*
     * The regression this file exists for. `register_task` takes short names and
     * `datasetUrn` qualifies them under `obsel_demo`, so a stranger's table is
     * `obsel_demo.clean_expenses` and is indistinguishable, by namespace, from
     * the demo's own. Classifying on the namespace put every real visitor in
     * obsel's column and the panel would never have ticked once.
     */
    expect(isVisitor(yourData("clean_expenses"))).toBe(true);
    expect(yourData("clean_expenses").writes[0]).toContain("obsel_demo.clean_expenses");
  });

  it("counts a visitor that reads one of the demo's tables", () => {
    // Joining onto obsel's own data is a real thing to do, and does not make
    // the joining task obsel's.
    expect(isVisitor(yourData("summarise", { reads: [ds("obsel_demo", "clean_orders")] }))).toBe(
      true,
    );
  });

  it("counts a task with no tables at all as a visitor", () => {
    // Nothing to judge it by, and the safe side is the one where the panel
    // still works for a stranger.
    expect(isVisitor(yourData("bare", { reads: [], writes: [] }))).toBe(true);
  });

  it("counts a taxi task as obsel's own even when it only reads the namespace", () => {
    const reader = yourData("some_rollup", {
      reads: [ds("obsel_taxi", "daily_trips")],
      writes: [ds("obsel_taxi", "week_bronx")],
    });
    expect(isVisitor(reader)).toBe(false);
  });
});

describe("the steps tick only on what the board shows", () => {
  it("ticks nothing on an empty board, and says it is waiting", () => {
    const result = view([]);
    expect(result.waiting).toBe(true);
    expect(result.done).toBe(0);
    expect(result.steps.every((step) => !step.done)).toBe(true);
  });

  it("ticks nothing for a board holding only obsel's own demonstrations", () => {
    // The whole four-task demo, finished, flagged, the lot. None of it is the
    // reader's agent, so none of it is their progress.
    const result = view([
      task("clean_orders", "obsel_demo", { finishedAt: AT, startedAt: AT }),
      task("build_revenue", "obsel_demo", { finishedAt: AT, startedAt: AT, stale: mark() }),
      task("clean_trips", "obsel_taxi", { finishedAt: AT, startedAt: AT }),
    ]);
    expect(result.waiting).toBe(true);
    expect(result.done).toBe(0);
  });

  it("ticks registration alone when a visitor has only declared itself", () => {
    const result = view([yourData("clean_expenses")]);
    expect(result.waiting).toBe(false);
    expect(result.done).toBe(1);
    expect(result.steps[0].done).toBe(true);
    expect(result.steps[0].detail).toContain("clean expenses");
  });

  it("ticks the announcement without the report while work is under way", () => {
    const result = view([yourData("clean_expenses", { status: "running", startedAt: AT })]);
    expect(result.steps.map((step) => step.done)).toEqual([true, true, false, false]);
  });

  it("ticks the report once a run has finished", () => {
    const result = view([yourData("clean_expenses", { startedAt: AT, finishedAt: AT })]);
    expect(result.steps.map((step) => step.done)).toEqual([true, true, true, false]);
  });

  it("ticks the answer when obsel has flagged the visitor's work", () => {
    const result = view([
      yourData("clean_expenses", { startedAt: AT, finishedAt: AT }),
      yourData("monthly_totals", { startedAt: AT, finishedAt: AT, stale: mark() }),
    ]);
    expect(result.done).toBe(4);
    expect(result.steps[3].detail).toContain("monthly totals");
  });

  it("spreads the ticks across different agents, because the swarm is the subject", () => {
    // One task registered and never run, another finished. The list is about
    // whether obsel has seen each thing happen, not about one task doing all four.
    const result = view([
      yourData("clean_expenses"),
      yourData("monthly_totals", { finishedAt: AT }),
    ]);
    expect(result.steps.map((step) => step.done)).toEqual([true, false, true, false]);
  });
});

describe("an identical re-run is not a change", () => {
  const same = print("schema-a", "content-a");

  it("does not tick the answer when the redone output came back the same", () => {
    // This is the rule the whole product rests on. A re-run that reproduces the
    // bytes is obsel deciding NOT to flag, so counting it here would teach the
    // reader the opposite of what obsel does.
    const result = view([
      yourData("clean_expenses", {
        startedAt: AT,
        finishedAt: AT,
        fingerprints: { [ds("finance", "clean_expenses")]: same },
        previousFingerprints: { [ds("finance", "clean_expenses")]: same },
      }),
    ]);
    expect(result.steps[3].done).toBe(false);
  });

  it("ticks the answer when only the columns moved", () => {
    const result = view([
      yourData("clean_expenses", {
        startedAt: AT,
        finishedAt: AT,
        fingerprints: { [ds("finance", "clean_expenses")]: print("schema-b", "content-a") },
        previousFingerprints: { [ds("finance", "clean_expenses")]: same },
      }),
    ]);
    expect(result.steps[3].done).toBe(true);
  });

  it("ticks the answer when only the values moved", () => {
    const result = view([
      yourData("clean_expenses", {
        startedAt: AT,
        finishedAt: AT,
        fingerprints: { [ds("finance", "clean_expenses")]: print("schema-a", "content-b") },
        previousFingerprints: { [ds("finance", "clean_expenses")]: same },
      }),
    ]);
    expect(result.steps[3].done).toBe(true);
  });

  it("does not tick from a previous fingerprint whose dataset has no current one", () => {
    // Half a record is not evidence of a change. It compares or it does not count.
    const result = view([
      yourData("clean_expenses", {
        startedAt: AT,
        finishedAt: AT,
        fingerprints: {},
        previousFingerprints: { [ds("finance", "clean_expenses")]: same },
      }),
    ]);
    expect(result.steps[3].done).toBe(false);
  });
});

describe("when the steps are painted rather than folded away", () => {
  it("opens on a board with nothing on it, which is the newcomer", () => {
    expect(view([]).expanded).toBe(true);
  });

  it("stays folded while obsel's own demonstration is the only thing registered", () => {
    // The state the board is in on camera. The heading still shows either way.
    const demo = view([task("clean_orders", "obsel_demo", { finishedAt: AT })]);
    expect(demo.waiting).toBe(true);
    expect(demo.expanded).toBe(false);
  });

  it("opens while a visiting agent is part way through", () => {
    expect(view([yourData("clean_expenses")]).expanded).toBe(true);
  });

  it("stays folded and ticks nothing when the read failed", () => {
    // A failed read leaves no tasks, which looks exactly like a board nobody
    // has registered on. Popping open there would put an empty checklist under
    // a headline saying obsel cannot see anything at all.
    const blind = joining({ trusted: false, tasks: [yourData("clean_expenses")], command: null });
    expect(blind.expanded).toBe(false);
    expect(blind.done).toBe(0);
    expect(blind.waiting).toBe(true);
  });

  it("folds again once all four have happened", () => {
    const finished = view([
      yourData("clean_expenses", { startedAt: AT, finishedAt: AT }),
      yourData("monthly_totals", { startedAt: AT, finishedAt: AT, stale: mark() }),
    ]);
    expect(finished.done).toBe(4);
    expect(finished.expanded).toBe(false);
  });
});

describe("the panel carries this machine's own command", () => {
  it("passes it through when the runner knows it", () => {
    expect(view([]).command).toBe("claude mcp add obsel -- x");
  });

  it("carries null rather than a placeholder when it does not", () => {
    // A made-up path would hand the reader a command that fails.
    expect(view([], null).command).toBeNull();
  });
});
