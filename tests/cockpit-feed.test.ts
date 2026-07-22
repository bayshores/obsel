import { describe, expect, it } from "vitest";

import { FEED_LIMIT, appendEvents, diffSnapshots } from "@/src/features/cockpit/feed";
import type { FeedEvent } from "@/src/features/cockpit/feed";
import type {
  OutputFingerprint,
  SwarmSnapshot,
  TaskRecord,
  TaskStatus,
} from "@/src/server/coordinator/types";

const AT_1 = "2026-07-21T14:22:07.000Z";
const AT_2 = "2026-07-21T14:22:08.000Z";

function ds(name: string): string {
  return `urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.${name},PROD)`;
}
function taskUrn(name: string): string {
  return `urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),${name})`;
}
function fp(schema: string, content: string): OutputFingerprint {
  return { schema, content };
}

function task(name: string, status: TaskStatus = "complete"): TaskRecord {
  return {
    urn: taskUrn(name),
    name,
    reads: [ds("raw")],
    writes: [ds(`${name}_out`)],
    status,
    fingerprints: {},
    finishedAt: status === "complete" || status === "stale" ? AT_1 : null,
    startedAt: null,
    run: null,
    stale: null,
  };
}

function snap(tasks: TaskRecord[], at = AT_1): SwarmSnapshot {
  return { flow: "urn:li:dataFlow:(obsel,orders_pipeline,prod)", tasks, at };
}

function kinds(events: FeedEvent[]): string[] {
  return events.map((e) => e.kind);
}

describe("diffSnapshots — the first read invents no history", () => {
  it("emits nothing when there is no previous snapshot", () => {
    expect(diffSnapshots(null, snap([task("a"), task("b")]))).toEqual([]);
  });

  it("emits nothing when nothing differs", () => {
    const tasks = [task("a"), task("b")];
    expect(diffSnapshots(snap(tasks), snap(tasks, AT_2))).toEqual([]);
  });

  it("emits nothing for a re-read of an identical but distinct object", () => {
    const before = snap([task("a")]);
    const after = snap(JSON.parse(JSON.stringify(before.tasks)) as TaskRecord[], AT_2);
    expect(diffSnapshots(before, after)).toEqual([]);
  });
});

describe("diffSnapshots — status transitions", () => {
  it("reports a task going stale, and quotes the mark it was given", () => {
    const before = [task("build_revenue")];
    const after = [task("build_revenue", "stale")];
    after[0].stale = {
      causedBy: ds("clean_orders"),
      causedByTask: taskUrn("clean_orders"),
      hops: 1,
      changeKind: "schema",
      reason: "read clean_orders, and its columns changed after this finished",
      since: AT_2,
      detectedMs: 118,
    };
    const events = diffSnapshots(snap(before), snap(after, AT_2));
    expect(kinds(events)).toEqual(["went-stale"]);
    expect(events[0].mark?.hops).toBe(1);
    expect(events[0].mark?.reason).toContain("columns changed");
    expect(events[0].observedAt).toBe(AT_2);
  });

  it("distinguishes finishing from earning a mark back", () => {
    const plain = diffSnapshots(snap([task("a", "running")]), snap([task("a", "complete")], AT_2));
    expect(kinds(plain)).toEqual(["finished"]);

    const wasStale = task("a", "running");
    wasStale.stale = {
      causedBy: ds("x"),
      causedByTask: null,
      hops: 1,
      changeKind: "schema",
      reason: "r",
      since: AT_1,
      detectedMs: null,
    };
    const recovered = diffSnapshots(snap([wasStale]), snap([task("a", "complete")], AT_2));
    expect(kinds(recovered)).toEqual(["cleared"]);
  });

  it("reports a mark disappearing even when the status did not move", () => {
    const before = task("a", "complete");
    before.stale = {
      causedBy: ds("x"),
      causedByTask: null,
      hops: 2,
      changeKind: "content",
      reason: "r",
      since: AT_1,
      detectedMs: 5,
    };
    expect(kinds(diffSnapshots(snap([before]), snap([task("a", "complete")], AT_2)))).toEqual([
      "cleared",
    ]);
  });

  it("reports starting", () => {
    expect(
      kinds(diffSnapshots(snap([task("a", "registered")]), snap([task("a", "running")], AT_2))),
    ).toEqual(["started"]);
  });
});

describe("diffSnapshots — membership", () => {
  it("says a task appeared, not that it was registered", () => {
    const events = diffSnapshots(snap([task("a")]), snap([task("a"), task("b")], AT_2));
    expect(kinds(events)).toEqual(["appeared"]);
    expect(events[0].taskName).toBe("b");
  });

  it("says a task left, not that it was deleted", () => {
    const events = diffSnapshots(snap([task("a"), task("b")]), snap([task("a")], AT_2));
    expect(kinds(events)).toEqual(["left"]);
    expect(events[0].taskName).toBe("b");
  });
});

describe("diffSnapshots — fingerprints", () => {
  it("reports an output whose fingerprint moved", () => {
    const before = task("clean_orders");
    before.fingerprints = { [ds("clean_out")]: fp("aaa", "ccc") };
    const after = task("clean_orders");
    after.fingerprints = { [ds("clean_out")]: fp("bbb", "ccc") };

    const events = diffSnapshots(snap([before]), snap([after], AT_2));
    expect(kinds(events)).toEqual(["output-changed"]);
    expect(events[0].dataset).toBe(ds("clean_out"));
  });

  it("does NOT call a first fingerprint a change", () => {
    // Mirrors compareFingerprints returning null on a first run: there was
    // nothing to compare against, so nothing moved.
    const before = task("a");
    const after = task("a");
    after.fingerprints = { [ds("a_out")]: fp("aaa", "ccc") };
    expect(diffSnapshots(snap([before]), snap([after], AT_2))).toEqual([]);
  });

  it("does not report an identical re-run", () => {
    const before = task("a");
    before.fingerprints = { [ds("a_out")]: fp("aaa", "ccc") };
    const after = task("a");
    after.fingerprints = { [ds("a_out")]: fp("aaa", "ccc") };
    after.finishedAt = AT_2;
    expect(diffSnapshots(snap([before]), snap([after], AT_2))).toEqual([]);
  });
});

describe("diffSnapshots — never asserts an absence", () => {
  it("has no event kind that claims nothing happened", () => {
    // The engine writes a completion BEFORE it writes any mark, so a diff can
    // truthfully observe "new output, no mark" while a cascade is in flight.
    // The safe design is for no event to make a negative claim at all.
    const before = task("clean_orders");
    before.fingerprints = { [ds("clean_out")]: fp("aaa", "ccc") };
    const after = task("clean_orders");
    after.fingerprints = { [ds("clean_out")]: fp("bbb", "ccc") };

    const events = diffSnapshots(snap([before]), snap([after, task("downstream")], AT_2));
    for (const event of events) {
      expect([
        "appeared",
        "started",
        "finished",
        "went-stale",
        "cleared",
        "output-changed",
        "left",
      ]).toContain(event.kind);
    }
    // specifically: nothing that could be read as an all-clear
    expect(kinds(events)).not.toContain("nothing-stale");
    expect(kinds(events)).not.toContain("clean");
  });
});

describe("diffSnapshots — determinism", () => {
  it("gives the same ids for the same pair of snapshots", () => {
    const before = snap([task("a", "running")]);
    const after = snap([task("a", "complete")], AT_2);
    expect(diffSnapshots(before, after).map((e) => e.id)).toEqual(
      diffSnapshots(before, after).map((e) => e.id),
    );
  });

  it("stamps events with the coordinator's snapshot time, not a browser clock", () => {
    const events = diffSnapshots(snap([task("a", "running")]), snap([task("a", "complete")], AT_2));
    expect(events[0].observedAt).toBe(AT_2);
  });
});

describe("appendEvents", () => {
  function ev(id: string): FeedEvent {
    return {
      id,
      kind: "finished",
      taskUrn: "u",
      taskName: "t",
      observedAt: AT_1,
      dataset: null,
      mark: null,
    };
  }

  it("keeps the same array when nothing is new", () => {
    const existing = [ev("1")];
    expect(appendEvents(existing, [])).toBe(existing);
    expect(appendEvents(existing, [ev("1")])).toBe(existing);
  });

  it("puts the newest first", () => {
    const result = appendEvents([ev("old")], [ev("a"), ev("b")]);
    expect(result.map((e) => e.id)).toEqual(["b", "a", "old"]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: FEED_LIMIT + 12 }, (_, i) => ev(`e${i}`));
    expect(appendEvents([], many)).toHaveLength(FEED_LIMIT);
  });

  it("never duplicates an event a re-poll re-derives", () => {
    const first = appendEvents([], [ev("a")]);
    expect(appendEvents(first, [ev("a")])).toHaveLength(1);
  });
});
