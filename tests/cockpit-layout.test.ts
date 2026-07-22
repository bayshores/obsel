import { describe, expect, it } from "vitest";

import {
  DATA_BOX,
  TASK_BOX,
  cascadeEdges,
  layoutGraph,
  reserveFor,
  shortName,
} from "@/src/features/cockpit/graph/layout";
import { LONGEST_STATUS_WORD, STATUS_WORD, nodeTone } from "@/src/features/cockpit/tone";
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
    stale: null,
  };
}

function mark(hops: number, causedBy: string, causedByTask: string | null): StaleMark {
  return {
    causedBy: ds(causedBy),
    causedByTask,
    hops,
    changeKind: "schema",
    reason: "read clean_orders, and its columns changed after this finished",
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

function reserve(tasks: TaskRecord[]): string {
  return reserveFor(tasks, LONGEST_STATUS_WORD);
}

function geometry(tasks: TaskRecord[]): string {
  const g = layoutGraph(tasks, reserve(tasks));
  return JSON.stringify({ boxes: g.boxes, width: g.width, height: g.height });
}

/**
 * Measured advances for Geist Mono, repeated here on purpose.
 *
 * If someone edits the table in layout.ts, these assertions must be re-measured
 * in a browser rather than silently following along — which is exactly what
 * importing the constant would let happen.
 */
const ADV = { 10: 6.28, 11: 6.885, 13: 8.06 } as const;

describe("layoutGraph — geometry is a function of topology, never of status", () => {
  it("produces byte-identical geometry across every status a task can hold", () => {
    const statuses: TaskStatus[] = ["registered", "running", "complete", "stale"];
    const baseline = geometry(pipeline());

    for (const status of statuses) {
      const tasks = pipeline();
      for (const t of tasks) t.status = status;
      expect(geometry(tasks), `all tasks ${status}`).toBe(baseline);
    }
  });

  it("does not move when the cascade lands — the moment nothing may move", () => {
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

  it("reserves width from the graph's shape, not from the current labels", () => {
    // A cascade cannot reach further than there are tasks to reach.
    expect(reserve(pipeline())).toBe("out of date  · 4 hops");
    expect(reserve(pipeline().slice(0, 2))).toBe("out of date  · 2 hops");
  });
});

describe("layoutGraph — no text can overflow its box", () => {
  it("fits every task's name, longest status line and clock", () => {
    const tasks = pipeline();
    const g = layoutGraph(tasks, reserve(tasks));
    const inner = (w: number): number => w - TASK_BOX.padX * 2;

    for (const t of tasks) {
      const box = g.boxes[`t:${t.urn}`];
      expect(box, t.name).toBeDefined();

      expect(t.name.length * ADV[13], `${t.name} name`).toBeLessThanOrEqual(inner(box.w));

      for (const status of Object.keys(STATUS_WORD) as TaskStatus[]) {
        const line = `${STATUS_WORD[status]}  · 2 hops`;
        expect(line.length * ADV[11], `${t.name} "${line}"`).toBeLessThanOrEqual(inner(box.w));
      }

      // the clock line is labelled: "finished 17:23:52" / "not finished yet"
      for (const line of ["finished 00:00:00", "not finished yet"]) {
        expect(line.length * ADV[11], `${t.name} "${line}"`).toBeLessThanOrEqual(inner(box.w));
      }
    }
  });

  it("fits every dataset's name and both fingerprint lines", () => {
    const tasks = pipeline();
    const g = layoutGraph(tasks, reserve(tasks));
    const inner = (w: number): number => w - DATA_BOX.padX * 2;

    for (const key of Object.keys(g.boxes).filter((k) => k.startsWith("d:"))) {
      const box = g.boxes[key];
      const name = shortName(key.slice(2));
      expect(name.length * ADV[11], `${name} name`).toBeLessThanOrEqual(inner(box.w));
      // "s " plus eight hex characters, the widest print line drawn
      expect("s 0123abcd".length * ADV[10], `${name} print`).toBeLessThanOrEqual(inner(box.w));
      expect("external".length * ADV[10], `${name} source marker`).toBeLessThanOrEqual(
        inner(box.w),
      );
    }
  });

  it("widens a box for a long task name rather than clipping it", () => {
    const long = "recompute_quarterly_revenue_attribution";
    const tasks = [task(long, ["raw_orders"], ["out"])];
    const g = layoutGraph(tasks, reserve(tasks));
    const box = g.boxes[`t:${tasks[0].urn}`];
    expect(long.length * ADV[13]).toBeLessThanOrEqual(box.w - TASK_BOX.padX * 2);
  });
});

describe("layoutGraph — nothing is hardcoded", () => {
  it("draws a swarm it has never seen, of a different size and shape", () => {
    const tasks = [
      task("ingest", ["landing"], ["bronze"]),
      task("dedupe", ["bronze"], ["silver"]),
      task("enrich", ["silver"], ["gold"]),
      task("publish_api", ["gold"], ["api_view"]),
      task("publish_bi", ["gold"], ["bi_extract"]),
      task("alerting", ["gold"], ["alerts"]),
    ];
    const g = layoutGraph(tasks, reserve(tasks));

    // six tasks, six written datasets, one source
    expect(Object.keys(g.boxes)).toHaveLength(13);
    for (const t of tasks) expect(g.boxes[`t:${t.urn}`]).toBeDefined();
    expect(g.boxes[`d:${ds("landing")}`]).toBeDefined();
    expect(g.width).toBeGreaterThan(0);
    expect(g.height).toBeGreaterThan(0);
  });

  it("places each task strictly to the right of the task feeding it", () => {
    const tasks = pipeline();
    const g = layoutGraph(tasks, reserve(tasks));
    const x = (name: string): number => g.boxes[`t:${taskUrn(name)}`].x;

    expect(x("clean_orders")).toBeLessThan(x("build_revenue"));
    expect(x("build_revenue")).toBeLessThan(x("write_report"));
    expect(x("build_revenue")).toBeLessThan(x("write_docs"));
    // the two leaves are parallel, so they share a column
    expect(x("write_report")).toBe(x("write_docs"));
  });

  it("gives a source dataset its own column ahead of its reader", () => {
    const tasks = pipeline();
    const g = layoutGraph(tasks, reserve(tasks));
    expect(g.boxes[`d:${ds("raw_orders")}`].x).toBeLessThan(
      g.boxes[`t:${taskUrn("clean_orders")}`].x,
    );
  });

  it("produces one read edge and one write edge per task", () => {
    const tasks = pipeline();
    const g = layoutGraph(tasks, reserve(tasks));
    expect(g.edges.filter((e) => e.kind === "read")).toHaveLength(4);
    expect(g.edges.filter((e) => e.kind === "write")).toHaveLength(4);
  });

  it("draws every output a task writes, not just the first", () => {
    // POST /api/tasks/register accepts writes: string[]. A task with two
    // outputs used to lose the second one entirely — no box, no edge, no error.
    const tasks = [
      task("clean_orders", ["raw_orders"], ["clean_orders", "orders_audit"]),
      task("build_revenue", ["clean_orders"], ["daily_revenue"]),
      task("audit_check", ["orders_audit"], ["audit_report"]),
    ];
    const g = layoutGraph(tasks, reserve(tasks));

    expect(g.boxes[`d:${ds("clean_orders")}`], "first output").toBeDefined();
    expect(g.boxes[`d:${ds("orders_audit")}`], "second output").toBeDefined();
    expect(g.boxes[`d:${ds("audit_report")}`], "downstream of the second").toBeDefined();

    // and the edges that make the second output reachable
    const ids = g.edges.map((e) => e.id);
    expect(ids).toContain(`${taskUrn("clean_orders")}->${ds("orders_audit")}`);
    expect(ids).toContain(`${ds("orders_audit")}->${taskUrn("audit_check")}`);
  });

  it("stacks a task's outputs without overlapping them", () => {
    const tasks = [task("many", ["src"], ["out_a", "out_b", "out_c"])];
    const g = layoutGraph(tasks, reserve(tasks));
    const boxes = ["out_a", "out_b", "out_c"].map((n) => g.boxes[`d:${ds(n)}`]);
    for (const b of boxes) expect(b).toBeDefined();
    const sorted = [...boxes].sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i].y, "no overlap").toBeGreaterThanOrEqual(sorted[i - 1].y + sorted[i - 1].h);
    }
  });

  it("names the same producer the engine does when two tasks write one dataset", () => {
    // staleness.ts builds its map with an unconditional set, so the LAST writer
    // wins. If the graph disagreed it would draw the other task's fingerprint
    // as the evidence for a change the engine blamed on this one.
    const alpha = task("alpha_writer", ["raw"], ["shared"]);
    const zeta = task("zeta_writer", ["raw"], ["shared"]);
    const reader = task("reader", ["shared"], ["out"]);
    const g = layoutGraph([alpha, zeta, reader], reserve([alpha, zeta, reader]));
    expect(g.producerOf[ds("shared")].name).toBe("zeta_writer");
    // and it is drawn exactly once, under that task
    expect(g.boxes[`d:${ds("shared")}`]).toBeDefined();
  });

  it("terminates on a cyclic graph rather than hanging", () => {
    const a = task("a", ["y"], ["x"]);
    const b = task("b", ["x"], ["y"]);
    const g = layoutGraph([a, b], reserve([a, b]));
    expect(Object.keys(g.boxes)).toHaveLength(4);
    expect(g.width).toBeGreaterThan(0);
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

describe("edges that skip a column are routed clear of the boxes between", () => {
  /** An audit task reading both the source table and the final report. */
  function spanning(): TaskRecord[] {
    return [
      task("clean_orders", ["raw_orders"], ["clean_orders"]),
      task("build_revenue", ["clean_orders"], ["daily_revenue"]),
      task("audit", ["raw_orders", "daily_revenue"], ["audit_log"]),
    ];
  }

  it("reserves a lane only when an edge actually needs one", () => {
    const plain = pipeline();
    expect(layoutGraph(plain, reserve(plain)).detourY, "demo pipeline needs no lane").toBeNull();

    const s = spanning();
    expect(layoutGraph(s, reserve(s)).detourY, "spanning graph reserves one").not.toBeNull();
  });

  it("puts the lane below every box, and inside the viewBox", () => {
    const s = spanning();
    const g = layoutGraph(s, reserve(s));
    const lane = g.detourY;
    expect(lane).not.toBeNull();
    for (const box of Object.values(g.boxes)) {
      expect(box.y + box.h, "lane is below this box").toBeLessThanOrEqual(lane as number);
    }
    expect(lane as number).toBeLessThanOrEqual(g.height);
  });

  it("still keeps geometry independent of status", () => {
    const calm = spanning();
    const hot = spanning();
    hot[2].status = "stale";
    hot[2].stale = {
      causedBy: ds("raw_orders"),
      causedByTask: null,
      hops: 1,
      changeKind: "schema",
      reason: "test",
      since: NOW,
      detectedMs: 1,
    };
    const a = layoutGraph(calm, reserve(calm));
    const b = layoutGraph(hot, reserve(hot));
    expect(JSON.stringify(b.boxes)).toBe(JSON.stringify(a.boxes));
    expect(b.detourY).toBe(a.detourY);
  });
});
