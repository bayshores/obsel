/**
 * What a completion has to carry before obsel will act on it.
 *
 * Two refusals, both of them already made at obsel's MCP door by
 * `resolve_outputs` in `agents/mcp_core.py`, and neither of them made at the
 * HTTP door until now. The MCP door is not a gate on the HTTP door: an agent
 * can post to `/api/tasks/complete` directly, and the demo worker does.
 *
 * The first refusal is the no-clear rule stated at the door. A completion with
 * no output fingerprint gives obsel nothing to compare, and `recordCompletion`
 * then takes the reporter's own flag and its DataHub tag off anyway, because
 * the flag comes off whenever the flagged task reports. That is a flag cleared
 * by an assertion rather than by redone work.
 *
 * The second is the `Produces` rule. A fingerprint recorded under a dataset the
 * task never declared it writes becomes obsel's baseline for that dataset, and
 * the next completion that moves it marks every finished reader stale and names
 * an author with no `Produces` edge to it.
 */

import { describe, expect, it } from "vitest";

import { evidenceProblem } from "@/src/server/coordinator/completion-evidence";
import type { OutputFingerprint, TaskRecord } from "@/src/server/coordinator/types";

function ds(name: string): string {
  return `urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.${name},PROD)`;
}

const FP: OutputFingerprint = { schema: "s1", content: "c1" };

function task(writes: string[], overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    urn: "urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),clean_orders)",
    name: "clean_orders",
    title: "Clean orders",
    reads: [ds("raw_orders")],
    writes: writes.map(ds),
    status: "stale",
    fingerprints: {},
    finishedAt: "2026-08-10T00:00:00.000Z",
    startedAt: null,
    run: null,
    stale: null,
    ...overrides,
  };
}

describe("a completion carrying no fingerprint at all", () => {
  it("is refused when the task declared it writes something", () => {
    const problem = evidenceProblem(task(["clean_orders"]), {});

    expect(problem).not.toBeNull();
    // The sentence has to name both halves: what the task said it produces, and
    // that nothing arrived for it. A refusal that only says "invalid" sends the
    // agent's author to the schema rather than to the missing report.
    expect(problem).toContain("Clean orders");
    expect(problem).toContain("clean_orders");
    expect(problem).toContain("no output fingerprint");
  });

  it("is refused for a task with several declared outputs, naming them all", () => {
    const problem = evidenceProblem(task(["split_kept", "split_moved"]), {});

    expect(problem).toContain("split_kept");
    expect(problem).toContain("split_moved");
  });

  it("is refused whether or not the task is currently flagged", () => {
    /*
     * The rule is about evidence, not about who happens to be flagged today. A
     * check that only fired on a flagged task would pass on the run that
     * establishes the baseline and fail later, which is the same defect moved.
     */
    expect(evidenceProblem(task(["clean_orders"], { status: "running" }), {})).not.toBeNull();
  });

  it("is refused for a task that declared no writes too", () => {
    /*
     * A task registered with no writes is still flagged as a reader when an
     * upstream output moves, and `recordCompletion` still takes that flag and
     * its DataHub tag off when it reports. So the empty map clears a flag with
     * nothing compared, exactly as it does for a task that declared a write.
     * How the task was registered does not change what the report carries.
     */
    const problem = evidenceProblem(task([]), {});

    expect(problem).not.toBeNull();
    expect(problem).toContain("Clean orders");
    // Its own sentence: there are no declared datasets to name, and telling
    // this caller to report the tables it produced names nothing it can act on.
    expect(problem).toContain("registered as writing nothing");
    expect(problem).not.toContain("declared that it writes");
  });
});

describe("a fingerprint for a dataset the task does not write", () => {
  it("is refused, naming the dataset and what the task actually declared", () => {
    const problem = evidenceProblem(task(["clean_orders"]), { [ds("daily_revenue")]: FP });

    expect(problem).not.toBeNull();
    expect(problem).toContain(ds("daily_revenue"));
    expect(problem).toContain(ds("clean_orders"));
  });

  it("is refused even when a declared output was reported beside it", () => {
    // The legitimate half does not buy the illegitimate one. Recording the
    // declared fingerprint and dropping the other would leave the caller
    // believing obsel holds a baseline it does not.
    const problem = evidenceProblem(task(["clean_orders"]), {
      [ds("clean_orders")]: FP,
      [ds("daily_revenue")]: FP,
    });

    expect(problem).toContain(ds("daily_revenue"));
    expect(problem).not.toContain("no output fingerprint");
  });

  it("is refused for a dataset spelled the same but in another namespace", () => {
    /*
     * Compared as whole URNs, which is the space `decideCompletion` keys
     * `finishing.fingerprints` in. Matching on the short name would accept
     * `finance.clean_orders` as evidence about `obsel_demo.clean_orders` and
     * record one table's bytes under the other's name.
     */
    const other = "urn:li:dataset:(urn:li:dataPlatform:obsel,finance.clean_orders,PROD)";
    expect(evidenceProblem(task(["clean_orders"]), { [other]: FP })).toContain(other);
  });

  it("says the task declared nothing when it declared nothing", () => {
    const problem = evidenceProblem(task([]), { [ds("daily_revenue")]: FP });

    expect(problem).toContain("nothing");
  });

  it("lists every undeclared dataset, not just the first", () => {
    const problem = evidenceProblem(task(["clean_orders"]), {
      [ds("daily_revenue")]: FP,
      [ds("pipeline_docs")]: FP,
    });

    expect(problem).toContain(ds("daily_revenue"));
    expect(problem).toContain(ds("pipeline_docs"));
  });
});

describe("a completion reporting exactly what the task declared", () => {
  it("passes, so an honest agent's report is untouched", () => {
    expect(evidenceProblem(task(["clean_orders"]), { [ds("clean_orders")]: FP })).toBeNull();
  });

  it("passes when a two-output task reports both", () => {
    expect(
      evidenceProblem(task(["split_kept", "split_moved"]), {
        [ds("split_kept")]: FP,
        [ds("split_moved")]: FP,
      }),
    ).toBeNull();
  });

  it("passes when a two-output task reports only one of them", () => {
    /*
     * Deliberately allowed. A task that wrote one of its two tables this run has
     * evidence for that table and none for the other, and obsel's comparison is
     * per dataset: the unreported one keeps its previous baseline. Requiring all
     * declared outputs every run would refuse that honest report, and the agent's
     * way out would be to invent a fingerprint for the table it did not write.
     */
    expect(
      evidenceProblem(task(["split_kept", "split_moved"]), { [ds("split_kept")]: FP }),
    ).toBeNull();
  });
});
