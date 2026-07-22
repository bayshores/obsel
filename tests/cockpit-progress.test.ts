/**
 * The activity line — what an agent is doing, and what it did.
 *
 * These functions exist because a run that had hung and a run that was fine
 * looked identical on the board for as long as the agent took. The tests that
 * matter most here are the ones asserting that nothing is shown: an absent
 * measurement has to render as nothing, never as a zero, because "took 0 ms" is
 * a reading and "we were not told" is not.
 */

import { describe, expect, it } from "vitest";

import {
  activityNote,
  formatDuration,
  inFlightMs,
  rowsWritten,
  stampLabel,
} from "@/src/features/cockpit/progress";
import { clockTime } from "@/src/features/cockpit/timing";
import type { RunDetail, StaleMark, TaskRecord, TaskStatus } from "@/src/server/coordinator/types";

const STARTED = "2026-07-21T14:22:00.000Z";
const FINISHED = "2026-07-21T14:22:51.000Z";

function ds(name: string): string {
  return `urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.${name},PROD)`;
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const status: TaskStatus = overrides.status ?? "complete";
  return {
    urn: "urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),clean_orders)",
    name: "clean_orders",
    reads: [ds("raw_orders")],
    writes: [ds("clean_orders")],
    status,
    fingerprints: {},
    finishedAt: status === "complete" || status === "stale" ? FINISHED : null,
    startedAt: null,
    run: null,
    stale: null,
    ...overrides,
  };
}

function run(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    runner: "codex-cli 0.144.4",
    ms: 51_128,
    outputs: {
      [ds("clean_orders")]: {
        rows: 39,
        columns: ["order_id", "customer", "order_total", "order_date"],
      },
    },
    ...overrides,
  };
}

function mark(): StaleMark {
  return {
    causedBy: ds("clean_orders"),
    causedByTask: null,
    hops: 1,
    changeKind: "schema",
    reason: "read clean_orders, and its columns changed after this finished",
    since: "2026-07-21T14:25:00.000Z",
    detectedMs: 3216,
  };
}

describe("inFlightMs — one clock, or no number at all", () => {
  it("measures a running task against the snapshot that observed it", () => {
    const t = task({ status: "running", startedAt: STARTED });
    expect(inFlightMs(t, "2026-07-21T14:22:34.000Z")).toBe(34_000);
  });

  it("says nothing about a task that is not running", () => {
    // The elapsed is arithmetically available here — startedAt is set and the
    // snapshot is later. It is withheld because "in flight for" is a claim
    // about work happening now, and this work is over.
    const t = task({ status: "complete", startedAt: STARTED });
    expect(inFlightMs(t, "2026-07-21T14:23:00.000Z")).toBeNull();
  });

  it("returns null when obsel never stamped a start", () => {
    const t = task({ status: "running", startedAt: null });
    expect(inFlightMs(t, "2026-07-21T14:22:34.000Z")).toBeNull();
  });

  it("returns null when there is no snapshot timestamp to measure against", () => {
    const t = task({ status: "running", startedAt: STARTED });
    expect(inFlightMs(t, null)).toBeNull();
  });

  it("returns null on an unparseable timestamp rather than NaN", () => {
    expect(inFlightMs(task({ status: "running", startedAt: "not a date" }), STARTED)).toBeNull();
    expect(inFlightMs(task({ status: "running", startedAt: STARTED }), "not a date")).toBeNull();
  });

  it("returns null rather than a negative when the snapshot predates the start", () => {
    // Real: a poll can be stamped fractionally before the startedAt write it
    // raced. Clamping to zero would present a contradiction as a reading.
    const t = task({ status: "running", startedAt: "2026-07-21T14:22:10.000Z" });
    expect(inFlightMs(t, "2026-07-21T14:22:09.000Z")).toBeNull();
  });
});

describe("formatDuration", () => {
  it("keeps whole milliseconds below a second", () => {
    expect(formatDuration(60)).toBe("60 ms");
    expect(formatDuration(999)).toBe("999 ms");
  });

  it("uses one decimal for seconds, the precision the agent reports", () => {
    expect(formatDuration(1000)).toBe("1.0 s");
    expect(formatDuration(51_128)).toBe("51.1 s");
  });

  it("switches to minutes past sixty seconds, where the decimal is noise", () => {
    expect(formatDuration(60_000)).toBe("1 m 00 s");
    expect(formatDuration(135_900)).toBe("2 m 16 s");
  });

  it("refuses to format a negative or non-finite duration as a number", () => {
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("activityNote — shows nothing rather than inventing something", () => {
  it("reports a running agent's elapsed", () => {
    const t = task({ status: "running", startedAt: STARTED });
    expect(activityNote(t, "2026-07-21T14:22:34.000Z")).toBe("in flight for 34.0 s");
  });

  it("is null for a running agent obsel never stamped, not 'in flight for 0 ms'", () => {
    const t = task({ status: "running", startedAt: null });
    expect(activityNote(t, "2026-07-21T14:22:34.000Z")).toBeNull();
  });

  it("reports what did the work, how long, and what came out", () => {
    const t = task({ status: "complete", run: run() });
    expect(activityNote(t, null)).toBe(
      "codex-cli 0.144.4 · 51.1 s · 39 rows · order_id, customer, order_total, order_date",
    );
  });

  it("is null for a finished task whose agent reported no detail", () => {
    // An agent is not obliged to report. obsel does not fill the gap in.
    expect(activityNote(task({ status: "complete", run: null }), null)).toBeNull();
  });

  it("still reports the run of a task that has since gone stale", () => {
    // The work is no longer trustworthy; the record of how it was produced is
    // still true, and it is what a reader needs to judge the mark.
    const t = task({ status: "stale", run: run(), stale: mark() });
    expect(activityNote(t, null)).toContain("codex-cli 0.144.4");
    expect(activityNote(t, null)).toContain("39 rows");
  });

  it("says row, not rows, for one row", () => {
    const t = task({
      status: "complete",
      run: run({ outputs: { [ds("clean_orders")]: { rows: 1, columns: ["order_id"] } } }),
    });
    expect(activityNote(t, null)).toContain("1 row ");
  });

  it("sums rows and merges columns across every output a task wrote", () => {
    const t = task({
      status: "complete",
      run: run({
        outputs: {
          [ds("a")]: { rows: 5, columns: ["section", "heading"] },
          [ds("b")]: { rows: 4, columns: ["heading", "text"] },
        },
      }),
    });
    const note = activityNote(t, null);
    expect(note).toContain("9 rows");
    // "heading" once, not twice — a duplicated column reads as a real duplicate
    // column in the data.
    expect(note).toContain("section, heading, text");
  });

  it("omits the row count when a run reported no outputs at all", () => {
    const t = task({ status: "complete", run: run({ outputs: {} }) });
    expect(rowsWritten(t)).toBeNull();
    expect(activityNote(t, null)).toBe("codex-cli 0.144.4 · 51.1 s");
  });
});

describe("stampLabel — a running task is not dated by its last completion", () => {
  it("shows when a running task started, not when it previously finished", () => {
    // The defect this exists to prevent: finishedAt survives across runs by
    // design, so a re-running task displayed "finished 14:22:51" while it was
    // visibly working — dating live work to a moment in the past.
    const t = task({ status: "running", startedAt: STARTED, finishedAt: FINISHED });
    expect(stampLabel(t, clockTime)).toBe(`started ${clockTime(STARTED)}`);
  });

  it("shows the mark's instant for stale work, since that is what the row explains", () => {
    const t = task({ status: "stale", stale: mark() });
    expect(stampLabel(t, clockTime)).toBe(`marked ${clockTime(mark().since)}`);
  });

  it("shows the completion for finished work", () => {
    expect(stampLabel(task({ status: "complete" }), clockTime)).toBe(
      `finished ${clockTime(FINISHED)}`,
    );
  });

  it("shows nothing for work that has never run", () => {
    expect(stampLabel(task({ status: "registered" }), clockTime)).toBe("");
  });

  it("falls back to the completion when a running task has no stamped start", () => {
    const t = task({ status: "running", startedAt: null, finishedAt: null });
    expect(stampLabel(t, clockTime)).toBe("");
  });
});
