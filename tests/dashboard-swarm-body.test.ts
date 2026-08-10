/**
 * A body the board cannot honestly render is a failed read, never a blank page.
 *
 * `GET /api/swarm` is the one read the whole board is built from, and the page
 * hands its tasks straight to `inDependencyOrder` and `totals`. A record missing
 * `reads`/`writes` throws during render of the client component, so the board
 * goes blank with no error and no hint that anything was read at all. The trace
 * hook and the erasure hook already check every entry they accept for this
 * reason; this pins the same rule on the swarm hook.
 */

import { describe, expect, it } from "vitest";

import { isSwarmResponse } from "@/src/features/dashboard/hooks/use-swarm";
import { inDependencyOrder, totals } from "@/src/features/dashboard/timing";
import type { TaskRecord } from "@/src/server/coordinator/types";

function whole(name: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    urn: `urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),${name})`,
    name,
    reads: [],
    writes: [`urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.${name},PROD)`],
    status: "complete",
    fingerprints: {},
    finishedAt: null,
    startedAt: null,
    run: null,
    stale: null,
    ...overrides,
  };
}

function body(tasks: unknown[]): unknown {
  return {
    snapshot: {
      flow: "urn:li:dataFlow:(obsel,orders_pipeline,prod)",
      tasks,
      at: "2026-07-24T09:00:00.000Z",
    },
    ready: [],
    blocked: [],
  };
}

describe("the swarm read accepts only a body the board can render", () => {
  it("accepts a whole snapshot", () => {
    expect(isSwarmResponse(body([whole("clean_orders")]))).toBe(true);
  });

  it("accepts an empty board", () => {
    expect(isSwarmResponse(body([]))).toBe(true);
  });

  it("refuses a task record with no reads and writes", () => {
    /*
     * What a server or proxy that does not match this build answers with. Held
     * against what the board does with it: the record throws in the ordering
     * pass, and the totals count it as marked because `stale !== null` holds for
     * a field that is not there.
     */
    const partial = {
      urn: "urn:li:dataJob:(obsel,clean_orders,prod)",
      name: "clean_orders",
      status: "complete",
    };
    expect(() => inDependencyOrder([partial as unknown as TaskRecord])).toThrow();
    expect(totals([partial as unknown as TaskRecord]).marked).toBe(1);
    expect(isSwarmResponse(body([partial]))).toBe(false);
  });

  it("refuses a task record whose stale field is absent", () => {
    const noStale: Record<string, unknown> = { ...whole("clean_orders") };
    delete noStale.stale;
    expect(isSwarmResponse(body([noStale]))).toBe(false);
  });

  it("refuses entries that are not records at all", () => {
    expect(isSwarmResponse(body(["clean_orders"]))).toBe(false);
    expect(isSwarmResponse(body([null]))).toBe(false);
  });

  it("still refuses a body with no tasks array", () => {
    expect(isSwarmResponse({ snapshot: {}, ready: [], blocked: [] })).toBe(false);
    expect(isSwarmResponse(null)).toBe(false);
  });
});
