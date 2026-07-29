import { describe, expect, it } from "vitest";

import {
  clockTime,
  currentChange,
  detectionTiming,
  inDependencyOrder,
  lastReportAt,
  summaryLine,
  totals,
} from "@/src/features/dashboard/timing";
import { STALE_TAG_URN } from "@/src/server/datahub/urns";
import type { StaleMark, TaskRecord, TaskStatus } from "@/src/server/coordinator/types";

const NOW = "2026-07-21T14:22:07.000Z";
const LATER = "2026-07-21T14:30:00.000Z";

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

function mark(overrides: Partial<StaleMark> = {}): StaleMark {
  return {
    causedBy: ds("clean_orders"),
    causedByTask: taskUrn("clean_orders"),
    hops: 1,
    changeKind: "schema",
    reason: "read clean orders, and its columns changed after this finished",
    since: NOW,
    detectedMs: 118,
    ...overrides,
  };
}

function pipeline(): TaskRecord[] {
  return [
    task("clean_orders", ["raw_orders"], ["clean_orders"]),
    task("build_revenue", ["clean_orders"], ["daily_revenue"]),
    task("write_report", ["daily_revenue"], ["revenue_report"]),
    task("write_docs", ["daily_revenue"], ["pipeline_docs"]),
  ];
}

function cascaded(): TaskRecord[] {
  const tasks = pipeline();
  tasks[1].status = "stale";
  tasks[1].stale = mark({ hops: 1, detectedMs: 118 });
  tasks[2].status = "stale";
  tasks[2].stale = mark({ hops: 2, detectedMs: 96 });
  tasks[3].status = "stale";
  tasks[3].stale = mark({ hops: 2, detectedMs: 104 });
  return tasks;
}

describe("detectionTiming — never reports a number nobody measured", () => {
  it("returns null when nothing is stale", () => {
    expect(detectionTiming(pipeline())).toBeNull();
  });

  it("reports the coordinator's own measurement, worst case across the set", () => {
    const timing = detectionTiming(cascaded());
    expect(timing).not.toBeNull();
    expect(timing?.ms).toBe(118);
    expect(timing?.source).toBe("clean_orders");
    expect(timing?.flagged).toBe(3);
  });

  it("returns null when every mark predates detectedMs being recorded", () => {
    const tasks = cascaded();
    for (const t of tasks) {
      if (t.stale !== null) t.stale = { ...t.stale, detectedMs: null };
    }
    expect(detectionTiming(tasks)).toBeNull();
  });

  it("ignores a negative or non-finite measurement rather than showing it", () => {
    const tasks = cascaded();
    tasks[1].stale = mark({ hops: 1, detectedMs: -5 });
    tasks[2].stale = mark({ hops: 2, detectedMs: Number.NaN });
    tasks[3].stale = mark({ hops: 2, detectedMs: 42 });
    expect(detectionTiming(tasks)?.ms).toBe(42);
  });

  it("returns null when the mark names no causing task", () => {
    const tasks = cascaded();
    for (const t of tasks) {
      if (t.stale !== null) t.stale = { ...t.stale, causedByTask: null };
    }
    expect(detectionTiming(tasks)).toBeNull();
  });

  it("counts only marks from the newest change, not every mark on the board", () => {
    const tasks = cascaded();
    // an older, unrelated cascade from a different task
    tasks[3].stale = mark({
      hops: 1,
      causedByTask: taskUrn("something_else"),
      causedBy: ds("other"),
      since: "2026-07-21T09:00:00.000Z",
    });
    expect(detectionTiming(tasks)?.flagged).toBe(2);
  });

  it("prefers the most recent change when two are on the board", () => {
    const tasks = cascaded();
    tasks[3].stale = mark({
      hops: 1,
      causedByTask: taskUrn("write_report"),
      since: LATER,
      detectedMs: 7,
    });
    const timing = detectionTiming(tasks);
    expect(timing?.source).toBe("write_report");
    expect(timing?.ms).toBe(7);
    expect(timing?.flagged).toBe(1);
  });

  it("ignores a mark carried by a task that is not itself stale", () => {
    const tasks = pipeline();
    // the re-run case: running, mark still attached, not yet earned back
    tasks[1].status = "running";
    tasks[1].stale = mark();
    expect(detectionTiming(tasks)).toBeNull();
  });
});

describe("totals", () => {
  it("counts a calm swarm without inventing a timing", () => {
    expect(totals(pipeline())).toEqual({
      tasks: 4,
      finished: 4,
      stale: 0,
      timing: null,
      marked: 0,
      // No task in this fixture carries a `tags` key, which is exactly what a
      // snapshot captured before obsel read tags back looks like.
      tagged: null,
      leftOver: null,
    });
  });

  it("counts marks without claiming a hop count the graph already labels", () => {
    const t = totals(cascaded());
    expect(t.stale).toBe(3);
    expect(t.marked).toBe(3);
    expect(t.timing?.ms).toBe(118);
    expect(t).not.toHaveProperty("deepestReach");
  });

  it("counts stale work as finished — it ran, it is just no longer trustworthy", () => {
    expect(totals(cascaded()).finished).toBe(4);
  });

  it("counts nothing as finished before anything has run", () => {
    const tasks = pipeline().map((t) => ({ ...t, status: "registered" as const }));
    const result = totals(tasks);
    expect(result.finished).toBe(0);
    expect(result.stale).toBe(0);
  });
});

describe("totals — what obsel wrote back into DataHub", () => {
  /** A snapshot read by a build that reads tags: every task carries the key. */
  function withTags(tasks: TaskRecord[], tagged: string[]): TaskRecord[] {
    return tasks.map((task) => {
      const has = tagged.includes(task.name);
      return { ...task, tags: has ? [STALE_TAG_URN] : [], staleTagged: has };
    });
  }

  it("counts every confirmed write once the tags have landed", () => {
    const t = totals(withTags(cascaded(), ["build_revenue", "write_report", "write_docs"]));
    expect(t.marked).toBe(3);
    expect(t.tagged).toBe(3);
    expect(t.leftOver).toBe(0);
  });

  it("reads low rather than wrong while a write is still in flight", () => {
    // obsel writes the mark first and the tag second, and DataHub's writes are
    // asynchronous, so this is a moment every real cascade passes through. It must
    // count what DataHub actually reports, not what obsel intends to write.
    const t = totals(withTags(cascaded(), ["build_revenue", "write_report"]));
    expect(t.marked).toBe(3);
    expect(t.tagged).toBe(2);
  });

  it("says it does not know, rather than zero, on a snapshot with no tag information", () => {
    // The distinction that matters: `0 of 3` would claim DataHub is missing three
    // tags. Null says obsel never looked. Understating obsel's own contribution is
    // as much a false claim as overstating it.
    const t = totals(cascaded());
    expect(t.marked).toBe(3);
    expect(t.tagged).toBeNull();
    expect(t.leftOver).toBeNull();
  });

  it("counts a tag left on work obsel considers clean", () => {
    // A reset done by hand clears the properties and leaves the tag, so DataHub
    // shows a stale badge on a job obsel says is fine. This never resolves itself
    // by waiting, which is why it is counted separately from a shortfall.
    const t = totals(withTags(pipeline(), ["write_docs"]));
    expect(t.marked).toBe(0);
    expect(t.tagged).toBe(0);
    expect(t.leftOver).toBe(1);
  });

  it("does not count an unrelated tag as obsel's own", () => {
    const tasks = cascaded().map((task) => ({
      ...task,
      tags: ["urn:li:tag:pii"],
      staleTagged: false,
    }));
    const t = totals(tasks);
    expect(t.tagged).toBe(0);
    expect(t.leftOver).toBe(0);
  });
});

describe("summaryLine — says what was observed, never 'all clear'", () => {
  it("distinguishes nothing-has-run from everything-checks-out", () => {
    expect(summaryLine(4, 0, 0)).toContain("nothing can be out of date yet");
    expect(summaryLine(4, 4, 0)).toContain("none of the tables they read has changed since");
  });

  it("states the ratio against finished work, not against every task", () => {
    expect(summaryLine(4, 4, 3)).toBe(
      "3 of 4 finished agents are out of date, because a table they read changed afterwards.",
    );
  });

  it("handles an empty swarm and the singular", () => {
    expect(summaryLine(0, 0, 0)).toBe("No agents set up yet.");
    expect(summaryLine(1, 1, 1)).toContain("1 of 1 finished agent is");
  });

  it("agrees every branch with the count it is actually about, at a swarm of one", () => {
    /*
     * The live region is the only thing that reads this board to a screen reader,
     * and every branch of it was written for the demo's four. A swarm of one was
     * an impossible state until the board could register tasks one at a time.
     */
    expect(summaryLine(1, 0, 0)).toBe(
      "1 agent is set up. None has finished, so nothing can be out of date yet.",
    );
    expect(summaryLine(1, 1, 0)).toBe(
      "1 of 1 agent has finished, and none of the tables it read has changed since.",
    );
    expect(summaryLine(1, 1, 1)).toBe(
      "1 of 1 finished agent is out of date, because a table it read changed afterwards.",
    );
  });

  it("keeps the noun plural when one of several finished agents is out of date", () => {
    // The noun counts the finished work; only the verb and the pronoun count the
    // stale part. Keying all three to `stale` produced "1 of 3 finished agent is".
    expect(summaryLine(4, 3, 1)).toBe(
      "1 of 3 finished agents is out of date, because a table it read changed afterwards.",
    );
  });

  it("bounds the quiet claim with the last report, and only the quiet claim", () => {
    // "Nothing has changed" is really "nothing has changed that anyone
    // reported": a table rewritten by something that never reports is invisible
    // until the next honest read, so an unbounded all-clear claims more than
    // obsel can know. The loud branch needs no bound; a mark carries its own
    // timestamp.
    expect(summaryLine(4, 4, 0, "2026-07-23T17:42:07.000Z")).toContain("as of the last report at");
    expect(summaryLine(4, 4, 3, "2026-07-23T17:42:07.000Z")).not.toContain("as of");
    // No timestamp available is stated as nothing rather than as a guess.
    expect(summaryLine(4, 4, 0)).not.toContain("as of");
  });
});

describe("lastReportAt — the edge of what obsel has been told", () => {
  /** A record with only its report stamps mattering. */
  function stamped(name: string, finishedAt: string | null, startedAt: string | null): TaskRecord {
    return { ...task(name, [], []), finishedAt, startedAt };
  }

  it("returns the newest start or finish across every task", () => {
    // A start counts as a report: obsel heard from an agent, even though no
    // completion has landed yet.
    const tasks = [
      stamped("a", "2026-07-23T10:00:00.000Z", "2026-07-23T09:00:00.000Z"),
      stamped("b", null, "2026-07-23T11:30:00.000Z"),
    ];
    expect(lastReportAt(tasks)).toBe("2026-07-23T11:30:00.000Z");
  });

  it("returns null when nothing has ever reported, never a guess", () => {
    expect(lastReportAt([stamped("a", null, null)])).toBeNull();
    expect(lastReportAt([])).toBeNull();
  });

  it("skips an unparseable stamp rather than electing it", () => {
    const tasks = [
      stamped("a", "not a date", null),
      stamped("b", "2026-07-23T10:00:00.000Z", null),
    ];
    expect(lastReportAt(tasks)).toBe("2026-07-23T10:00:00.000Z");
  });
});

describe("clockTime — one format, because two panels show the same instants", () => {
  it("is eight characters, so the graph can reserve width for it", () => {
    expect(clockTime(NOW)).toHaveLength(8);
    expect(clockTime(NOW)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("never renders a bare null or an unparseable string into the UI", () => {
    expect(clockTime(null)).toBe("--:--:--");
    expect(clockTime("not a date")).toBe("--:--:--");
  });
});

describe("inDependencyOrder", () => {
  it("puts a task after whatever produces the data it reads", () => {
    const names = inDependencyOrder(pipeline()).map((t) => t.name);
    expect(names.indexOf("clean_orders")).toBeLessThan(names.indexOf("build_revenue"));
    expect(names.indexOf("build_revenue")).toBeLessThan(names.indexOf("write_docs"));
    expect(names.indexOf("build_revenue")).toBeLessThan(names.indexOf("write_report"));
  });

  it("is stable — the same input always gives the same order", () => {
    const once = inDependencyOrder(pipeline()).map((t) => t.name);
    const twice = inDependencyOrder([...pipeline()].reverse()).map((t) => t.name);
    expect(twice).toEqual(once);
  });

  it("drops nothing when the graph has a cycle", () => {
    const a = task("a", ["y"], ["x"]);
    const b = task("b", ["x"], ["y"]);
    expect(
      inDependencyOrder([a, b])
        .map((t) => t.name)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("does not reorder when only a status changes", () => {
    const before = inDependencyOrder(pipeline()).map((t) => t.name);
    const after = inDependencyOrder(cascaded()).map((t) => t.name);
    expect(after).toEqual(before);
  });
});

describe("currentChange — one answer to 'which change?'", () => {
  it("returns null when nothing is stale", () => {
    expect(currentChange(pipeline())).toBeNull();
  });

  it("picks the most recent mark, not the first in array order", () => {
    const tasks = cascaded();
    tasks[3].stale = mark({ causedBy: ds("later_table"), since: LATER });
    expect(currentChange(tasks)?.causedBy).toBe(ds("later_table"));
  });

  it("agrees with detectionTiming about which change is current", () => {
    const tasks = cascaded();
    tasks[3].stale = mark({
      causedBy: ds("later_table"),
      causedByTask: taskUrn("write_report"),
      since: LATER,
      detectedMs: 7,
    });
    // the graph captions currentChange's dataset; the ribbon times
    // detectionTiming's source. They must describe the same event.
    expect(currentChange(tasks)?.causedByTask).toBe(taskUrn("write_report"));
    expect(detectionTiming(tasks)?.source).toBe("write_report");
  });

  it("is deterministic when two marks share a timestamp", () => {
    const a = pipeline();
    a[1].status = "stale";
    a[1].stale = mark({ causedBy: ds("zzz") });
    a[2].status = "stale";
    a[2].stale = mark({ causedBy: ds("aaa") });
    const b = [a[2], a[1], a[0], a[3]];
    expect(currentChange(a)?.causedBy).toBe(currentChange(b)?.causedBy);
    expect(currentChange(a)?.causedBy).toBe(ds("aaa"));
  });

  it("ignores a mark carried by work that is not itself stale", () => {
    const tasks = pipeline();
    tasks[1].status = "running";
    tasks[1].stale = mark();
    expect(currentChange(tasks)).toBeNull();
  });
});
