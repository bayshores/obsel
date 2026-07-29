import { describe, expect, it } from "vitest";

import { flowEdgeIds } from "@/src/features/dashboard/graph/flow";
import { layoutPositions } from "@/src/features/dashboard/graph/positions";
import type { TaskRecord } from "@/src/server/coordinator/types";

const NOW = "2026-07-21T14:22:07.000Z";

function ds(name: string): string {
  return `urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.${name},PROD)`;
}

function taskUrn(name: string): string {
  return `urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),${name})`;
}

function task(name: string, reads: string[], writes: string[]): TaskRecord {
  return {
    urn: taskUrn(name),
    name,
    reads: reads.map(ds),
    writes: writes.map(ds),
    status: "complete",
    fingerprints: {},
    finishedAt: NOW,
    startedAt: null,
    run: null,
    stale: null,
  };
}

/**
 * The demo shape: one raw table, a cleaner, and two readers of the clean table.
 * `daily_revenue` therefore has one writer and two readers, which is the case
 * that distinguishes "edges touching this table" from "edges of its writer".
 */
function swarm(): TaskRecord[] {
  return [
    task("clean_orders", ["raw_orders"], ["clean_orders"]),
    task("daily_revenue", ["clean_orders"], ["daily_revenue"]),
    task("revenue_report", ["daily_revenue"], ["revenue_report"]),
    task("table_docs", ["daily_revenue"], ["pipeline_docs"]),
  ];
}

describe("flowEdgeIds", () => {
  it("lights a table's writer and every one of its readers", () => {
    const lit = flowEdgeIds(swarm(), ds("daily_revenue"));

    expect([...lit].sort()).toEqual(
      [
        `${taskUrn("daily_revenue")}->${ds("daily_revenue")}`,
        `${ds("daily_revenue")}->${taskUrn("revenue_report")}`,
        `${ds("daily_revenue")}->${taskUrn("table_docs")}`,
      ].sort(),
    );
  });

  it("lights an agent's own reads and writes, and nothing further", () => {
    const lit = flowEdgeIds(swarm(), taskUrn("daily_revenue"));

    expect([...lit].sort()).toEqual(
      [
        `${ds("clean_orders")}->${taskUrn("daily_revenue")}`,
        `${taskUrn("daily_revenue")}->${ds("daily_revenue")}`,
      ].sort(),
    );
    // One hop only. The report downstream reads the table this agent wrote, and
    // that edge belongs to the table, not to this agent.
    expect(lit.has(`${ds("daily_revenue")}->${taskUrn("revenue_report")}`)).toBe(false);
  });

  it("lights a table nothing writes on its read edges alone", () => {
    const lit = flowEdgeIds(swarm(), ds("raw_orders"));

    expect([...lit]).toEqual([`${ds("raw_orders")}->${taskUrn("clean_orders")}`]);
  });

  it("lights nothing for null, and nothing for a urn that names nothing", () => {
    expect(flowEdgeIds(swarm(), null).size).toBe(0);
    expect(flowEdgeIds(swarm(), ds("invented")).size).toBe(0);
    expect(flowEdgeIds(swarm(), taskUrn("invented")).size).toBe(0);
    expect(flowEdgeIds([], ds("daily_revenue")).size).toBe(0);
  });

  /**
   * The failure this guards is silent: a spelling that drifts from
   * `layoutPositions` lights no edge and throws nothing, so the hover would
   * simply do nothing and look like a design decision. `cascadeEdges` has the
   * same test for the same reason.
   */
  it("spells every edge id the way the layout spells it", () => {
    const tasks = swarm();
    const known = new Set(layoutPositions(tasks).edges.map((edge) => edge.id));

    const everyNode = new Set([
      ...tasks.map((t) => t.urn),
      ...tasks.flatMap((t) => [...t.reads, ...t.writes]),
    ]);
    let seen = 0;
    for (const urn of everyNode) {
      for (const id of flowEdgeIds(tasks, urn)) {
        expect(known).toContain(id);
        seen += 1;
      }
    }
    // Every edge is reachable from both of its ends, so the sweep sees each twice.
    expect(seen).toBe(known.size * 2);
  });
});
