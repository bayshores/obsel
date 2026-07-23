/**
 * The URN shapes, and the agreement between the two implementations that build them.
 *
 * obsel writes these entities from TypeScript and `agents/` writes them from Python.
 * A URN differing by one character is not an error in DataHub, it is a **different
 * entity**: registration would land somewhere the coordinator never looks, the flow
 * would enumerate nothing, and obsel would report a clean board while the real work sat
 * in a flow of its own. So the Python side is invoked for real here and its output
 * compared, rather than the agreement being asserted in a comment.
 *
 * No stand-in for either side. `python3 -c` runs the actual module.
 */

import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  DATASET_NAMESPACE,
  FLOW_ID,
  FLOW_URN,
  PLATFORM,
  datasetName,
  datasetUrn,
  taskName,
  taskUrn,
} from "@/src/server/datahub/urns";

/** What Python builds for the same inputs, from the real modules. */
function fromPython(flowId?: string): {
  flow: string;
  task: string;
  dataset: string;
  namespace: string;
  roundTrip: string;
} {
  /*
   * The Python side takes the flow explicitly and the dataset already qualified, so
   * the call sites here mirror how `agents/` actually calls them: `pipeline.FLOW` for
   * the flow, and `f"{NAMESPACE}.{name}"` for a table. That is the point — the
   * agreement being checked is between what each side *produces in practice*, not
   * between two functions called in a way neither caller uses.
   */
  const script = [
    "import json",
    "from agents import graph, pipeline",
    "print(json.dumps({",
    '  "flow": f"urn:li:dataFlow:({graph.PLATFORM},{pipeline.FLOW},prod)",',
    '  "task": graph.task_urn(pipeline.FLOW, "build_revenue"),',
    '  "dataset": graph.dataset_urn(f"{pipeline.NAMESPACE}.clean_orders"),',
    '  "namespace": pipeline.NAMESPACE,',
    '  "roundTrip": graph.task_name(graph.task_urn(pipeline.FLOW, "write_docs")),',
    "}))",
  ].join("\n");

  const out = execFileSync("python3", ["-c", script], {
    cwd: new URL("../", import.meta.url).pathname,
    encoding: "utf8",
    env: flowId === undefined ? process.env : { ...process.env, OBSEL_FLOW_ID: flowId },
  });
  return JSON.parse(out) as ReturnType<typeof fromPython>;
}

describe("the TypeScript and Python URN builders agree", () => {
  it("builds the same flow, task and dataset URNs", () => {
    const python = fromPython();
    expect(python.flow).toBe(FLOW_URN);
    expect(python.task).toBe(taskUrn("build_revenue"));
    expect(python.dataset).toBe(datasetUrn("clean_orders"));
    expect(python.namespace).toBe(DATASET_NAMESPACE);
    // Both sides take the LAST comma-separated segment, which is the bug that was hit.
    expect(python.roundTrip).toBe(taskName(taskUrn("write_docs")));
  });

  it("agrees under an overridden flow id, in both directions", () => {
    /*
     * The override is what integration tests use to get their own real DataFlow. If
     * only one side honoured it, the tests would register through Python into one flow
     * and read through TypeScript from another, and a green suite would prove nothing.
     */
    const id = "obsel_urn_agreement_check";
    const python = fromPython(id);
    expect(python.flow).toBe(`urn:li:dataFlow:(${PLATFORM},${id},prod)`);
    expect(python.task).toBe(
      `urn:li:dataJob:(urn:li:dataFlow:(${PLATFORM},${id},prod),build_revenue)`,
    );
    // The dataset namespace is deliberately NOT scoped by flow: the tables are the
    // demo's tables whichever flow is reading them.
    expect(python.dataset).toBe(datasetUrn("clean_orders"));
  });
});

describe("round trips", () => {
  it("recovers a task id from its URN, taking the LAST segment", () => {
    /*
     * A DataJob URN nests a DataFlow URN, so the task id is the last comma-separated
     * segment and not the second to last. That was a real bug, hit and fixed, and both
     * implementations carry a comment saying so.
     */
    expect(taskName(taskUrn("build_revenue"))).toBe("build_revenue");
    expect(taskName(taskUrn("write_docs"))).toBe("write_docs");
  });

  it("recovers a dataset's short name from its URN", () => {
    expect(datasetName(datasetUrn("clean_orders"))).toBe("clean_orders");
  });

  it("does not double-prefix an already-qualified dataset name", () => {
    // A name round-tripped out of DataHub arrives qualified. Prefixing it again would
    // build `obsel_demo.obsel_demo.clean_orders`, a different entity.
    expect(datasetUrn(`${DATASET_NAMESPACE}.clean_orders`)).toBe(datasetUrn("clean_orders"));
  });
});

describe("the flow id override", () => {
  it("defaults to the demo flow when unset", () => {
    // `pnpm test` runs without it, so this asserts the default is what the demo uses.
    expect(process.env.OBSEL_FLOW_ID ?? "orders_pipeline").toBe(FLOW_ID);
  });
});
