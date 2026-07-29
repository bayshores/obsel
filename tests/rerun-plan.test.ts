/**
 * The order to redo flagged work in.
 *
 * Pure input, pure output, no processes stood up and none needed. The cases
 * that matter are the ones where a naive answer is wrong: a task reachable
 * only through another flagged task must not come first, a cycle must not hang
 * or be given an invented order, and an unflagged producer that is mid-run must
 * hold its reader back even though nothing flagged is above it.
 *
 * The plan is a reading, never an instruction. Nothing here asserts that a
 * planned task is sound, because the plan makes no such claim.
 */

import { describe, expect, it } from "vitest";

import { rerunPlan } from "@/src/server/coordinator/rerun";
import type { SwarmSnapshot, TaskRecord, TaskStatus } from "@/src/server/coordinator/types";

const NOW = "2026-07-29T12:00:00.000Z";

function ds(name: string): string {
  return `urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.${name},PROD)`;
}

function task(
  name: string,
  reads: string[],
  writes: string[],
  status: TaskStatus = "stale",
): TaskRecord {
  return {
    urn: `urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),${name})`,
    name,
    reads: reads.map(ds),
    writes: writes.map(ds),
    status,
    fingerprints: {},
    finishedAt: status === "complete" || status === "stale" ? NOW : null,
    startedAt: null,
    run: null,
    stale:
      status === "stale"
        ? {
            causedBy: ds("clean_orders"),
            causedByTask: null,
            hops: 1,
            changeKind: "schema",
            reason: "read clean orders, and its columns changed after this finished",
            since: NOW,
            detectedMs: null,
          }
        : null,
  };
}

function snapshot(tasks: TaskRecord[]): SwarmSnapshot {
  return { flow: "urn:li:dataFlow:(obsel,orders_pipeline,prod)", tasks, at: NOW };
}

/** Wave contents by task name, which is what the ordering claims are about. */
function waveNames(plan: ReturnType<typeof rerunPlan>): string[][] {
  return plan.waves.map((wave) => wave.map((entry) => entry.name).sort());
}

describe("rerunPlan — what to redo first", () => {
  it("returns nothing when nothing is flagged", () => {
    // The ordinary state of a healthy board, and the one this must be silent in.
    const plan = rerunPlan(
      snapshot([
        task("build_revenue", ["clean_orders"], ["daily_revenue"], "complete"),
        task("write_report", ["daily_revenue"], ["revenue_report"], "complete"),
      ]),
    );

    expect(plan.waves).toEqual([]);
    expect(plan.startableNow).toEqual([]);
    expect(plan.cyclic).toEqual([]);
  });

  it("puts a producer ahead of the task that reads what it writes", () => {
    /*
     * The whole point. Redoing write_report first rebuilds it from a
     * daily_revenue that is itself about to be rebuilt, so the work is wasted
     * and the flag comes straight back when build_revenue reports.
     */
    const plan = rerunPlan(
      snapshot([
        task("write_report", ["daily_revenue"], ["revenue_report"]),
        task("build_revenue", ["clean_orders"], ["daily_revenue"]),
      ]),
    );

    expect(waveNames(plan)).toEqual([["build_revenue"], ["write_report"]]);
  });

  it("puts tasks at the same depth in the same wave", () => {
    // Two readers of one rebuilt table have no ordering between them, and
    // saying they do would make the plan look longer than the work is.
    const plan = rerunPlan(
      snapshot([
        task("build_revenue", ["clean_orders"], ["daily_revenue"]),
        task("write_report", ["daily_revenue"], ["revenue_report"]),
        task("write_docs", ["daily_revenue"], ["pipeline_docs"]),
      ]),
    );

    expect(waveNames(plan)).toEqual([["build_revenue"], ["write_docs", "write_report"]]);
  });

  it("leaves unflagged work out of the plan entirely", () => {
    /*
     * An unflagged task is not work to redo, and its position does not order
     * anything: its output is not about to change. Including it would hand
     * somebody a list with sound work in it and invite them to redo that too.
     */
    const plan = rerunPlan(
      snapshot([
        task("build_revenue", ["clean_orders"], ["daily_revenue"]),
        task("write_report", ["daily_revenue"], ["revenue_report"], "complete"),
        task("unrelated", ["other_source"], ["other_output"], "complete"),
      ]),
    );

    expect(waveNames(plan)).toEqual([["build_revenue"]]);
  });

  it("orders behind every writer of a shared table, not just one", () => {
    /*
     * Two tasks writing one table is legal. A reader must follow BOTH, and a
     * plan built on a single-writer lookup would order it after whichever
     * happened to be found and ahead of the other.
     */
    const plan = rerunPlan(
      snapshot([
        task("reader", ["shared"], ["downstream"]),
        task("writer_a", ["source"], ["shared"]),
        task("writer_b", ["source"], ["shared"]),
      ]),
    );

    expect(waveNames(plan)).toEqual([["writer_a", "writer_b"], ["reader"]]);
  });

  it("reports a cycle of flagged work instead of inventing an order for it", () => {
    /*
     * A ↔ B has no correct order, and terminating is not optional: the wave
     * loop must not spin. Both tasks are reported as cyclic rather than being
     * dropped, because somebody has to break the loop and they need to know
     * which tasks it involves.
     */
    const plan = rerunPlan(
      snapshot([task("a", ["from_b"], ["from_a"]), task("b", ["from_a"], ["from_b"])]),
    );

    expect(plan.waves).toEqual([]);
    expect(plan.cyclic.map((entry) => entry.name).sort()).toEqual(["a", "b"]);
  });

  it("keeps the orderable part of a graph that also contains a cycle", () => {
    // The cycle does not poison the rest: work that can be ordered still is.
    const plan = rerunPlan(
      snapshot([
        task("standalone", ["clean_orders"], ["standalone_out"]),
        task("a", ["from_b"], ["from_a"]),
        task("b", ["from_a"], ["from_b"]),
      ]),
    );

    expect(waveNames(plan)).toEqual([["standalone"]]);
    expect(plan.cyclic.map((entry) => entry.name).sort()).toEqual(["a", "b"]);
  });

  it("does not make a task wait for itself", () => {
    // A task that reads and writes the same table is not its own upstream, and
    // treating the self-edge as a dependency would report it as a cycle.
    const plan = rerunPlan(snapshot([task("accumulator", ["ledger"], ["ledger"])]));

    expect(waveNames(plan)).toEqual([["accumulator"]]);
    expect(plan.cyclic).toEqual([]);
  });
});

describe("rerunPlan — what can be started right now", () => {
  it("offers the first wave when its inputs are settled", () => {
    const plan = rerunPlan(
      snapshot([
        task("build_revenue", ["clean_orders"], ["daily_revenue"]),
        task("write_report", ["daily_revenue"], ["revenue_report"]),
        task("clean_orders_job", ["raw_orders"], ["clean_orders"], "complete"),
      ]),
    );

    expect(plan.startableNow).toEqual([
      "urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),build_revenue)",
    ]);
  });

  it("withholds a wave-0 task whose unflagged producer is still running", () => {
    /*
     * The distinction `startableNow` exists for. Nothing FLAGGED is above this
     * task, so it is correctly in wave 0, and it still must not start: the
     * table it reads is being written right now, and reading it would build on
     * a version about to be replaced.
     */
    const plan = rerunPlan(
      snapshot([
        task("build_revenue", ["clean_orders"], ["daily_revenue"]),
        task("clean_orders_job", ["raw_orders"], ["clean_orders"], "running"),
      ]),
    );

    expect(waveNames(plan)).toEqual([["build_revenue"]]);
    expect(plan.startableNow).toEqual([]);
  });

  it("treats a table nothing in the swarm writes as settled ground", () => {
    // Same rule as readyToStart: a seed table has no producer here to wait on.
    const plan = rerunPlan(snapshot([task("build_revenue", ["raw_orders"], ["daily_revenue"])]));

    expect(plan.startableNow).toHaveLength(1);
  });
});

describe("rerunPlan — what each row carries", () => {
  it("carries the cause the task's mark names, so a row can be traced", () => {
    const plan = rerunPlan(snapshot([task("build_revenue", ["clean_orders"], ["daily_revenue"])]));

    expect(plan.waves[0][0].causedBy).toBe(ds("clean_orders"));
    expect(plan.waves[0][0].title).toBeNull();
    expect(plan.waves[0][0].reads).toEqual([ds("clean_orders")]);
  });
});
