/**
 * What a reader sees where a code identifier would otherwise be.
 *
 * The load-bearing property is the fallback: no task or table name is hardcoded
 * anywhere in the dashboard, so a pipeline this repository has never seen has to
 * render in words rather than in snake_case. The tests below pin both halves —
 * the declared title wins when there is one, and the humanised identifier
 * carries the rest.
 */

import { describe, expect, it } from "vitest";

import {
  agreeing,
  datasetTitle,
  flowLine,
  humanize,
  shortName,
  taskTitle,
} from "@/src/features/dashboard/naming";
import { shortName as serverShortName } from "@/src/server/coordinator/staleness";
import type { TaskRecord } from "@/src/server/coordinator/types";

function ds(name: string): string {
  return `urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.${name},PROD)`;
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    urn: "urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),clean_orders)",
    name: "clean_orders",
    reads: [ds("raw_orders")],
    writes: [ds("clean_orders")],
    status: "complete",
    fingerprints: {},
    finishedAt: null,
    startedAt: null,
    run: null,
    stale: null,
    ...overrides,
  };
}

describe("shortName", () => {
  it("takes the last path segment out of a dataset URN", () => {
    expect(shortName(ds("clean_orders"))).toBe("clean_orders");
  });

  it("still agrees with the coordinator's copy after moving modules", () => {
    for (const name of ["raw_orders", "clean_orders", "daily_revenue", "pipeline_docs"]) {
      expect(shortName(ds(name))).toBe(serverShortName(ds(name)));
    }
  });

  it("returns the input unchanged when it is not a URN at all", () => {
    expect(shortName("clean_orders")).toBe("clean_orders");
  });
});

describe("humanize", () => {
  it("replaces underscores and nothing else", () => {
    expect(humanize("clean_orders")).toBe("clean orders");
    expect(humanize("average_order_value")).toBe("average order value");
  });

  it("leaves a name that needs no help alone", () => {
    expect(humanize("orders")).toBe("orders");
  });

  it("does not invent capitalization — a guessed name is worse than a plain one", () => {
    expect(humanize("clean_orders")).not.toBe("Clean Orders");
  });
});

describe("taskTitle", () => {
  it("prefers the title the task registered", () => {
    expect(taskTitle(task({ title: "Orders cleaner" }))).toBe("Orders cleaner");
  });

  it("falls back to the humanised identifier when none was registered", () => {
    expect(taskTitle(task())).toBe("clean orders");
    expect(taskTitle(task({ title: null }))).toBe("clean orders");
  });

  it("treats an empty title as absent rather than rendering a blank label", () => {
    expect(taskTitle(task({ title: "" }))).toBe("clean orders");
  });

  it("works on a record captured before the field existed", () => {
    // `examples/` holds exactly this shape: no `title` key at all.
    const legacy: Pick<TaskRecord, "name"> = { name: "write_docs" };
    expect(taskTitle(legacy)).toBe("write docs");
  });
});

describe("datasetTitle", () => {
  it("humanises the table name out of its URN", () => {
    expect(datasetTitle(ds("daily_revenue"))).toBe("daily revenue");
  });

  it("never returns a URN fragment — the whole point is that no colon reaches the screen", () => {
    expect(datasetTitle(ds("clean_orders"))).not.toContain("urn:");
  });
});

describe("flowLine", () => {
  it("states what a task reads and writes, in table names a person can read", () => {
    expect(flowLine(task())).toBe("reads raw orders · writes clean orders");
  });

  it("names every input when a task reads more than one", () => {
    expect(flowLine(task({ reads: [ds("raw_orders"), ds("fx_rates")] }))).toBe(
      "reads raw orders, fx rates · writes clean orders",
    );
  });

  it("drops the half that does not apply rather than printing an empty clause", () => {
    expect(flowLine(task({ reads: [] }))).toBe("writes clean orders");
    expect(flowLine(task({ writes: [] }))).toBe("reads raw orders");
  });

  it("says so plainly when a task declares neither", () => {
    expect(flowLine(task({ reads: [], writes: [] }))).toBe("declares no inputs or outputs");
  });
});

describe("agreeing", () => {
  it("gives the singular at exactly one and the plural everywhere else", () => {
    expect(agreeing(1, "agent")).toBe("agent");
    expect(agreeing(0, "agent")).toBe("agents");
    expect(agreeing(2, "agent")).toBe("agents");
    expect(agreeing(40, "agent")).toBe("agents");
  });

  it("takes an explicit plural for the pairs that do not take an s", () => {
    expect(agreeing(1, "is", "are")).toBe("is");
    expect(agreeing(3, "is", "are")).toBe("are");
    expect(agreeing(1, "agent has", "agents have")).toBe("agent has");
  });

  it("prints no number, so the count can sit elsewhere in the clause", () => {
    // "3 of 4 finished agents are out of date" agrees its noun with the
    // denominator and its verb with the numerator. A helper that owned the
    // number could not write that sentence at all.
    expect(agreeing(4, "agent")).not.toContain("4");
  });
});
