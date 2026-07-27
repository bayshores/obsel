/**
 * The form refuses what obsel would refuse, and the list is a lens on the swarm.
 *
 * Two kinds of case matter here. The first is a draft that would be accepted and
 * then be useless or wrong: a task with no output, a self-edge, a table name that
 * builds a URN nothing can parse back. `/api/tasks/register` takes all of those
 * today, so the form is the only thing that says so.
 *
 * The second is the list claiming a task is yours when it is obsel's own, which
 * is `isVisitor`'s job and is tested against the Python in
 * `cockpit-joining.test.ts`. What is checked here is that this panel asks that
 * same question rather than a second one of its own.
 */

import { describe, expect, it } from "vitest";

import { DEMO_TASKS } from "@/src/features/cockpit/joining";
import {
  EMPTY_DRAFT,
  draftProblem,
  mine,
  parseNames,
  registration,
} from "@/src/features/cockpit/mine";
import type { MineDraft } from "@/src/features/cockpit/mine";
import type { TaskRecord } from "@/src/server/coordinator/types";

function ds(namespace: string, name: string): string {
  return `urn:li:dataset:(urn:li:dataPlatform:obsel,${namespace}.${name},PROD)`;
}

function task(name: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    urn: `urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),${name})`,
    name,
    reads: [ds("obsel_demo", "source")],
    writes: [ds("obsel_demo", name)],
    status: "complete",
    fingerprints: {},
    finishedAt: null,
    startedAt: null,
    run: null,
    stale: null,
    ...overrides,
  };
}

function draft(overrides: Partial<MineDraft> = {}): MineDraft {
  return { ...EMPTY_DRAFT, name: "clean_expenses", writes: "clean_expenses", ...overrides };
}

describe("reading a list of table names out of one field", () => {
  it("splits on commas and newlines, and drops the blanks a trailing comma leaves", () => {
    expect(parseNames("a, b,c ,")).toEqual(["a", "b", "c"]);
    expect(parseNames("a\nb\n")).toEqual(["a", "b"]);
    expect(parseNames("   ")).toEqual([]);
    expect(parseNames("")).toEqual([]);
  });

  it("collapses a table named twice, which would otherwise be two identical edges", () => {
    expect(parseNames("orders, orders")).toEqual(["orders"]);
  });
});

describe("what the form will not send", () => {
  it("accepts the shape docs/setup.md's walkthrough registers", () => {
    const ok = draft({ name: "clean_expenses", reads: "expenses_csv", writes: "clean_expenses" });
    expect(draftProblem(ok, [])).toBeNull();
  });

  it("refuses a task with no output, which obsel could never say anything about", () => {
    // The MCP tool refuses this; the HTTP route does not. A task that writes
    // nothing cannot go stale and cannot make anything else stale.
    const problem = draftProblem(draft({ writes: "" }), []);
    expect(problem).toContain("writes");
  });

  it("refuses a name that would build a URN nothing can parse back", () => {
    // `datasetUrn` interpolates straight into a comma-separated URN, and
    // `shortName` recovers the name by splitting on commas and dots. Neither end
    // rejects this: the entity is created and lineage points at nothing.
    for (const bad of [
      "clean,expenses",
      "clean.expenses",
      "Clean_Expenses",
      "_leading",
      "has space",
    ]) {
      expect(draftProblem(draft({ name: bad, writes: "out" }), []), bad).not.toBeNull();
    }
    expect(draftProblem(draft({ name: "clean_expenses_2", writes: "out" }), [])).toBeNull();
  });

  it("refuses a bad table name in reads or writes, not only in the task name", () => {
    expect(draftProblem(draft({ reads: "expenses.csv" }), [])).toContain("expenses.csv");
    expect(draftProblem(draft({ writes: "clean expenses" }), [])).toContain("clean expenses");
  });

  it("refuses a task that reads what it writes, which is its own upstream", () => {
    const problem = draftProblem(draft({ reads: "totals", writes: "totals" }), []);
    expect(problem).toContain("totals");
  });

  it("refuses a name already on the board, rather than letting obsel decide", () => {
    const problem = draftProblem(draft({ name: "clean_orders", writes: "out" }), [
      task("clean_orders"),
    ]);
    expect(problem).toContain("clean_orders");
  });

  it("refuses a short name longer than the graph reserves width for", () => {
    expect(draftProblem(draft({ title: "x".repeat(61) }), [])).not.toBeNull();
    expect(draftProblem(draft({ title: "x".repeat(60) }), [])).toBeNull();
  });

  it("says something about an empty draft rather than nothing", () => {
    expect(draftProblem(EMPTY_DRAFT, [])).not.toBeNull();
  });
});

describe("the body sent to the register route", () => {
  it("matches what the route's schema takes, with the title left out when blank", () => {
    const body = registration(
      draft({ name: " clean_expenses ", reads: "expenses_csv", writes: "clean_expenses" }),
    );
    expect(body).toEqual({
      name: "clean_expenses",
      reads: ["expenses_csv"],
      writes: ["clean_expenses"],
    });
    expect("title" in body).toBe(false);
  });

  it("carries a trimmed title when there is one", () => {
    expect(registration(draft({ title: "  Expense cleaner  " })).title).toBe("Expense cleaner");
  });
});

describe("whose tasks the panel lists", () => {
  it("asks the same question the joining panel asks, so the two cannot disagree", () => {
    const view = mine({ trusted: true, tasks: DEMO_TASKS.map((name) => task(name)) });
    expect(view.mine).toEqual([]);
  });

  it("lists a task nobody in this repository named, with its identifiers intact", () => {
    const view = mine({
      trusted: true,
      tasks: [
        task("monthly_totals", {
          reads: [ds("obsel_demo", "clean_expenses")],
          writes: [ds("obsel_demo", "monthly_totals")],
          title: "Monthly totals",
        }),
      ],
    });
    expect(view.mine).toHaveLength(1);
    expect(view.mine[0].name).toBe("monthly_totals");
    expect(view.mine[0].title).toBe("Monthly totals");
    // Short names, because these are what the reader typed and what their agent
    // passes to report_complete. A humanised name would be unusable for that.
    expect(view.mine[0].reads).toEqual(["clean_expenses"]);
    expect(view.mine[0].writes).toEqual(["monthly_totals"]);
  });

  it("calls a task reported only when obsel has a fingerprint to compare against", () => {
    const finished = task("mine_a", { finishedAt: "2026-07-26T09:00:00.000Z" });
    // A finish time with no recorded output is not something obsel can compare
    // next time, which is the only question this flag is asked.
    expect(mine({ trusted: true, tasks: [finished] }).mine[0].reported).toBe(false);

    const recorded = task("mine_b", {
      fingerprints: { [ds("obsel_demo", "mine_b")]: { schema: "aa", content: "bb" } },
    });
    expect(mine({ trusted: true, tasks: [recorded] }).mine[0].reported).toBe(true);
  });

  it("lists nothing and stays folded when the read failed, not an empty board", () => {
    // A failed read leaves tasks empty, which is indistinguishable from a board
    // nobody has registered anything on. Opening the form under a headline
    // saying obsel cannot see anything invites a registration about to fail.
    const view = mine({ trusted: false, tasks: [] });
    expect(view.mine).toEqual([]);
    expect(view.expanded).toBe(false);
  });
});

describe("when the form is painted rather than folded", () => {
  it("opens only on a board with nothing whatsoever on it", () => {
    expect(mine({ trusted: true, tasks: [] }).expanded).toBe(true);
  });

  it("stays folded beside obsel's own demonstration, the state the ceiling measures", () => {
    // `e2e/cockpit.spec.ts` measures the word budget on a board holding the
    // demo, and that is the state the board is in on camera.
    const view = mine({ trusted: true, tasks: DEMO_TASKS.map((name) => task(name)) });
    expect(view.expanded).toBe(false);
  });

  it("stays folded once something of yours is on the board", () => {
    expect(mine({ trusted: true, tasks: [task("monthly_totals")] }).expanded).toBe(false);
  });
});
