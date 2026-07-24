import { describe, expect, it } from "vitest";

import {
  affectedBy,
  blocked,
  columnChange,
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

describe("columnChange — naming what moved, without guessing why", () => {
  it("names the column that left and the one that arrived", () => {
    const change = columnChange(
      ["order_id", "customer", "order_total", "order_date"],
      ["order_id", "customer", "order_total_usd", "order_date"],
    );
    expect(change).toEqual({ added: ["order_total_usd"], removed: ["order_total"] });
  });

  it("does not call it a rename, because it cannot know that it was one", () => {
    // A column leaving and another arriving is indistinguishable from a drop
    // plus an unrelated addition. The shape carries both facts and asserts no
    // relationship between them; the UI renders a diff and lets the reader draw
    // the conclusion. If this ever grows a `renamed` field, that is obsel
    // claiming something it did not observe.
    const change = columnChange(["a"], ["b"]);
    expect(Object.keys(change ?? {}).sort()).toEqual(["added", "removed"]);
  });

  it("returns null for a pure reordering, which is exactly when the schema hash also holds", () => {
    // agents/fingerprint.py:58 hashes the SORTED column names, so a reordering
    // produces a byte-identical schema fingerprint. compareFingerprints
    // therefore reports no schema change for it, and this must agree: two
    // functions disagreeing about whether the columns moved would put a change
    // on screen that no mark exists for.
    expect(columnChange(["a", "b", "c"], ["c", "a", "b"])).toBeNull();
  });

  it("returns null when either side is unknown, rather than claiming nothing moved", () => {
    // OutputShape is optional on a completion report, and marks written before
    // obsel recorded shapes have neither side. Absent has to read as absent: an
    // empty diff would assert the columns held, which obsel cannot support.
    expect(columnChange(undefined, ["a"])).toBeNull();
    expect(columnChange(["a"], undefined)).toBeNull();
    expect(columnChange(undefined, undefined)).toBeNull();
  });

  it("handles additions and removals on their own", () => {
    expect(columnChange(["a"], ["a", "b"])).toEqual({ added: ["b"], removed: [] });
    expect(columnChange(["a", "b"], ["a"])).toEqual({ added: [], removed: ["b"] });
  });

  it("sorts both lists, so the same change always reads the same way", () => {
    const change = columnChange(["a", "z", "m"], ["a", "c", "b"]);
    expect(change).toEqual({ added: ["b", "c"], removed: ["m", "z"] });
  });

  it("is set logic, so a duplicated column name is not a change", () => {
    expect(columnChange(["a", "a", "b"], ["b", "a"])).toBeNull();
  });
});

describe("affectedBy — carrying the column diff to every marked task", () => {
  it("gives a transitively stale task the ORIGIN's columns, not its own input's", () => {
    // write_report is two hops out and never read clean_orders. Its mark names
    // clean_orders on causedBy, so the columns it reports have to be the ones
    // that moved on clean_orders. Re-deriving them per hop would describe
    // daily_revenue, which did not change in the way being reported.
    const columns = { added: ["order_total_usd"], removed: ["order_total"] };
    const found = affectedBy(
      demoSwarm(),
      [{ dataset: ds("clean_orders"), kind: "schema", columns }],
      NOW,
    );

    const direct = found.find((a) => a.task.name === "build_revenue");
    const indirect = found.find((a) => a.task.name === "write_report");
    expect(direct?.mark.hops).toBe(1);
    expect(indirect?.mark.hops).toBe(2);
    expect(direct?.mark.columns).toEqual(columns);
    expect(indirect?.mark.columns).toEqual(columns);
  });

  it("leaves columns null when the caller had none to give", () => {
    const found = affectedBy(demoSwarm(), [{ dataset: ds("clean_orders"), kind: "content" }], NOW);
    expect(found.length).toBeGreaterThan(0);
    for (const entry of found) expect(entry.mark.columns).toBeNull();
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

  it("carries a plain-English reason that names the table in words, not in code", () => {
    const found = affectedBy(demoSwarm(), [{ dataset: ds("clean_orders"), kind: "schema" }], NOW);
    const direct = found.find((a) => a.task.name === "build_revenue");
    // "clean orders", not "clean_orders". This sentence is the one the ledger
    // prints verbatim and the tag carries into DataHub, so the underscores are
    // dropped at the source rather than prettified at render time — one wording
    // of the fact, everywhere. Which dataset it was stays exact on `causedBy`.
    expect(direct?.mark.reason).toContain("clean orders");
    expect(direct?.mark.reason).not.toContain("clean_orders");
    expect(direct?.mark.reason).toContain("columns changed");
    // Still fully traceable: the identifier lives on the URN, not in the prose.
    expect(direct?.mark.causedBy).toContain("clean_orders");

    const indirect = found.find((a) => a.task.name === "write_report");
    // The via-task, likewise in words. `demoSwarm` registers no titles, so this
    // is the de-underscored-identifier fallback rather than a declared name.
    expect(indirect?.mark.reason).toContain("build revenue");
    expect(indirect?.mark.reason).not.toContain("build_revenue");
    // `causedByTask` is the producer of the ORIGIN dataset, and this fixture
    // registers no task that writes clean_orders — so it is legitimately null
    // here. The URN that pins the cause in this case is `causedBy`, above.
    expect(indirect?.mark.causedBy).toContain("clean_orders");
  });

  it("uses a task's registered title in the reason when it has one", () => {
    const swarm = demoSwarm();
    const via = swarm.tasks.find((task) => task.name === "build_revenue");
    if (via === undefined) throw new Error("fixture must contain build_revenue");
    // The same record the traversal will reach, now carrying a human name — the
    // one an agent registers as `obsel.title`.
    via.title = "Daily revenue";

    const found = affectedBy(swarm, [{ dataset: ds("clean_orders"), kind: "schema" }], NOW);
    const indirect = found.find((a) => a.task.name === "write_report");
    expect(indirect?.mark.reason).toContain("built on work from Daily revenue");
  });
});

describe("affectedBy — a change noticed by a reader, not reported by a writer", () => {
  /*
   * The unreported-change case: something rewrote clean_orders without telling
   * obsel, and the task that noticed was a reader whose completion report
   * carried an input fingerprint that contradicted the record. The walk is the
   * same walk; what changes is attribution, because the change's author is
   * unknown and the producer must not be blamed for bytes it never wrote.
   */
  const noticer = task("build_revenue", ["clean_orders"], ["daily_revenue"]);

  function noticedChange() {
    return [{ dataset: ds("clean_orders"), kind: "schema" as const, noticedBy: noticer }];
  }

  it("carries no author: causedByTask is null even though a producer exists", () => {
    const swarm = snapshot([
      task("clean_orders_task", ["raw_orders"], ["clean_orders"]),
      task("write_report", ["clean_orders"], ["revenue_report"]),
    ]);
    const found = affectedBy(swarm, noticedChange(), NOW);
    expect(names(found)).toEqual(["write_report"]);
    expect(found[0].mark.causedByTask).toBeNull();
  });

  it("says the change was never reported, and names the task that exposed it", () => {
    const swarm = snapshot([task("write_report", ["clean_orders"], ["revenue_report"])]);
    const found = affectedBy(swarm, noticedChange(), NOW);
    expect(found[0].mark.reason).toContain("Nothing reported that change");
    expect(found[0].mark.reason).toContain("build revenue");
  });

  it("keeps the attribution through every hop, not just the first", () => {
    const swarm = snapshot([
      task("write_report", ["clean_orders"], ["revenue_report"]),
      task("write_docs", ["revenue_report"], ["pipeline_docs"]),
    ]);
    const found = affectedBy(swarm, noticedChange(), NOW);
    const far = found.find((a) => a.task.name === "write_docs");
    expect(far?.mark.hops).toBe(2);
    expect(far?.mark.causedByTask).toBeNull();
  });

  it("a reported change still names its producer, exactly as before", () => {
    const swarm = snapshot([
      task("clean_orders_task", ["raw_orders"], ["clean_orders"]),
      task("write_report", ["clean_orders"], ["revenue_report"]),
    ]);
    const found = affectedBy(swarm, [{ dataset: ds("clean_orders"), kind: "schema" }], NOW);
    expect(found[0].mark.causedByTask).toContain("clean_orders_task");
    expect(found[0].mark.reason).not.toContain("Nothing reported");
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
