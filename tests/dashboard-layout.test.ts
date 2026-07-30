import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { cascadeEdges } from "@/src/features/dashboard/graph/cascade";
import {
  DATA_SIZE,
  DATA_SIZE_WITH_DIFF,
  TASK_SIZE,
  dataNodeId,
  layoutPositions,
  taskNodeId,
} from "@/src/features/dashboard/graph/positions";
import { shortName } from "@/src/features/dashboard/naming";
import { LONGEST_STATUS_WORD, STATUS_WORD, nodeTone } from "@/src/features/dashboard/tone";
import { shortName as serverShortName } from "@/src/server/coordinator/staleness";
import type { StaleMark, TaskRecord, TaskStatus } from "@/src/server/coordinator/types";

const NOW = "2026-07-21T14:22:07.000Z";

function ds(name: string): string {
  return `urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.${name},PROD)`;
}

function taskUrn(name: string): string {
  return `urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),${name})`;
}

function task(
  name: string,
  reads: string[],
  writes: string[],
  status: TaskStatus = "complete",
): TaskRecord {
  return {
    urn: taskUrn(name),
    name,
    reads: reads.map(ds),
    writes: writes.map(ds),
    status,
    fingerprints: {},
    finishedAt: status === "complete" || status === "stale" ? NOW : null,
    startedAt: null,
    run: null,
    stale: null,
  };
}

function mark(hops: number, causedBy: string, causedByTask: string | null): StaleMark {
  return {
    causedBy: ds(causedBy),
    causedByTask,
    hops,
    changeKind: "schema",
    reason: "read clean orders, and its columns changed after this finished",
    since: NOW,
    detectedMs: 118,
  };
}

/**
 * Mark a task the way the engine does: status AND a mark naming the origin.
 *
 * `cascadeEdges` reads the marks, not the statuses, so a test that only sets
 * `status = "stale"` describes a state the engine never produces.
 */
function markStale(t: TaskRecord, hops: number, origin: string, causeUrn: string | null): void {
  t.status = "stale";
  t.stale = {
    causedBy: origin,
    causedByTask: causeUrn,
    hops,
    changeKind: "schema",
    reason: "test",
    since: NOW,
    detectedMs: 118,
  };
}

/** The demo pipeline: one source, a chain, then a two-way fan-out. */
function pipeline(): TaskRecord[] {
  return [
    task("clean_orders", ["raw_orders"], ["clean_orders"]),
    task("build_revenue", ["clean_orders"], ["daily_revenue"]),
    task("write_report", ["daily_revenue"], ["revenue_report"]),
    task("write_docs", ["daily_revenue"], ["pipeline_docs"]),
  ];
}

/**
 * Every node's position and size, as one comparable string.
 *
 * Used to assert that geometry is a pure function of topology. dagre decides the
 * numbers now, so what is checked is the property rather than any specific value.
 */
function geometry(tasks: TaskRecord[]): string {
  const placed = layoutPositions(tasks);
  return JSON.stringify([...placed.nodes].sort((a, b) => a.id.localeCompare(b.id)));
}

/** A node by id, or a failed assertion naming what was missing. */
function nodeAt(tasks: TaskRecord[], id: string) {
  const found = layoutPositions(tasks).nodes.find((n) => n.id === id);
  expect(found, id).toBeDefined();
  return found!;
}

describe("layoutPositions — geometry is a function of topology, never of status", () => {
  /*
   * The load-bearing invariant, kept from the hand-written layout it replaced.
   *
   * dagre is never told a status, so nothing can move when three tasks flip
   * amber. That is what makes the cascade followable: colour and motion arrive on
   * a stationary graph. If position depended on status, the entire picture would
   * rearrange at the one moment somebody is trying to read it.
   */
  it("produces byte-identical geometry across every status a task can hold", () => {
    const statuses: TaskStatus[] = ["registered", "running", "complete", "stale"];
    const baseline = geometry(pipeline());

    for (const status of statuses) {
      const tasks = pipeline();
      for (const t of tasks) t.status = status;
      expect(geometry(tasks), `all tasks ${status}`).toBe(baseline);
    }
  });

  it("does not move when the cascade lands, the moment nothing may move", () => {
    const calm = pipeline();

    const cascaded = pipeline();
    cascaded[1].status = "stale";
    cascaded[1].stale = mark(1, "clean_orders", cascaded[0].urn);
    cascaded[2].status = "stale";
    cascaded[2].stale = mark(2, "clean_orders", cascaded[0].urn);
    cascaded[3].status = "stale";
    cascaded[3].stale = mark(2, "clean_orders", cascaded[0].urn);

    expect(geometry(cascaded)).toBe(geometry(calm));
  });

  it("does not move when a marked task is re-run and sits at running", () => {
    const before = pipeline();
    before[1].status = "stale";
    before[1].stale = mark(1, "clean_orders", before[0].urn);

    const during = pipeline();
    during[1].status = "running";
    during[1].stale = mark(1, "clean_orders", during[0].urn);

    expect(geometry(during)).toBe(geometry(before));
  });

  it("is deterministic, so two identical reads cannot draw two pictures", () => {
    // The dashboard re-lays out on every poll. A layout that varied between runs
    // would jitter the board once a second.
    expect(geometry(pipeline())).toBe(geometry(pipeline()));
  });
});

describe("layoutPositions — the sizes dagre reserves match the sizes CSS draws", () => {
  /*
   * dagre reserves space from these numbers, and `nodes.module.css` draws the
   * boxes from its own copy of them. If the two drift, a box overlaps a
   * neighbour dagre believed it had cleared. Asserted rather than left to a
   * comment, because a comment has never once stopped this from happening.
   */
  it("gives every node the declared footprint", () => {
    const tasks = pipeline();
    for (const node of layoutPositions(tasks).nodes) {
      const expected = node.kind === "task" ? TASK_SIZE : DATA_SIZE;
      expect({ width: node.width, height: node.height }, node.id).toEqual({
        width: expected.width,
        height: expected.height,
      });
    }
  });

  it("reserves the taller footprint for a dataset that will show a column diff", () => {
    const tasks = pipeline();
    const origin = ds("clean_orders");
    const node = layoutPositions(tasks, new Set([origin])).nodes.find(
      (n) => n.id === dataNodeId(origin),
    );
    expect(node?.height).toBe(DATA_SIZE_WITH_DIFF.height);
    expect(node?.width).toBe(DATA_SIZE_WITH_DIFF.width);
  });

  it("matches the pixel values in nodes.module.css", async () => {
    const css = await readFile(
      new URL("../src/features/dashboard/graph/nodes.module.css", import.meta.url),
      "utf8",
    );
    // .task is the only rule with a fixed width AND height; the data rules use
    // min-height so a diff can grow them.
    expect(css).toContain(`width: ${TASK_SIZE.width}px`);
    expect(css).toContain(`height: ${TASK_SIZE.height}px`);
    expect(css).toContain(`width: ${DATA_SIZE.width}px`);
    expect(css).toContain(`min-height: ${DATA_SIZE.height}px`);
    expect(css).toContain(`width: ${DATA_SIZE_WITH_DIFF.width}px`);
    expect(css).toContain(`min-height: ${DATA_SIZE_WITH_DIFF.height}px`);
  });
});

describe("layoutPositions — nothing is hardcoded", () => {
  it("lays out a swarm it has never seen, of a different size and shape", () => {
    const tasks = [
      task("ingest", ["landing"], ["bronze"]),
      task("dedupe", ["bronze"], ["silver"]),
      task("enrich", ["silver"], ["gold"]),
      task("publish_api", ["gold"], ["api_view"]),
      task("publish_bi", ["gold"], ["bi_extract"]),
      task("alerting", ["gold"], ["alerts"]),
    ];
    const placed = layoutPositions(tasks);

    // six tasks, six written datasets, one source
    expect(placed.nodes).toHaveLength(13);
    for (const t of tasks) expect(nodeAt(tasks, taskNodeId(t.urn))).toBeDefined();
    expect(placed.width).toBeGreaterThan(0);
    expect(placed.height).toBeGreaterThan(0);
  });

  it("places each task strictly to the right of the task feeding it", () => {
    // Confirms the adapter wired `reads` and `writes` the right way round. A
    // reversed edge would still lay out, just backwards, and the arrows would
    // then claim the report feeds the cleaner.
    const tasks = pipeline();
    const x = (name: string): number => nodeAt(tasks, taskNodeId(taskUrn(name))).x;

    expect(x("clean_orders")).toBeLessThan(x("build_revenue"));
    expect(x("build_revenue")).toBeLessThan(x("write_report"));
    expect(x("build_revenue")).toBeLessThan(x("write_docs"));
    // the two leaves are parallel, so they share a column
    expect(x("write_report")).toBe(x("write_docs"));
  });

  it("gives a source dataset its own column ahead of its reader", () => {
    const tasks = pipeline();
    expect(nodeAt(tasks, dataNodeId(ds("raw_orders"))).x).toBeLessThan(
      nodeAt(tasks, taskNodeId(taskUrn("clean_orders"))).x,
    );
  });

  it("produces one read edge and one write edge per task", () => {
    const placed = layoutPositions(pipeline());
    expect(placed.edges.filter((e) => e.kind === "read")).toHaveLength(4);
    expect(placed.edges.filter((e) => e.kind === "write")).toHaveLength(4);
  });

  it("keeps edge ids in the spelling cascadeEdges uses", () => {
    // cascadeEdges keys its result on `${from}->${to}` built from raw URNs, and
    // the renderer looks each edge up by that key to decide whether to light it.
    // If the two spellings drift, every edge silently renders unlit and the
    // cascade disappears from the board without any error.
    const tasks = pipeline();
    const ids = layoutPositions(tasks).edges.map((e) => e.id);
    expect(ids).toContain(`${ds("clean_orders")}->${taskUrn("build_revenue")}`);
    expect(ids).toContain(`${taskUrn("build_revenue")}->${ds("daily_revenue")}`);

    const cascaded = pipeline();
    markStale(cascaded[1], 1, ds("clean_orders"), cascaded[0].urn);
    const lit = cascadeEdges(cascaded, ds("clean_orders"), cascaded[0].urn);
    for (const key of Object.keys(lit)) expect(ids).toContain(key);
  });

  it("draws every output a task writes, not just the first", () => {
    const tasks = [
      task("clean_orders", ["raw_orders"], ["clean_orders", "orders_audit"]),
      task("build_revenue", ["clean_orders"], ["daily_revenue"]),
      task("audit_check", ["orders_audit"], ["audit_report"]),
    ];
    const placed = layoutPositions(tasks);
    const ids = placed.nodes.map((n) => n.id);

    expect(ids, "first output").toContain(dataNodeId(ds("clean_orders")));
    expect(ids, "second output").toContain(dataNodeId(ds("orders_audit")));
    expect(ids, "downstream of the second").toContain(dataNodeId(ds("audit_report")));

    const edgeIds = placed.edges.map((e) => e.id);
    expect(edgeIds).toContain(`${taskUrn("clean_orders")}->${ds("orders_audit")}`);
    expect(edgeIds).toContain(`${ds("orders_audit")}->${taskUrn("audit_check")}`);
  });

  it("never overlaps two boxes", () => {
    // The property the hand-written version needed explicit stacking code for.
    const tasks = [
      task("many", ["src"], ["out_a", "out_b", "out_c"]),
      task("fan", ["src"], ["out_d"]),
    ];
    const nodes = layoutPositions(tasks).nodes;
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i];
        const b = nodes[j];
        const apart =
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y;
        expect(apart, `${a.id} overlaps ${b.id}`).toBe(true);
      }
    }
  });

  it("lays out an outside agent that joined the demo's swarm mid-flight", () => {
    /*
     * The shape the join panel invites: the four demo tasks plus a fifth
     * registered over MCP by an agent this repository has never heard of,
     * reading one of the demo's own outputs. The board derives everything from
     * the swarm read, so a joiner must simply appear — placed after the task
     * that feeds it, overlapping nothing, with both of its edges drawn.
     */
    const tasks = [...pipeline(), task("visitors_audit", ["daily_revenue"], ["visitor_notes"])];
    const placed = layoutPositions(tasks);

    // five tasks, five written datasets, one source
    expect(placed.nodes).toHaveLength(11);
    const revenue = nodeAt(tasks, taskNodeId(taskUrn("build_revenue")));
    const joiner = nodeAt(tasks, taskNodeId(taskUrn("visitors_audit")));
    expect(revenue.x).toBeLessThan(joiner.x);
    expect(placed.edges.map((e) => e.id)).toContain(
      `${ds("daily_revenue")}->${taskUrn("visitors_audit")}`,
    );

    for (let i = 0; i < placed.nodes.length; i += 1) {
      for (let j = i + 1; j < placed.nodes.length; j += 1) {
        const a = placed.nodes[i];
        const b = placed.nodes[j];
        const apart =
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y;
        expect(apart, `${a.id} overlaps ${b.id}`).toBe(true);
      }
    }
  });

  it("draws a dataset two tasks both write exactly once", () => {
    const alpha = task("alpha_writer", ["raw"], ["shared"]);
    const zeta = task("zeta_writer", ["raw"], ["shared"]);
    const reader = task("reader", ["shared"], ["out"]);
    const ids = layoutPositions([alpha, zeta, reader]).nodes.map((n) => n.id);
    expect(ids.filter((id) => id === dataNodeId(ds("shared")))).toHaveLength(1);
  });

  it("terminates on a cyclic graph rather than hanging", () => {
    const a = task("a", ["y"], ["x"]);
    const b = task("b", ["x"], ["y"]);
    const placed = layoutPositions([a, b]);
    expect(placed.nodes).toHaveLength(4);
    expect(placed.width).toBeGreaterThan(0);
  });

  it("agrees with the coordinator's shortName", () => {
    for (const name of ["raw_orders", "clean_orders", "daily_revenue", "pipeline_docs"]) {
      expect(shortName(ds(name))).toBe(serverShortName(ds(name)));
      expect(shortName(ds(name))).toBe(name);
    }
  });
});

describe("cascadeEdges", () => {
  it("lights nothing when nothing is stale", () => {
    expect(cascadeEdges(pipeline(), null, null)).toEqual({});
  });

  it("lights the real path, ordered by distance from the change", () => {
    const tasks = pipeline();
    markStale(tasks[1], 1, ds("clean_orders"), tasks[0].urn);
    markStale(tasks[2], 2, ds("clean_orders"), tasks[0].urn);
    markStale(tasks[3], 2, ds("clean_orders"), tasks[0].urn);

    const lit = cascadeEdges(tasks, ds("clean_orders"), tasks[0].urn);

    expect(lit[`${ds("clean_orders")}->${taskUrn("build_revenue")}`]).toBe(1);
    expect(lit[`${taskUrn("build_revenue")}->${ds("daily_revenue")}`]).toBe(1);
    expect(lit[`${ds("daily_revenue")}->${taskUrn("write_report")}`]).toBe(2);
    expect(lit[`${ds("daily_revenue")}->${taskUrn("write_docs")}`]).toBe(2);
    expect(Object.keys(lit)).toHaveLength(6);
  });

  it("never lights the edge into the task that caused the change", () => {
    const tasks = pipeline();
    markStale(tasks[1], 1, ds("raw_orders"), tasks[0].urn);
    const lit = cascadeEdges(tasks, ds("raw_orders"), tasks[0].urn);
    expect(lit[`${ds("raw_orders")}->${taskUrn("clean_orders")}`]).toBeUndefined();
  });

  it("stops at a running task instead of propagating through it", () => {
    const tasks = pipeline();
    tasks[1].status = "running"; // build_revenue is already re-reading the new input
    const lit = cascadeEdges(tasks, ds("clean_orders"), tasks[0].urn);
    expect(lit).toEqual({});
  });

  it("still lights a re-run task that has not yet earned its mark back", () => {
    // running, mark attached: the work is in flight but obsel's verdict stands
    const tasks = pipeline();
    markStale(tasks[1], 1, ds("clean_orders"), tasks[0].urn);
    tasks[1].status = "running";
    const lit = cascadeEdges(tasks, ds("clean_orders"), tasks[0].urn);
    expect(lit[`${ds("clean_orders")}->${taskUrn("build_revenue")}`]).toBe(1);
  });

  it("stops at a registered task, which has produced nothing to invalidate", () => {
    const tasks = pipeline();
    tasks[1].status = "registered";
    const lit = cascadeEdges(tasks, ds("clean_orders"), tasks[0].urn);
    expect(lit).toEqual({});
  });

  it("leaves an unrelated branch dark", () => {
    const tasks = [
      ...pipeline(),
      task("unrelated", [ds("other_source")].map(shortName), ["other_out"]),
    ];
    const lit = cascadeEdges(tasks, ds("clean_orders"), tasks[0].urn);
    for (const key of Object.keys(lit)) {
      expect(key).not.toContain("unrelated");
      expect(key).not.toContain("other_out");
    }
  });

  it("terminates on a cycle", () => {
    const a = task("a", ["y"], ["x"]);
    const b = task("b", ["x"], ["y"]);
    markStale(a, 2, ds("x"), null);
    markStale(b, 1, ds("x"), null);
    const lit = cascadeEdges([a, b], ds("x"), null);
    expect(Object.keys(lit).length).toBeGreaterThan(0);
    expect(Object.keys(lit).length).toBeLessThan(10);
  });

  it("lights nothing through a downstream task obsel did NOT mark", () => {
    // build_revenue was marked; write_report finished AFTER the cascade, so it
    // is built on the new data and carries no mark. It is `complete`, which the
    // old status-derived walk happily lit straight through.
    const tasks = pipeline();
    markStale(tasks[1], 1, ds("clean_orders"), tasks[0].urn);
    const lit = cascadeEdges(tasks, ds("clean_orders"), tasks[0].urn);

    expect(lit[`${ds("clean_orders")}->${taskUrn("build_revenue")}`]).toBe(1);
    expect(lit[`${ds("daily_revenue")}->${taskUrn("write_report")}`]).toBeUndefined();
    expect(lit[`${ds("daily_revenue")}->${taskUrn("write_docs")}`]).toBeUndefined();
  });

  it("ignores a mark that names a different origin", () => {
    const tasks = pipeline();
    markStale(tasks[1], 1, ds("some_other_table"), tasks[0].urn);
    expect(cascadeEdges(tasks, ds("clean_orders"), tasks[0].urn)).toEqual({});
  });

  it("takes hop counts from the marks, not from its own walk", () => {
    // The engine recorded 3 hops. Whatever the topology suggests, the mark wins.
    const tasks = pipeline();
    markStale(tasks[1], 3, ds("clean_orders"), tasks[0].urn);
    const lit = cascadeEdges(tasks, ds("clean_orders"), tasks[0].urn);
    expect(lit[`${ds("clean_orders")}->${taskUrn("build_revenue")}`]).toBe(3);
  });
});

describe("nodeTone — amber fill means stale, and only stale", () => {
  it("fills amber if and only if the status is stale", () => {
    const statuses: TaskStatus[] = ["registered", "running", "complete", "stale"];
    for (const status of statuses) {
      for (const hasMark of [true, false]) {
        const tone = nodeTone(status, hasMark);
        expect(tone.fill === "var(--obsel-stale)", `${status}/${String(hasMark)}`).toBe(
          status === "stale",
        );
      }
    }
  });

  it("shows a mark on work that is not stale as an outline, never a fill", () => {
    // A stale task being re-run to fix it keeps its mark while it runs.
    const running = nodeTone("running", true);
    expect(running.fill).toBe("var(--mm-rose)");
    expect(running.outline).toBe("var(--obsel-stale)");

    const complete = nodeTone("complete", true);
    expect(complete.fill).toBe("var(--mm-green)");
    expect(complete.outline).toBe("var(--obsel-stale)");
  });

  it("gives unmarked work no outline at all", () => {
    for (const status of ["registered", "running", "complete"] as TaskStatus[]) {
      expect(nodeTone(status, false).outline).toBeNull();
    }
  });

  it("never returns a literal colour — every value is a token", () => {
    const statuses: TaskStatus[] = ["registered", "running", "complete", "stale"];
    for (const status of statuses) {
      for (const hasMark of [true, false]) {
        const tone = nodeTone(status, hasMark);
        expect(tone.fill).toMatch(/^var\(--/);
        if (tone.outline !== null) expect(tone.outline).toMatch(/^var\(--/);
      }
    }
  });

  it("keeps LONGEST_STATUS_WORD in step with the vocabulary", () => {
    for (const word of Object.values(STATUS_WORD)) {
      expect(word.length).toBeLessThanOrEqual(LONGEST_STATUS_WORD.length);
    }
  });
});
