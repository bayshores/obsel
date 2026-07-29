import { describe, expect, it } from "vitest";

import {
  affectedBy,
  blocked,
  classifyObservation,
  columnChange,
  compareFingerprints,
  causesOf,
  mergeMark,
  readyToStart,
  restoredBy,
  shortName,
  supersededMark,
} from "@/src/server/coordinator/staleness";
import type {
  ChangeKind,
  OutputFingerprint,
  StaleMark,
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

  it("excludes the reporter even when the walk comes back around to it", () => {
    /*
     * The test above passes with the exclusion deleted: `build_revenue` never
     * reads daily_revenue, so the walk could not have reached it anyway and the
     * option was doing nothing the graph shape was not already doing. This is
     * the case that needs it — a two-task cycle where the reporter genuinely IS
     * downstream of its own change.
     *
     * `enrich` reports new bytes in clean_orders. `summarize` read that table
     * and is stale, and what `summarize` writes is `enrich`'s own input, so the
     * second hop arrives back at the task that just ran. It must not be marked:
     * it reported these bytes, its work is built on the version standing now,
     * and a task flagged by its own completion is a flag nobody can ever clear.
     */
    const enrich = task("enrich", ["raw_orders"], ["clean_orders"]);
    const summarize = task("summarize", ["clean_orders"], ["raw_orders"]);

    const found = affectedBy(
      snapshot([enrich, summarize]),
      [{ dataset: ds("clean_orders"), kind: "content" }],
      NOW,
      { excludeTasks: [enrich.urn] },
    );

    expect(names(found)).toEqual(["summarize"]);
  });

  it("leaves detectedMs unset, because deciding cannot know how long writing takes", () => {
    // The engine fills this in once every mark has been written and confirmed.
    // A guess here would be exactly the unmeasured timing claim obsel's rules forbid,
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
    return [
      { dataset: ds("clean_orders"), kind: "schema" as const, unreported: { noticedBy: noticer } },
    ];
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

  it("reports a task reachable two ways from ONE change once, at its shortest distance", () => {
    /*
     * final reads both the 1-hop and the 2-hop output; it should be described
     * by the nearest cause, not an arbitrary one.
     *
     * Two PATHS, one cause. This is the distinction that matters now that a mark
     * can carry several: `source` changing is one reason `final` is broken, and
     * the fact that the breakage arrives by two routes does not make it two.
     * Recording it twice would have the details panel list the same table as an
     * independent cause of itself.
     */
    const swarm = snapshot([
      task("near", ["source"], ["near_out"]),
      task("far", ["near_out"], ["far_out"]),
      task("final", ["near_out", "far_out"], ["final_out"]),
    ]);
    const found = affectedBy(swarm, [{ dataset: ds("source"), kind: "content" }], NOW);
    expect(names(found)).toEqual(["far", "final", "near"]);
    expect(found.filter((a) => a.task.name === "final")).toHaveLength(1);
    const final = found.find((a) => a.task.name === "final");
    expect(final?.mark.hops).toBe(2);
    expect(final?.mark.causes).toHaveLength(1);
  });

  it("records two ORIGINS reaching one task as two causes, nearest leading", () => {
    /*
     * The sibling of the case above, and the reason the walk is per-change.
     * `raw_a` and `raw_b` are independent changes; `both` is broken by each of
     * them separately, and repairing one leaves the other standing. Under a
     * shared visited set the second origin found nothing, so the record said
     * `both` was stale for one reason — and after that reason was repaired the
     * flag remained with a sentence naming a table that had just been fixed.
     */
    const swarm = snapshot([
      task("near_a", ["raw_a"], ["mid_a"]),
      task("both", ["raw_b", "mid_a"], ["both_out"]),
    ]);

    const found = affectedBy(
      swarm,
      [
        { dataset: ds("raw_a"), kind: "schema" },
        { dataset: ds("raw_b"), kind: "content" },
      ],
      NOW,
    );

    const both = found.find((a) => a.task.name === "both");
    // raw_b reaches it directly at one hop; raw_a arrives through near_a at two.
    expect(both?.mark.causedBy).toBe(ds("raw_b"));
    expect(both?.mark.hops).toBe(1);
    expect(both?.mark.causes?.map((cause) => [cause.causedBy, cause.hops])).toEqual([
      [ds("raw_b"), 1],
      [ds("raw_a"), 2],
    ]);
  });

  it("keeps each cause's own distance and kind, not the primary's", () => {
    // A cause is a record of one change, so it carries what that change was.
    // Flattening them onto the primary's values would make the second entry a
    // duplicate of the first with a different table name.
    const swarm = snapshot([
      task("near_a", ["raw_a"], ["mid_a"]),
      task("both", ["raw_b", "mid_a"], ["both_out"]),
    ]);

    const found = affectedBy(
      swarm,
      [
        { dataset: ds("raw_a"), kind: "schema" },
        { dataset: ds("raw_b"), kind: "content" },
      ],
      NOW,
    );

    const causes = found.find((a) => a.task.name === "both")?.mark.causes;
    expect(causes?.map((cause) => cause.changeKind)).toEqual(["content", "schema"]);
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

describe("restoredBy — clearing only what a redo has proven", () => {
  // A wrong answer from affectedBy over-marks and wastes a redo. A wrong answer
  // here declares broken work sound, which is the one failure that would poison
  // everything obsel says. So the negative cases lead, and there are more of
  // them: every rule in restoredBy exists to refuse one of these.

  const T0 = "2026-07-21T09:00:00.000Z";
  const T1 = "2026-07-21T10:00:00.000Z";
  const T2 = "2026-07-21T11:00:00.000Z";
  const T3 = "2026-07-21T11:30:00.000Z";
  const T4 = "2026-07-21T12:30:00.000Z"; // after every downstream task finished

  function finished(record: TaskRecord, at: string | null): TaskRecord {
    return { ...record, finishedAt: at };
  }

  function marked(record: TaskRecord, causedBy: string): TaskRecord {
    return {
      ...record,
      status: "stale",
      stale: {
        causedBy: ds(causedBy),
        causedByTask: null,
        hops: 1,
        changeKind: "schema",
        reason: "test mark",
        since: T4,
        detectedMs: null,
      },
    };
  }

  /**
   * The board the demo's repair starts from: clean_orders was renamed (its
   * producer re-reported at T4), and the three finished tasks downstream carry
   * marks. The trigger everywhere below is build_revenue redoing its work.
   */
  function flaggedSwarm(): {
    swarm: SwarmSnapshot;
    finishing: TaskRecord;
  } {
    const clean = finished(task("clean_orders_task", ["raw_orders"], ["clean_orders"]), T4);
    const revenue = marked(
      finished(task("build_revenue", ["clean_orders"], ["daily_revenue"]), T1),
      "clean_orders",
    );
    const report = marked(
      finished(task("write_report", ["daily_revenue"], ["revenue_report"]), T2),
      "clean_orders",
    );
    const docs = marked(
      finished(task("write_docs", ["daily_revenue"], ["pipeline_docs"]), T3),
      "clean_orders",
    );
    return { swarm: snapshot([clean, revenue, report, docs]), finishing: revenue };
  }

  it("clears the two tasks downstream of a redo that came out identical", () => {
    // The whole feature: build_revenue redid its work on the renamed table and
    // daily_revenue came out byte-identical, so the report and the docs were
    // flagged for ground that never moved. One redo, not three.
    const { swarm, finishing } = flaggedSwarm();
    const restored = restoredBy(swarm, finishing, [ds("daily_revenue")]);
    expect(names(restored)).toEqual(["write_docs", "write_report"]);
  });

  it("says why, in the same voice a mark's reason uses", () => {
    const { swarm, finishing } = flaggedSwarm();
    const restored = restoredBy(swarm, finishing, [ds("daily_revenue")]);
    expect(restored[0].reason).toBe(
      "build revenue redid daily revenue and it came out identical, " +
        "so everything this was built on still stands",
    );
  });

  it("clears nothing when the redo changed its output", () => {
    // A changed output is new ground, not restored ground. affectedBy is
    // already marking what stands on it; restoring anything here would clear
    // and re-flag the same task in one breath, or worse, only clear.
    const { swarm, finishing } = flaggedSwarm();
    expect(restoredBy(swarm, finishing, [])).toEqual([]);
  });

  it("clears nothing when the finishing task was not stale", () => {
    // The rerun-same trap. On the flagged board, the changed task can re-run
    // and produce its (renamed) table again, identical to what it last
    // reported. That proves the current version is stable; it says nothing
    // about work built on the PREVIOUS version, so the flags must all stay.
    const { swarm } = flaggedSwarm();
    const cleanTask = swarm.tasks.find((t) => t.name === "clean_orders_task");
    expect(cleanTask).toBeDefined();
    expect(restoredBy(swarm, cleanTask as TaskRecord, [ds("clean_orders")])).toEqual([]);
  });

  it("never clears a direct reader of the table that actually changed", () => {
    // A second hop-one reader of clean_orders. Its own mark names the table it
    // read, and no redo elsewhere argues with that: the ground under it really
    // moved, and only its own redo absorbs the new version.
    const { swarm, finishing } = flaggedSwarm();
    const audit = marked(
      finished(task("write_audit", ["clean_orders"], ["audit_notes"]), T2),
      "clean_orders",
    );
    const withAudit = snapshot([...swarm.tasks, audit]);
    const restored = restoredBy(withAudit, finishing, [ds("daily_revenue")]);
    expect(names(restored)).toEqual(["write_docs", "write_report"]);
  });

  it("holds a task whose other input comes from a producer still stale", () => {
    // write_summary reads daily_revenue, which the redo just proved sound, and
    // audit_notes, whose producer is still flagged. One sound input out of two
    // is not sound work.
    const { swarm, finishing } = flaggedSwarm();
    const audit = marked(
      finished(task("write_audit", ["clean_orders"], ["audit_notes"]), T2),
      "clean_orders",
    );
    const summary = marked(
      finished(task("write_summary", ["daily_revenue", "audit_notes"], ["summary"]), T3),
      "clean_orders",
    );
    const wider = snapshot([...swarm.tasks, audit, summary]);
    const restored = restoredBy(wider, finishing, [ds("daily_revenue")]);
    expect(names(restored)).toEqual(["write_docs", "write_report"]);
  });

  it("holds a reader while its producer carries a standing observation", () => {
    // Someone read bytes the producer never reported writing. Which version any
    // given reader consumed is unknowable until the producer reports again, so
    // an identical redo elsewhere proves nothing about them.
    const { swarm, finishing } = flaggedSwarm();
    const withObservation = {
      ...finishing,
      observed: { [ds("daily_revenue")]: fp("seen-schema", "seen-content") },
    };
    const tasks = swarm.tasks.map((t) => (t.name === "build_revenue" ? withObservation : t));
    expect(restoredBy(snapshot(tasks), withObservation, [ds("daily_revenue")])).toEqual([]);
  });

  it("holds a reader that finished before the producer's previous report", () => {
    // The recorded fingerprint is what the producer LAST reported. A task that
    // finished before that report read some earlier version, so an identical
    // redo confirms a baseline this task never built on.
    const { swarm, finishing } = flaggedSwarm();
    const early = marked(
      finished(task("write_early", ["daily_revenue"], ["early_notes"]), T0),
      "clean_orders",
    );
    const restored = restoredBy(snapshot([...swarm.tasks, early]), finishing, [
      ds("daily_revenue"),
    ]);
    expect(names(restored)).toEqual(["write_docs", "write_report"]);
  });

  it("refuses when a finish time is missing rather than guessing the order", () => {
    const { swarm } = flaggedSwarm();
    const tasks = swarm.tasks.map((t) => (t.name === "build_revenue" ? finished(t, null) : t));
    const brokenFinishing = tasks.find((t) => t.name === "build_revenue") as TaskRecord;
    expect(restoredBy(snapshot(tasks), brokenFinishing, [ds("daily_revenue")])).toEqual([]);
  });

  it("leaves running and registered work alone", () => {
    // A running task carries its mark until a run succeeds, but it is not
    // finished work, and restoration only speaks about finished work.
    const { swarm, finishing } = flaggedSwarm();
    const tasks = swarm.tasks.map((t) => {
      if (t.name !== "write_report") return t;
      return { ...t, status: "running" as const };
    });
    const restored = restoredBy(snapshot(tasks), finishing, [ds("daily_revenue")]);
    expect(names(restored)).toEqual(["write_docs"]);
  });

  it("leaves an unrelated flagged branch exactly as it was", () => {
    // A second pipeline in the same swarm, flagged for its own reasons. A redo
    // over here says nothing about ground over there.
    const { swarm, finishing } = flaggedSwarm();
    const otherMid = marked(
      finished(task("other_mid", ["other_source"], ["other_mid_out"]), T1),
      "other_source",
    );
    const otherLeaf = marked(
      finished(task("other_leaf", ["other_mid_out"], ["other_leaf_out"]), T2),
      "other_source",
    );
    const sourceTask = finished(task("other_source_task", [], ["other_source"]), T4);
    const wider = snapshot([...swarm.tasks, sourceTask, otherMid, otherLeaf]);
    const restored = restoredBy(wider, finishing, [ds("daily_revenue")]);
    expect(names(restored)).toEqual(["write_docs", "write_report"]);
  });

  it("restores transitively: a cleared producer frees the task built on it", () => {
    // deep_leaf reads what write_report wrote. write_report clears because its
    // ground stands; its own output was never re-reported, so what deep_leaf
    // read stands too. The leaf is named to sort FIRST, so a single greedy pass
    // would meet it before its producer has cleared — the fixpoint is what
    // makes the order irrelevant.
    const { swarm, finishing } = flaggedSwarm();
    const leaf = marked(
      finished(task("a_deep_leaf", ["revenue_report"], ["leaf_out"]), T3),
      "clean_orders",
    );
    const restored = restoredBy(snapshot([...swarm.tasks, leaf]), finishing, [ds("daily_revenue")]);
    expect(names(restored)).toEqual(["a_deep_leaf", "write_docs", "write_report"]);
  });

  it("refuses on the mark alone, even when every other record looks sound", () => {
    // Artificial on purpose: the producer's report predates the reader, nothing
    // was observed, and yet the reader's mark names its input as the table that
    // moved. In every state the engine writes, another guard also fires here —
    // this pins the mark guard on its own, so defense in depth survives a
    // record shape nobody has enumerated (an old capture, a hand-edited
    // property) without silently depending on the neighbours.
    const producer = marked(finished(task("p_writer", ["seed"], ["p_out"]), T1), "seed");
    const reader = marked(finished(task("r_reader", ["p_out"], ["r_out"]), T2), "p_out");
    const restored = restoredBy(snapshot([producer, reader]), producer, [ds("p_out")]);
    expect(restored).toEqual([]);
  });

  it("restores nothing for a completion by work that carried no mark", () => {
    // The trigger has to be a redo of flagged work. An ordinary task finishing
    // is not new evidence about anyone's ground, however sound the records
    // around a flagged task happen to look at that moment.
    const upstream = finished(task("plain_upstream", ["seed"], ["up_out"]), T1);
    const strange = marked(
      finished(task("strange_leaf", ["up_out"], ["leaf_out"]), T2),
      "elsewhere",
    );
    const restored = restoredBy(snapshot([upstream, strange]), upstream, [ds("up_out")]);
    expect(restored).toEqual([]);
  });

  it("terminates on a cycle of tasks that keep each other flagged", () => {
    // A reads what B writes and B reads what A writes, both stale. Neither can
    // clear while the other holds, and the loop has to notice it stopped
    // making progress rather than spin.
    const trigger = marked(finished(task("trigger", ["seed"], ["trigger_out"]), T1), "seed");
    const a = marked(
      finished(task("cycle_a", ["trigger_out", "cycle_b_out"], ["cycle_a_out"]), T2),
      "seed",
    );
    const b = marked(finished(task("cycle_b", ["cycle_a_out"], ["cycle_b_out"]), T3), "seed");
    const restored = restoredBy(snapshot([trigger, a, b]), trigger, [ds("trigger_out")]);
    expect(restored).toEqual([]);
  });

  it("treats a dataset nothing in the swarm produces as stable ground", () => {
    // raw_orders has no producer here, so there is no recorded claim about it
    // to contradict — the same stance readyToStart takes on outside inputs.
    const { swarm, finishing } = flaggedSwarm();
    const mixed = marked(
      finished(task("write_mixed", ["daily_revenue", "raw_orders"], ["mixed_out"]), T2),
      "clean_orders",
    );
    const restored = restoredBy(snapshot([...swarm.tasks, mixed]), finishing, [
      ds("daily_revenue"),
    ]);
    expect(names(restored)).toEqual(["write_docs", "write_mixed", "write_report"]);
  });
});

describe("two tasks writing one table", () => {
  /*
   * A backfill beside a daily build, two agents appending to one export: legal,
   * ordinary, and until these tests existed, resolved three different ways by
   * three call sites. `affectedBy` kept the LAST registered writer, `engine.ts`
   * kept the FIRST, and `restoredBy` kept the last — so on the same board, which
   * writer counted depended on which function was asking.
   *
   * Nothing recorded says which of two writers produced the bytes standing now.
   * So every rule here is the conservative one: all writers must be settled
   * before a flag comes off, all writers must be finished before a reader
   * starts, and nobody is named as the author of a change two tasks could have
   * made.
   */

  const T1 = "2026-07-21T10:00:00.000Z";
  const T2 = "2026-07-21T11:00:00.000Z";
  const T3 = "2026-07-21T11:30:00.000Z";
  const T4 = "2026-07-21T12:30:00.000Z";

  function finished(record: TaskRecord, at: string | null): TaskRecord {
    return { ...record, finishedAt: at };
  }

  function marked(record: TaskRecord, causedBy: string): TaskRecord {
    return {
      ...record,
      status: "stale",
      stale: {
        causedBy: ds(causedBy),
        causedByTask: null,
        hops: 1,
        changeKind: "schema",
        reason: "test mark",
        since: T4,
        detectedMs: null,
      },
    };
  }

  it("refuses to clear a flag while the table's other writer is still stale", () => {
    /*
     * The reachable false clear. `build_revenue` redoes daily_revenue and it
     * comes back identical, which proves what THAT task writes has not moved —
     * and proves nothing about `backfill_revenue`, which writes the same table
     * and is still flagged. Its redo could put different bytes in daily_revenue
     * at any moment, so the work downstream is not proven sound.
     *
     * The order of the two writers in the swarm is the whole point: the old
     * last-writer-wins map resolved daily_revenue to `build_revenue`, the task
     * that just finished, saw it settled, and took the flags off both readers.
     */
    const clean = finished(task("clean_orders_task", ["raw_orders"], ["clean_orders"]), T4);
    const backfill = marked(
      finished(task("backfill_revenue", ["clean_orders"], ["daily_revenue"]), T1),
      "clean_orders",
    );
    const revenue = marked(
      finished(task("build_revenue", ["clean_orders"], ["daily_revenue"]), T1),
      "clean_orders",
    );
    const report = marked(
      finished(task("write_report", ["daily_revenue"], ["revenue_report"]), T2),
      "clean_orders",
    );
    const docs = marked(
      finished(task("write_docs", ["daily_revenue"], ["pipeline_docs"]), T3),
      "clean_orders",
    );

    const restored = restoredBy(snapshot([clean, backfill, revenue, report, docs]), revenue, [
      ds("daily_revenue"),
    ]);
    expect(names(restored)).toEqual([]);
  });

  it("clears once every writer of the table is settled", () => {
    // The same board with the backfill complete rather than stale. Now both
    // writers of daily_revenue are settled, so the redo does prove the readers
    // sound — the rule above is conservative, not simply refusing.
    const clean = finished(task("clean_orders_task", ["raw_orders"], ["clean_orders"]), T4);
    const backfill = finished(task("backfill_revenue", ["clean_orders"], ["daily_revenue"]), T1);
    const revenue = marked(
      finished(task("build_revenue", ["clean_orders"], ["daily_revenue"]), T1),
      "clean_orders",
    );
    const report = marked(
      finished(task("write_report", ["daily_revenue"], ["revenue_report"]), T2),
      "clean_orders",
    );

    const restored = restoredBy(snapshot([clean, backfill, revenue, report]), revenue, [
      ds("daily_revenue"),
    ]);
    expect(names(restored)).toEqual(["write_report"]);
  });

  it("names nobody as the author of a change either writer could have made", () => {
    // `causedByTask` sends a person to ask an agent what it did. With two
    // writers on one table obsel does not know which to send them to, and a
    // guess costs someone a wasted interrogation of an agent that wrote
    // nothing — the same refusal the unreported-change path already makes.
    const nightly = task("nightly_load", ["raw_orders"], ["clean_orders"]);
    const backfill = task("backfill_load", ["raw_orders"], ["clean_orders"]);
    const revenue = task("build_revenue", ["clean_orders"], ["daily_revenue"]);

    const affected = affectedBy(
      snapshot([nightly, backfill, revenue]),
      [{ dataset: ds("clean_orders"), kind: "content" }],
      NOW,
    );

    expect(names(affected)).toEqual(["build_revenue"]);
    expect(affected[0].mark.causedByTask).toBeNull();
    // The mark itself still fires, and still names the table. Declining to name
    // an author is not declining to report the change.
    expect(affected[0].mark.causedBy).toBe(ds("clean_orders"));
  });

  it("still names the author when exactly one task writes the table", () => {
    const nightly = task("nightly_load", ["raw_orders"], ["clean_orders"]);
    const revenue = task("build_revenue", ["clean_orders"], ["daily_revenue"]);

    const affected = affectedBy(
      snapshot([nightly, revenue]),
      [{ dataset: ds("clean_orders"), kind: "content" }],
      NOW,
    );
    expect(affected[0].mark.causedByTask).toBe(nightly.urn);
  });

  it("holds a task back while any writer of its input is still running", () => {
    // Registration order is the trap: the old map kept the last writer, which
    // here is the finished one, and let the reader start on a table the other
    // writer was in the middle of replacing.
    const slow = task("slow_writer", ["raw_orders"], ["shared_table"], "running");
    const fast = task("fast_writer", ["raw_orders"], ["shared_table"], "complete");
    const consumer = task("consumer", ["shared_table"], ["summary"], "registered");

    const swarm = snapshot([slow, fast, consumer]);
    expect(readyToStart(swarm).map((t) => t.name)).toEqual([]);
    expect(blocked(swarm).map((entry) => entry.waitingOn)).toEqual([["slow_writer"]]);
  });

  it("names every writer a task is waiting on, not the first one found", () => {
    const first = task("first_writer", ["raw_orders"], ["shared_table"], "running");
    const second = task("second_writer", ["raw_orders"], ["shared_table"], "running");
    const consumer = task("consumer", ["shared_table"], ["summary"], "registered");

    const [entry] = blocked(snapshot([first, second, consumer]));
    expect(entry.waitingOn.sort()).toEqual(["first_writer", "second_writer"]);
  });
});

describe("classifyObservation — a straddling reader is not a silent edit", () => {
  // The concurrent-swarm race in miniature. v1 was replaced by v2 through an
  // ordinary report; v3 is a silent edit somebody's read later noticed. A
  // reader can legitimately finish holding any of them, and each verdict
  // below is the only honest account of one of those holds.
  const v1 = fp("schema-1", "content-1");
  const v2 = fp("schema-2", "content-2");
  const v3 = fp("schema-3", "content-3");

  function producer(overrides: Partial<TaskRecord> = {}): TaskRecord {
    return {
      ...task("clean_orders", ["raw_orders"], ["clean_orders"]),
      fingerprints: { [ds("clean_orders")]: v2 },
      ...overrides,
    };
  }

  it("matching the recorded fingerprint is current", () => {
    expect(classifyObservation(producer(), ds("clean_orders"), v2)).toEqual({ kind: "current" });
  });

  it("matching a standing reader notice is current, because the notice is the latest word", () => {
    const noticed = producer({ observed: { [ds("clean_orders")]: v3 } });
    expect(classifyObservation(noticed, ds("clean_orders"), v3)).toEqual({ kind: "current" });
  });

  it("matching the version a re-report replaced is superseded, with the producer as author", () => {
    // The false negative this function exists to close: before it, this
    // observation raised an "unreported change" alarm against a change that
    // was reported in full, and the genuinely stale reader stayed unflagged.
    const rereported = producer({ previousFingerprints: { [ds("clean_orders")]: v1 } });
    expect(classifyObservation(rereported, ds("clean_orders"), v1)).toEqual({
      kind: "superseded",
      by: "report",
    });
  });

  it("matching the recorded version while a notice stands is superseded, author unknown", () => {
    // The reader loaded the table before the silent edit landed. Its work is
    // just as stale, but nobody on record made the change that stranded it.
    const noticed = producer({ observed: { [ds("clean_orders")]: v3 } });
    expect(classifyObservation(noticed, ds("clean_orders"), v2)).toEqual({
      kind: "superseded",
      by: "notice",
    });
  });

  it("matching nothing on record is unknown, which is the unreported-change path", () => {
    const rereported = producer({ previousFingerprints: { [ds("clean_orders")]: v1 } });
    expect(
      classifyObservation(rereported, ds("clean_orders"), fp("schema-x", "content-x")),
    ).toEqual({ kind: "unknown" });
  });

  it("prefers current when previous and current are somehow identical", () => {
    // The engine never writes previous equal to current — an identical
    // re-report keeps the old slot — but the ordering must still hold if the
    // stored state says otherwise: an observation matching what stands is not
    // stale, whatever else it also matches.
    const odd = producer({ previousFingerprints: { [ds("clean_orders")]: v2 } });
    expect(classifyObservation(odd, ds("clean_orders"), v2)).toEqual({ kind: "current" });
  });

  it("still names the reported replacement when a later silent edit is also standing", () => {
    // The reader holds v1: superseded by the v2 report, full stop. The v3
    // notice is a separate fact with its own cascade, and blaming the reader's
    // staleness on the unknown author would erase the one attribution the
    // records genuinely support.
    const both = producer({
      previousFingerprints: { [ds("clean_orders")]: v1 },
      observed: { [ds("clean_orders")]: v3 },
    });
    expect(classifyObservation(both, ds("clean_orders"), v1)).toEqual({
      kind: "superseded",
      by: "report",
    });
  });
});

describe("supersededMark — the mark a straddling reader earns", () => {
  const v1 = fp("schema-1", "content-1");
  const v2 = fp("schema-1", "content-2");

  function producerWithRun(): TaskRecord {
    return {
      ...task("clean_orders", ["raw_orders"], ["clean_orders"]),
      fingerprints: { [ds("clean_orders")]: v2 },
      previousFingerprints: { [ds("clean_orders")]: v1 },
      title: "Orders cleaner",
      run: {
        runner: "codex-cli 0.144.4",
        ms: 40_000,
        outputs: {
          [ds("clean_orders")]: {
            rows: 39,
            columns: ["order_id", "customer", "order_total_usd", "order_date"],
          },
        },
      },
    };
  }

  it("names the producer, the table, and the change kind for a reported replacement", () => {
    const mark = supersededMark(
      ds("clean_orders"),
      producerWithRun(),
      { kind: "superseded", by: "report" },
      { ...v1, columns: ["order_id", "customer", "order_total", "order_date"] },
      NOW,
    );
    expect(mark.causedBy).toBe(ds("clean_orders"));
    expect(mark.causedByTask).toBe(producerWithRun().urn);
    expect(mark.hops).toBe(1);
    expect(mark.changeKind).toBe("content");
    expect(mark.since).toBe(NOW);
    expect(mark.detectedMs).toBeNull();
    expect(mark.reason).toContain("Orders cleaner replaced it before this finished");
    expect(mark.reason).toContain("its rows changed");
  });

  it("carries the column diff between what was read and what now stands", () => {
    const renamed = {
      ...producerWithRun(),
      fingerprints: { [ds("clean_orders")]: fp("schema-2", "content-1") },
    };
    const mark = supersededMark(
      ds("clean_orders"),
      renamed,
      { kind: "superseded", by: "report" },
      { ...v1, columns: ["order_id", "customer", "order_total", "order_date"] },
      NOW,
    );
    expect(mark.changeKind).toBe("schema");
    expect(mark.columns).toEqual({ added: ["order_total_usd"], removed: ["order_total"] });
  });

  it("leaves the author unknown for a noticed replacement, like every mark from that notice", () => {
    const noticed = {
      ...producerWithRun(),
      previousFingerprints: undefined,
      observed: { [ds("clean_orders")]: fp("schema-9", "content-9") },
    };
    const mark = supersededMark(
      ds("clean_orders"),
      noticed,
      { kind: "superseded", by: "notice" },
      v2,
      NOW,
    );
    expect(mark.causedByTask).toBeNull();
    expect(mark.columns).toBeNull();
    expect(mark.reason).toContain("an unreported change replaced it before this finished");
  });

  it("refuses an observation that matches the standing record, rather than fabricating a change", () => {
    expect(() =>
      supersededMark(
        ds("clean_orders"),
        producerWithRun(),
        { kind: "superseded", by: "report" },
        v2,
        NOW,
      ),
    ).toThrow(/matches the standing record/);
  });
});

describe("mergeMark — a second cascade onto already-flagged work", () => {
  /** A mark as `affectedBy` builds one, with its own cause list. */
  function markFor(origin: string, hops: number, kind: ChangeKind = "content"): StaleMark {
    return {
      causedBy: ds(origin),
      causedByTask: null,
      hops,
      changeKind: kind,
      reason: `read ${origin}, and its rows changed after this finished`,
      since: NOW,
      detectedMs: null,
      causes: [
        { causedBy: ds(origin), causedByTask: null, hops, changeKind: kind, since: NOW },
      ],
    };
  }

  it("keeps the earlier cause and adds the new one", () => {
    /*
     * The defect this exists for. Overwriting meant the first cause was gone
     * from the record, so repairing the second left a flag standing with
     * nothing on file explaining why.
     */
    const merged = mergeMark(markFor("raw_a", 1), markFor("raw_b", 2));

    expect(merged.causes?.map((cause) => cause.causedBy)).toEqual([ds("raw_a"), ds("raw_b")]);
  });

  it("leads with the incoming cascade, which is what the board is showing", () => {
    const merged = mergeMark(markFor("raw_a", 1), markFor("raw_b", 2));

    expect(merged.causedBy).toBe(ds("raw_b"));
    expect(merged.hops).toBe(2);
  });

  it("updates a cause seen again rather than listing it twice", () => {
    // The same table changing a second time is one ongoing reason, at its
    // latest distance, not two entries a reader has to reconcile.
    const merged = mergeMark(markFor("raw_a", 3), markFor("raw_a", 1, "schema"));

    expect(merged.causes).toHaveLength(1);
    expect(merged.causes?.[0].hops).toBe(1);
    expect(merged.causes?.[0].changeKind).toBe("schema");
  });

  it("treats a mark written before causes existed as carrying its own", () => {
    /*
     * An older mark has no list and is not causeless: its primary fields ARE
     * its cause. Reading absence as an empty list would discard the reason a
     * standing flag was raised, the first time a new cascade touched it.
     */
    const legacy: StaleMark = { ...markFor("raw_a", 1) };
    delete legacy.causes;

    expect(causesOf(legacy)).toHaveLength(1);
    expect(mergeMark(legacy, markFor("raw_b", 1)).causes?.map((c) => c.causedBy)).toEqual([
      ds("raw_a"),
      ds("raw_b"),
    ]);
  });
});

describe("restoredBy — a redo against a task broken more than once", () => {
  /**
   * `reader` is stale for two reasons: `mid_a`, which `producer_a` writes, and
   * `raw_b`, which nothing here writes and which is therefore never proven.
   */
  function twoCauseSwarm(): SwarmSnapshot {
    const producer = task("producer_a", ["raw_a"], ["mid_a"], "stale");
    const reader = task("reader", ["mid_a", "raw_b"], ["reader_out"], "stale");
    producer.fingerprints = { [ds("mid_a")]: fp("s1", "c1") };
    producer.stale = {
      causedBy: ds("raw_a"),
      causedByTask: null,
      hops: 1,
      changeKind: "content",
      reason: "read raw a, and its rows changed after this finished",
      since: NOW,
      detectedMs: null,
    };
    reader.stale = {
      causedBy: ds("mid_a"),
      causedByTask: null,
      hops: 1,
      changeKind: "content",
      reason: "read mid a, and its rows changed after this finished",
      since: NOW,
      detectedMs: null,
      causes: [
        { causedBy: ds("mid_a"), causedByTask: null, hops: 1, changeKind: "content", since: NOW },
        { causedBy: ds("raw_b"), causedByTask: null, hops: 1, changeKind: "content", since: NOW },
      ],
    };
    return snapshot([producer, reader]);
  }

  it("refuses to clear a task whose other recorded cause is still standing", () => {
    /*
     * `producer_a` redoes `mid_a` identically, which proves that ONE of the
     * reader's two reasons never moved. The other, `raw_b`, is untouched by
     * this redo and is on file. Clearing here would be the one catastrophic
     * answer: declaring sound work that is still standing on ground that moved.
     *
     * Before causes were recorded this was invisible — the reader's single
     * stored cause was `mid_a`, and nothing said `raw_b` had ever broken it.
     */
    const swarm = twoCauseSwarm();
    const finishing = swarm.tasks.find((t) => t.name === "producer_a")!;

    expect(restoredBy(swarm, finishing, [ds("mid_a")])).toEqual([]);
  });

  it("still clears when every recorded cause is accounted for", () => {
    // The same shape with the second cause absent: the redo now answers for
    // everything on file, and refusing here would be a flag nothing can clear.
    const swarm = twoCauseSwarm();
    const reader = swarm.tasks.find((t) => t.name === "reader")!;
    reader.reads = [ds("mid_a")];
    reader.stale = {
      ...reader.stale!,
      causes: [
        { causedBy: ds("mid_a"), causedByTask: null, hops: 1, changeKind: "content", since: NOW },
      ],
    };
    const finishing = swarm.tasks.find((t) => t.name === "producer_a")!;

    // Its own mark names mid_a, which the finishing task just redid identically.
    reader.stale.causedBy = ds("raw_b");
    reader.stale.causes = [
      { causedBy: ds("raw_b"), causedByTask: null, hops: 2, changeKind: "content", since: NOW },
    ];

    expect(restoredBy(swarm, finishing, [ds("mid_a")]).map((r) => r.task.name)).toEqual(["reader"]);
  });
});

describe("affectedBy — saying what the comparison ignored", () => {
  it("names the registered volatile columns in the hop-one sentence", () => {
    /*
     * A reader who knows the table carries a `loaded_at` cannot otherwise tell
     * a real change from the clock moving, and those want opposite responses.
     * The sentence is the only place obsel can say which it is.
     */
    const found = affectedBy(
      demoSwarm(),
      [{ dataset: ds("clean_orders"), kind: "content", excluded: ["loaded_at", "batch_id"] }],
      NOW,
    );

    const direct = found.find((a) => a.task.name === "build_revenue");
    expect(direct?.mark.reason).toContain("except batch_id and loaded_at");
    expect(direct?.mark.reason).toContain("registered as changing every run");
  });

  it("says nothing extra when no columns were excluded", () => {
    // The ordinary mark, which is almost all of them, reads exactly as before.
    const found = affectedBy(demoSwarm(), [{ dataset: ds("clean_orders"), kind: "content" }], NOW);
    const direct = found.find((a) => a.task.name === "build_revenue");
    expect(direct?.mark.reason).toBe("read clean orders, and its rows changed after this finished");
  });

  it("keeps the transitive sentence clear of it", () => {
    // Two hops out the task never read the excluded table, so naming its
    // columns there would explain a comparison this task had no part in.
    const found = affectedBy(
      demoSwarm(),
      [{ dataset: ds("clean_orders"), kind: "content", excluded: ["loaded_at"] }],
      NOW,
    );
    expect(found.find((a) => a.task.name === "write_report")?.mark.reason).not.toContain(
      "loaded_at",
    );
  });
});
