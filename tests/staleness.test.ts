import { describe, expect, it } from "vitest";

import {
  affectedBy,
  blocked,
  compareFingerprints,
  readyToStart,
  shortName,
} from "@/src/server/coordinator/staleness";
import type {
  OutputFingerprint,
  SwarmSnapshot,
  TaskRecord,
  TaskStatus,
} from "@/src/server/coordinator/types";

const NOW = "2026-07-21T12:00:00.000Z";

function ds(name: string): string {
  return `urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.${name},PROD)`;
}

function fp(schema: string, content: string): OutputFingerprint {
  return { schema, content };
}

function task(
  name: string,
  reads: string[],
  writes: string[],
  status: TaskStatus = "complete",
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
    stale: null,
  };
}

function snapshot(tasks: TaskRecord[]): SwarmSnapshot {
  return { flow: "urn:li:dataFlow:(obsel,orders_pipeline,prod)", tasks, at: NOW };
}

/** The demo shape: clean -> revenue -> {report, docs}. */
function demoSwarm(overrides: Partial<Record<string, TaskStatus>> = {}): SwarmSnapshot {
  return snapshot([
    task("build_revenue", ["clean_orders"], ["daily_revenue"], overrides.build_revenue),
    task("write_report", ["daily_revenue"], ["revenue_report"], overrides.write_report),
    task("write_docs", ["daily_revenue"], ["pipeline_docs"], overrides.write_docs),
  ]);
}

function names(affected: { task: TaskRecord }[]): string[] {
  return affected.map((a) => a.task.name).sort();
}

describe("compareFingerprints — telling a real change from a plain re-run", () => {
  it("reports nothing when a task re-runs and produces exactly the same thing", () => {
    // The single most important case. If this ever returns non-null, every
    // scheduled re-run marks the whole pipeline stale and obsel becomes noise.
    const same = fp("schema-a", "content-a");
    expect(compareFingerprints(same, { ...same })).toBeNull();
  });

  it("reports nothing on a first run, which is not a change to anything", () => {
    expect(compareFingerprints(undefined, fp("schema-a", "content-a"))).toBeNull();
  });

  it("distinguishes a column rename from new rows", () => {
    const before = fp("schema-a", "content-a");
    expect(compareFingerprints(before, fp("schema-b", "content-a"))).toBe("schema");
    expect(compareFingerprints(before, fp("schema-a", "content-b"))).toBe("content");
    expect(compareFingerprints(before, fp("schema-b", "content-b"))).toBe("both");
  });
});

describe("affectedBy — following the chain", () => {
  it("finds nothing when nothing changed", () => {
    expect(affectedBy(demoSwarm(), [], NOW)).toEqual([]);
  });

  it("marks the task that read the changed data, at one hop", () => {
    const found = affectedBy(demoSwarm(), [{ dataset: ds("clean_orders"), kind: "schema" }], NOW);
    const direct = found.find((a) => a.task.name === "build_revenue");
    expect(direct).toBeDefined();
    expect(direct?.mark.hops).toBe(1);
    expect(direct?.mark.changeKind).toBe("schema");
  });

  it("marks work that never touched the change, reached through what did", () => {
    // write_report and write_docs read daily_revenue, never clean_orders.
    // Catching them is the whole point; a tool that only flags direct
    // dependents misses most of the damage.
    const found = affectedBy(demoSwarm(), [{ dataset: ds("clean_orders"), kind: "schema" }], NOW);
    expect(names(found)).toEqual(["build_revenue", "write_docs", "write_report"]);

    for (const name of ["write_report", "write_docs"]) {
      const indirect = found.find((a) => a.task.name === name);
      expect(indirect?.mark.hops).toBe(2);
      // It still names the table that actually moved, not the intermediate.
      expect(indirect?.mark.causedBy).toBe(ds("clean_orders"));
    }
  });

  it("leaves unrelated branches alone", () => {
    const swarm = snapshot([
      task("build_revenue", ["clean_orders"], ["daily_revenue"]),
      task("write_report", ["daily_revenue"], ["revenue_report"]),
      task("count_users", ["raw_users"], ["user_counts"]),
      task("user_report", ["user_counts"], ["users_pdf"]),
    ]);
    const found = affectedBy(swarm, [{ dataset: ds("clean_orders"), kind: "content" }], NOW);
    expect(names(found)).toEqual(["build_revenue", "write_report"]);
  });

  it("excludes the task that just ran, so nothing marks itself", () => {
    const swarm = demoSwarm();
    const self = swarm.tasks[0];
    const found = affectedBy(swarm, [{ dataset: ds("daily_revenue"), kind: "content" }], NOW, {
      excludeTasks: [self.urn],
    });
    expect(names(found)).toEqual(["write_docs", "write_report"]);
  });

  it("leaves detectedMs unset, because deciding cannot know how long writing takes", () => {
    // The engine fills this in once every mark has been written and confirmed.
    // A guess here would be exactly the unmeasured timing claim CLAUDE.md forbids,
    // and it is what the dashboard prints.
    const found = affectedBy(demoSwarm(), [{ dataset: ds("clean_orders"), kind: "schema" }], NOW);
    expect(found).not.toHaveLength(0);
    for (const entry of found) expect(entry.mark.detectedMs).toBeNull();
  });

  it("carries a plain-English reason that names the table", () => {
    const found = affectedBy(demoSwarm(), [{ dataset: ds("clean_orders"), kind: "schema" }], NOW);
    const direct = found.find((a) => a.task.name === "build_revenue");
    expect(direct?.mark.reason).toContain("clean_orders");
    expect(direct?.mark.reason).toContain("columns changed");

    const indirect = found.find((a) => a.task.name === "write_report");
    expect(indirect?.mark.reason).toContain("build_revenue");
  });
});

describe("affectedBy — work that has not finished", () => {
  it("does not mark a task that is still running", () => {
    // It will read the new data itself, so it is not out of date.
    const found = affectedBy(
      demoSwarm({ build_revenue: "running" }),
      [{ dataset: ds("clean_orders"), kind: "schema" }],
      NOW,
    );
    expect(names(found)).toEqual([]);
  });

  it("stops walking at a running task instead of propagating through it", () => {
    // write_report is finished, but its input is being rewritten right now.
    // Judging it against the OLD upstream would be wrong; it gets judged when
    // build_revenue reports what it actually produced.
    const found = affectedBy(
      demoSwarm({ build_revenue: "running" }),
      [{ dataset: ds("clean_orders"), kind: "content" }],
      NOW,
    );
    expect(names(found)).not.toContain("write_report");
  });

  it("does not mark a task that has not started", () => {
    const found = affectedBy(
      demoSwarm({ build_revenue: "registered" }),
      [{ dataset: ds("clean_orders"), kind: "schema" }],
      NOW,
    );
    expect(names(found)).toEqual([]);
  });

  it("ignores a task that is re-running to fix itself, even though it still carries a mark", () => {
    // A stale task being re-run keeps its mark until that run succeeds, so the
    // completion knows there is a DataHub tag to take off. It is still `running`
    // though, so it must not be re-marked and must not be walked through.
    const swarm = demoSwarm({ build_revenue: "running" });
    swarm.tasks[0].stale = {
      causedBy: ds("clean_orders"),
      causedByTask: null,
      hops: 1,
      changeKind: "schema",
      reason: "an earlier change, not yet cleared",
      since: NOW,
      detectedMs: 42,
    };

    const found = affectedBy(swarm, [{ dataset: ds("clean_orders"), kind: "content" }], NOW);
    expect(names(found)).toEqual([]);
  });

  it("keeps walking through work already marked stale", () => {
    // Its output exists and is still wrong, so anything built on it is too.
    const found = affectedBy(
      demoSwarm({ build_revenue: "stale" }),
      [{ dataset: ds("clean_orders"), kind: "schema" }],
      NOW,
    );
    expect(names(found)).toEqual(["build_revenue", "write_docs", "write_report"]);
  });
});

describe("affectedBy — awkward graph shapes", () => {
  it("terminates on a cycle instead of looping forever", () => {
    const swarm = snapshot([
      task("a", ["table_x"], ["table_y"]),
      task("b", ["table_y"], ["table_x"]),
    ]);
    const found = affectedBy(swarm, [{ dataset: ds("table_x"), kind: "content" }], NOW);
    expect(names(found)).toEqual(["a", "b"]);
  });

  it("reports a task reachable two ways once, at its shortest distance", () => {
    // final reads both the 1-hop and the 2-hop output; it should be described
    // by the nearest cause, not an arbitrary one.
    const swarm = snapshot([
      task("near", ["source"], ["near_out"]),
      task("far", ["near_out"], ["far_out"]),
      task("final", ["near_out", "far_out"], ["final_out"]),
    ]);
    const found = affectedBy(swarm, [{ dataset: ds("source"), kind: "content" }], NOW);
    expect(names(found)).toEqual(["far", "final", "near"]);
    expect(found.filter((a) => a.task.name === "final")).toHaveLength(1);
    expect(found.find((a) => a.task.name === "final")?.mark.hops).toBe(2);
  });

  it("handles several tables changing at once", () => {
    const swarm = snapshot([task("a", ["x"], ["a_out"]), task("b", ["y"], ["b_out"])]);
    const found = affectedBy(
      swarm,
      [
        { dataset: ds("x"), kind: "schema" },
        { dataset: ds("y"), kind: "content" },
      ],
      NOW,
    );
    expect(names(found)).toEqual(["a", "b"]);
  });

  it("returns the same order every time regardless of registration order", () => {
    const forward = affectedBy(demoSwarm(), [{ dataset: ds("clean_orders"), kind: "both" }], NOW);
    const reversed = snapshot([...demoSwarm().tasks].reverse());
    const backward = affectedBy(reversed, [{ dataset: ds("clean_orders"), kind: "both" }], NOW);
    expect(names(forward)).toEqual(names(backward));
  });
});

describe("readyToStart and blocked — what may run now", () => {
  it("lets a task start when its input comes from outside the swarm", () => {
    const swarm = snapshot([
      task("build_revenue", ["clean_orders"], ["daily_revenue"], "registered"),
    ]);
    expect(readyToStart(swarm).map((t) => t.name)).toEqual(["build_revenue"]);
  });

  it("holds a task back while the task feeding it is still running", () => {
    const swarm = snapshot([
      task("build_revenue", ["clean_orders"], ["daily_revenue"], "running"),
      task("write_report", ["daily_revenue"], ["revenue_report"], "registered"),
    ]);
    expect(readyToStart(swarm)).toEqual([]);
    expect(blocked(swarm)).toEqual([{ task: swarm.tasks[1], waitingOn: ["build_revenue"] }]);
  });

  it("releases it once the producer finishes", () => {
    const swarm = snapshot([
      task("build_revenue", ["clean_orders"], ["daily_revenue"], "complete"),
      task("write_report", ["daily_revenue"], ["revenue_report"], "registered"),
    ]);
    expect(readyToStart(swarm).map((t) => t.name)).toEqual(["write_report"]);
    expect(blocked(swarm)).toEqual([]);
  });

  it("does not block on a producer that finished but is out of date", () => {
    // Its output exists. Whether to trust it is a decision for a person.
    const swarm = snapshot([
      task("build_revenue", ["clean_orders"], ["daily_revenue"], "stale"),
      task("write_report", ["daily_revenue"], ["revenue_report"], "registered"),
    ]);
    expect(readyToStart(swarm).map((t) => t.name)).toEqual(["write_report"]);
  });
});

describe("shortName", () => {
  it("pulls a readable table name out of a URN", () => {
    expect(shortName(ds("clean_orders"))).toBe("clean_orders");
  });
});
