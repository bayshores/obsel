/**
 * What the guide is allowed to say.
 *
 * A sentence on screen has to be readable by someone who has never opened the
 * README, and no sentence may claim a fact the inputs do not carry. These are
 * the assertions on the words themselves: the punctuation, the column names the
 * change line quotes, and the three phrasings of the flagged subline.
 */

import { describe, expect, it } from "vitest";

import { guide } from "@/src/features/dashboard/guide";
import type {} from "@/src/features/dashboard/guide";
import type { StaleMark, TaskRecord } from "@/src/server/coordinator/types";
import type { StepResult } from "@/src/server/runner/types";
import {
  AT,
  FOUR_COMPLETE,
  activity,
  allText,
  ds,
  input,
  mark,
  ok,
  runnerOk,
  task,
} from "./support/guide-fixtures";

describe("no em dash reaches the screen", () => {
  /*
   * A guard, not a preference dressed as one.
   *
   * The owner asked for em dashes to go. Ten rounds of hand-editing copy had
   * already put 194 of them into this directory and 10 onto the board at once, so
   * the only version of "removed" that survives another pass of edits is one the
   * build enforces. `e2e/dashboard.spec.ts` makes the same assertion against the
   * fully rendered page; this one covers every stage, including the failure and
   * setup stages a browser test would have to break the machine to reach.
   */
  const EM_DASH = "—";

  function everyStage(): { name: string; view: ReturnType<typeof guide> }[] {
    const failing: StepResult = {
      step: "run",
      exitCode: 1,
      signal: null,
      durationMs: 4000,
      startedAt: AT,
      finishedAt: AT,
    };
    return [
      { name: "connect", view: guide(input({ trusted: false })) },
      {
        name: "connect with a fix to offer",
        view: guide(
          input({
            trusted: false,
            activity: activity({
              preflight: {
                datahub: {
                  ok: false,
                  detail: "nothing answered",
                  fix: "datahub docker quickstart",
                },
                vocabulary: ok(),
                venv: ok(),
                uvx: ok(),
                runner: runnerOk(),
              },
            }),
          }),
        ),
      },
      {
        name: "prepare",
        view: guide(
          input({
            activity: activity({
              preflight: {
                datahub: ok(),
                vocabulary: { ok: false, detail: "the tag is missing", fix: null },
                venv: ok(),
                uvx: ok(),
                runner: {
                  ok: false,
                  detail: "not installed",
                  fix: "brew install codex",
                  name: "codex",
                },
              },
            }),
          }),
        ),
      },
      { name: "empty", view: guide(input({ tasks: [] })) },
      {
        name: "registered",
        view: guide(input({ tasks: [task("clean_orders", { finishedAt: null })] })),
      },
      {
        name: "working",
        view: guide(
          input({
            tasks: [
              task("clean_orders", {
                status: "running",
                finishedAt: null,
                startedAt: "2026-07-22T09:00:00.000Z",
              }),
            ],
          }),
        ),
      },
      { name: "settled", view: guide(input({ tasks: FOUR_COMPLETE })) },
      {
        name: "flagged",
        view: guide(
          input({
            tasks: [
              task("clean_orders"),
              task("build_revenue", { status: "stale", stale: mark() }),
            ],
          }),
        ),
      },
      {
        name: "flagged with a named column change",
        view: guide(
          input({
            tasks: [
              task("clean_orders"),
              task("build_revenue", {
                status: "stale",
                stale: mark({ columns: { added: ["order_total_usd"], removed: ["order_total"] } }),
              }),
            ],
          }),
        ),
      },
      {
        name: "a failed step",
        view: guide(input({ activity: activity({ lastResult: failing }) })),
      },
      {
        name: "a live step",
        view: guide(
          input({
            tasks: FOUR_COMPLETE,
            activity: activity({ running: { step: "run", startedAt: AT } }),
          }),
        ),
      },
    ];
  }

  it("never puts one in a headline, a subline, a note, an action or an attention line", () => {
    for (const { name, view } of everyStage()) {
      expect(allText(view), name).not.toContain(EM_DASH);
    }
  });

  it("covers every stage the guide can produce, so none can slip through unchecked", () => {
    // Without this, adding a stage and forgetting to list it above would leave
    // the guard passing while the new stage went unchecked.
    const covered = new Set(everyStage().map(({ view }) => view.stage));
    expect([...covered].sort()).toEqual([
      "connect",
      "empty",
      "flagged",
      "prepare",
      "registered",
      "settled",
      "working",
    ]);
  });
});

describe("the change line names the columns that moved", () => {
  /*
   * These fixtures read the changed table on purpose.
   *
   * A directly flagged task is one that consumed `clean_orders`, and saying so keeps
   * these assertions about the column wording alone: a task marked without reading
   * the changed table also earns the "never read it" clause, which belongs in its own
   * block below rather than tangled into every column case.
   */
  function directlyFlagged(overrides: Partial<StaleMark> = {}): TaskRecord {
    return task("build_revenue", {
      status: "stale",
      reads: [ds("clean_orders")],
      stale: mark(overrides),
    });
  }

  it("says lost and gained, never renamed, because a rename cannot be observed", () => {
    const view = guide(
      input({
        tasks: [
          task("clean_orders"),
          directlyFlagged({ columns: { added: ["order_total_usd"], removed: ["order_total"] } }),
        ],
      }),
    );
    expect(view.subline).toBe(
      "clean orders lost the column order_total and gained the column order_total_usd after they finished",
    );
    expect(view.subline).not.toContain("renamed");
  });

  it("falls back to the kind of change when no columns were recorded", () => {
    // Marks written before obsel recorded column lists, and every content-only
    // change. The line still has to say something true.
    const schema = guide(input({ tasks: [directlyFlagged({ columns: null })] }));
    expect(schema.subline).toBe("the columns in clean orders changed after they finished");

    const content = guide(
      input({ tasks: [directlyFlagged({ changeKind: "content", columns: null })] }),
    );
    expect(content.subline).toBe("the rows in clean orders changed after they finished");
  });

  it("reports a one-sided change without a dangling conjunction", () => {
    const added = guide(
      input({ tasks: [directlyFlagged({ columns: { added: ["refund_total"], removed: [] } })] }),
    );
    expect(added.subline).toBe("clean orders gained the column refund_total after they finished");

    const removed = guide(
      input({ tasks: [directlyFlagged({ columns: { added: [], removed: ["order_total"] } })] }),
    );
    expect(removed.subline).toBe("clean orders lost the column order_total after they finished");
  });
});

describe("the subline names work flagged without touching the change", () => {
  /*
   * The fact obsel exists for, and the one the board only ever showed as `· 2 hops`.
   *
   * Every count here is derived from `reads`, never from `hops`, so these fixtures
   * set hop counts that would give a different answer where it matters. "Never read
   * it" is a claim about what a task consumes; hops measure distance through the
   * graph. They usually agree, and the sentence has to be true when they do not.
   */
  const changed = ds("clean_orders");

  it("counts the indirect ones, and says so in words rather than in hops", () => {
    const view = guide(
      input({
        tasks: [
          task("clean_orders"),
          task("build_revenue", {
            status: "stale",
            reads: [changed],
            stale: mark({ hops: 1 }),
          }),
          task("write_report", {
            status: "stale",
            reads: [ds("daily_revenue")],
            stale: mark({ hops: 2 }),
          }),
          task("write_docs", {
            status: "stale",
            reads: [ds("daily_revenue")],
            stale: mark({ hops: 2 }),
          }),
        ],
      }),
    );
    expect(view.subline).toContain("2 of the 3 never read that table");
  });

  it("says nothing extra when every flagged task read the changed table", () => {
    const view = guide(
      input({
        tasks: [
          task("build_revenue", { status: "stale", reads: [changed], stale: mark({ hops: 1 }) }),
          task("write_report", { status: "stale", reads: [changed], stale: mark({ hops: 1 }) }),
        ],
      }),
    );
    expect(view.subline).not.toContain("never read");
    expect(view.subline).not.toContain("0 of");
  });

  it("counts by what a task reads, not by how far away the graph puts it", () => {
    // Two hops out and still reading the changed table on a second edge. The hop
    // count is honest; "never read it" would not be, so it must not be claimed.
    const view = guide(
      input({
        tasks: [
          task("build_revenue", { status: "stale", reads: [changed], stale: mark({ hops: 1 }) }),
          task("write_report", {
            status: "stale",
            reads: [ds("daily_revenue"), changed],
            stale: mark({ hops: 2 }),
          }),
        ],
      }),
    );
    expect(view.subline).not.toContain("never read");
  });

  it("spells out the all-indirect cases instead of stating a ratio of one to one", () => {
    const alone = guide(
      input({
        tasks: [
          task("write_docs", { status: "stale", reads: [ds("daily_revenue")], stale: mark() }),
        ],
      }),
    );
    expect(alone.subline).toContain("The one agent that went out of date never read that table");
    expect(alone.subline).not.toContain("1 of the 1");

    const several = guide(
      input({
        tasks: [
          task("write_report", { status: "stale", reads: [ds("daily_revenue")], stale: mark() }),
          task("write_docs", { status: "stale", reads: [ds("daily_revenue")], stale: mark() }),
        ],
      }),
    );
    expect(several.subline).toContain("None of the 2 ever read that table");
  });
});
