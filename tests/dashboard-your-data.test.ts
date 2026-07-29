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
 * `dashboard-joining.test.ts`. What is checked here is that this panel asks that
 * same question rather than a second one of its own.
 */

import { describe, expect, it } from "vitest";

import { DEMO_TASKS } from "@/src/features/dashboard/joining";
import {
  EMPTY_DRAFT,
  draftProblem,
  yourData,
  parseNames,
  registration,
} from "@/src/features/dashboard/your-data";
import type { YourDataDraft } from "@/src/features/dashboard/your-data";
import { datasetNameProblem, taskNameProblem } from "@/src/server/datahub/urns";
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

function draft(overrides: Partial<YourDataDraft> = {}): YourDataDraft {
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
    expect(draftProblem(draft({ reads: "a.b.c" }), [])).toContain("a.b.c");
    expect(draftProblem(draft({ writes: "clean expenses" }), [])).toContain("clean expenses");
    expect(draftProblem(draft({ reads: "Clean.Expenses" }), [])).toContain("Clean.Expenses");
  });

  it("allows a table name carrying one namespace, which obsel's own swarm uses", () => {
    /*
     * The form must not be stricter than the route. `agents/scale.py` registers
     * `obsel_taxi.clean_trips` already qualified, and `datasetNameProblem` accepts
     * one namespace segment for exactly that reason. A form refusing a dot would
     * refuse a name obsel itself uses, and read as a validation bug.
     */
    expect(
      draftProblem(draft({ reads: "obsel_taxi.raw_trips", writes: "obsel_taxi.marts" }), []),
    ).toBeNull();
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

describe("the form and the route agree about what a name is", () => {
  /*
   * The form's copy of the rule, held against the real one.
   *
   * `your-data.ts` cannot import `urns.ts`: it renders in the browser and obsel forbids
   * browser code importing server modules, which is about dependency direction
   * rather than cost. So the pattern is duplicated, the same way `naming.ts`
   * duplicates `shortName` and `joining.ts` duplicates the taxi namespace, and the
   * duplication is held together here rather than hoped about.
   *
   * Drift in the strict direction is the one that bites in silence: a form
   * narrower than the route refuses work obsel would have accepted, and looks like
   * a bug in the field rather than a disagreement between two rules.
   */
  it("refuses exactly the task names taskNameProblem refuses", () => {
    for (const name of [
      "clean_expenses",
      "a",
      "x9",
      "obsel_taxi.clean_trips",
      "Clean_Expenses",
      "_leading",
      "has space",
      "clean,expenses",
      "clean.expenses",
      "",
      "urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.x,PROD)",
    ]) {
      const routeRefuses = taskNameProblem(name) !== null;
      const formRefuses = draftProblem(draft({ name, writes: "out" }), []) !== null;
      expect(formRefuses, `task name ${JSON.stringify(name)}`).toBe(routeRefuses);
    }
  });

  it("refuses exactly the table names datasetNameProblem refuses", () => {
    /*
     * No comma in this list, and its absence is the point. A comma is the field's
     * separator, so `parseNames` turns `clean,expenses` into two names and the
     * route can never receive one. That is checked directly below rather than
     * folded in here, where it looked like a disagreement between the two rules
     * and was in fact a difference between a field and a name.
     */
    for (const table of [
      "clean_expenses",
      "obsel_taxi.clean_trips",
      "expenses.csv",
      "a.b.c",
      "Clean.Expenses",
      "clean expenses",
      ".leading",
      "trailing.",
      "urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.x,PROD)",
    ]) {
      const routeRefuses = datasetNameProblem(table) !== null;
      // Through `writes`, so an empty-writes refusal cannot be mistaken for a
      // name refusal.
      const formRefuses = draftProblem(draft({ name: "some_task", writes: table }), []) !== null;
      expect(formRefuses, `table name ${JSON.stringify(table)}`).toBe(routeRefuses);
    }
  });

  it("never sends a name with a comma in it, because the comma is the separator", () => {
    // Belt and braces on the case above: whatever the field holds, every name the
    // form would actually POST is one the route accepts.
    const sent = registration(
      draft({ name: "some_task", writes: "clean,expenses", reads: "a, b" }),
    );
    for (const table of [...sent.reads, ...sent.writes]) {
      expect(datasetNameProblem(table), `the form would have sent ${table}`).toBeNull();
    }
    expect(sent.writes).toEqual(["clean", "expenses"]);
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
    const view = yourData({ trusted: true, tasks: DEMO_TASKS.map((name) => task(name)) });
    expect(view.yourData).toEqual([]);
  });

  it("lists a task nobody in this repository named, with its identifiers intact", () => {
    const view = yourData({
      trusted: true,
      tasks: [
        task("monthly_totals", {
          reads: [ds("obsel_demo", "clean_expenses")],
          writes: [ds("obsel_demo", "monthly_totals")],
          title: "Monthly totals",
        }),
      ],
    });
    expect(view.yourData).toHaveLength(1);
    expect(view.yourData[0].name).toBe("monthly_totals");
    expect(view.yourData[0].title).toBe("Monthly totals");
    // Short names, because these are what the reader typed and what their agent
    // passes to report_complete. A humanised name would be unusable for that.
    expect(view.yourData[0].reads).toEqual(["clean_expenses"]);
    expect(view.yourData[0].writes).toEqual(["monthly_totals"]);
  });

  it("calls a task reported only when obsel has a fingerprint to compare against", () => {
    const finished = task("mine_a", { finishedAt: "2026-07-26T09:00:00.000Z" });
    // A finish time with no recorded output is not something obsel can compare
    // next time, which is the only question this flag is asked.
    expect(yourData({ trusted: true, tasks: [finished] }).yourData[0].reported).toBe(false);

    const recorded = task("mine_b", {
      fingerprints: { [ds("obsel_demo", "mine_b")]: { schema: "aa", content: "bb" } },
    });
    expect(yourData({ trusted: true, tasks: [recorded] }).yourData[0].reported).toBe(true);
  });

  it("lists nothing and stays folded when the read failed, not an empty board", () => {
    // A failed read leaves tasks empty, which is indistinguishable from a board
    // nobody has registered anything on. Opening the form under a headline
    // saying obsel cannot see anything invites a registration about to fail.
    const view = yourData({ trusted: false, tasks: [] });
    expect(view.yourData).toEqual([]);
    expect(view.expanded).toBe(false);
  });
});

describe("when the form is painted rather than folded", () => {
  it("opens only on a board with nothing whatsoever on it", () => {
    expect(yourData({ trusted: true, tasks: [] }).expanded).toBe(true);
  });

  it("stays folded beside obsel's own demonstration, the state the ceiling measures", () => {
    // `e2e/dashboard.spec.ts` measures the word budget on a board holding the
    // demo, and that is the state the board is in on camera.
    const view = yourData({ trusted: true, tasks: DEMO_TASKS.map((name) => task(name)) });
    expect(view.expanded).toBe(false);
  });

  it("stays folded once something of yours is on the board", () => {
    expect(yourData({ trusted: true, tasks: [task("monthly_totals")] }).expanded).toBe(false);
  });
});
