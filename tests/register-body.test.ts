/**
 * What `POST /api/tasks/register` refuses, and the agreement between the two doors.
 *
 * The route's comment says the server builds the URNs "so that the naming convention
 * lives in exactly one place and an agent cannot invent a malformed one". Building
 * them server-side was only half of that: the names went in checked for nothing but
 * being non-empty, and `datasetUrn` interpolates a name straight into
 * `urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.<name>,PROD)` while
 * `datasetName`, `shortName` in the dashboard and `dataset_short_name` in Python all
 * recover it by splitting on commas and then dots. So `clean,orders` registered a
 * genuine DataJob whose lineage pointed at an entity every reader called
 * `clean` -- a board that draws correctly and a URN nobody can look up. Nothing
 * downstream can detect that, which is why it has to fail at the door.
 *
 * The last block is the point of doing this in two places at once: obsel has two
 * doors, HTTP and MCP, and a guard on one of them is a guard an agent walks around.
 * The Python pattern is read out of the real module rather than copied here, the way
 * `tests/urns.test.ts` invokes the real URN builders.
 */

import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { RegisterBody } from "@/src/server/http/register-body";
import { NAME_PATTERN, datasetName, datasetUrn } from "@/src/server/datahub/urns";

/** The first error message for a body, or null when it parses. */
function problem(body: unknown): string | null {
  const outcome = RegisterBody.safeParse(body);
  if (outcome.success) return null;
  return outcome.error.issues[0].message;
}

const GOOD = { name: "build_revenue", reads: ["clean_orders"], writes: ["daily_revenue"] };

describe("a registration obsel can honour", () => {
  it("accepts short names", () => {
    expect(problem(GOOD)).toBeNull();
  });

  it("accepts a name carrying one namespace segment", () => {
    // `agents/run.py scale-register` posts `obsel_taxi.clean_trips`, and
    // `datasetUrn` passes a qualified name through rather than double-prefixing it.
    expect(
      problem({
        name: "clean_trips",
        reads: ["obsel_taxi.raw_trips"],
        writes: ["obsel_taxi.clean_trips"],
      }),
    ).toBeNull();
  });

  it("accepts a task that reads nothing", () => {
    // A seed-consuming task is the normal case for the first job in a pipeline.
    expect(problem({ ...GOOD, reads: [] })).toBeNull();
  });

  it("still takes a free-prose title and description", () => {
    // Neither is interpolated into a URN, so neither is held to the identifier
    // shape -- only to the lengths the board and DataHub's UI reserve room for.
    expect(problem({ ...GOOD, title: "Build revenue", description: "totals the day" })).toBeNull();
    expect(problem({ ...GOOD, title: "x".repeat(61) })).not.toBeNull();
    expect(problem({ ...GOOD, description: "x".repeat(301) })).not.toBeNull();
  });
});

describe("a name no reader could recover", () => {
  it("refuses a comma, which is what silently truncated", () => {
    /*
     * The concrete failure: `datasetUrn("clean,orders")` builds a URN whose
     * second comma-separated segment is `obsel_demo.clean`, so every reader gets
     * `clean` back. Asserted here against the real builder rather than described,
     * because the reason for the guard is that the damage is invisible afterwards.
     */
    expect(datasetName(datasetUrn("clean,orders"))).toBe("clean");
    expect(problem({ ...GOOD, writes: ["clean,orders"] })).toContain("clean,orders");
  });

  it("refuses a second dot, which is truncated the same way", () => {
    expect(datasetName(datasetUrn("a.b.c"))).toBe("c");
    expect(problem({ ...GOOD, reads: ["a.b.c"] })).not.toBeNull();
  });

  it("refuses a URN where a short name belongs, and says which way round it goes", () => {
    const urn = datasetUrn("clean_orders");
    const message = problem({ ...GOOD, reads: [urn] });
    expect(message).toContain("SHORT names");
  });

  it("refuses an empty name in place of the old min(1)", () => {
    expect(problem({ ...GOOD, name: "" })).not.toBeNull();
    expect(problem({ ...GOOD, writes: [""] })).not.toBeNull();
  });

  it("refuses a task name that would break its DataJob URN", () => {
    expect(problem({ ...GOOD, name: "build revenue" })).toContain("task name");
    expect(problem({ ...GOOD, name: "build_revenue)" })).toContain("task name");
  });

  it("says what was sent and what the shape is", () => {
    // The route answers 400 with this message and nothing else. "invalid body"
    // leaves an agent to guess which of five names it got wrong.
    const message = problem({ ...GOOD, writes: ["Daily Revenue"] }) ?? "";
    expect(message).toContain("Daily Revenue");
    expect(message).toContain("underscores");
    expect(message).toContain("clean_orders");
  });
});

describe("the HTTP door and the MCP door agree", () => {
  /*
   * Two doors into the same registration. `agents/mcp_server.py` posts to this
   * route, so its check is redundant on paper -- and it is the message the agent
   * actually reads, delivered before a network round trip. What must not happen is
   * the two disagreeing about which names are legal, because then the tool refuses
   * work obsel would have accepted, or promises work it will not.
   */
  function fromPython(): { pattern: string; comma: boolean; namespaced: boolean } {
    const script = [
      "import json",
      "from agents import mcp_core",
      "print(json.dumps({",
      '  "pattern": mcp_core.NAME_PATTERN.pattern,',
      '  "comma": mcp_core.dataset_name_problem("clean,orders") is not None,',
      '  "namespaced": mcp_core.dataset_name_problem("obsel_taxi.clean_trips") is None,',
      "}))",
    ].join("\n");
    const out = execFileSync("python3", ["-c", script], {
      cwd: new URL("../", import.meta.url).pathname,
      encoding: "utf8",
    });
    return JSON.parse(out) as ReturnType<typeof fromPython>;
  }

  it("holds the same pattern character for character", () => {
    const python = fromPython();
    expect(python.pattern).toBe(NAME_PATTERN.source);
  });

  it("makes the same call on the names that matter", () => {
    const python = fromPython();
    expect(python.comma).toBe(true);
    expect(python.namespaced).toBe(true);
  });
});

describe("volatile columns, declared at registration", () => {
  /*
   * The shape only. That a task may not declare exclusions for a table it does
   * not write is a relationship between two fields rather than a shape, so the
   * route owns it and `tests/live/` proves it against a real registration.
   */
  it("accepts a list keyed by a table this task writes", () => {
    const parsed = RegisterBody.parse({
      name: "clean_orders",
      reads: ["raw_orders"],
      writes: ["clean_orders"],
      volatile: { clean_orders: ["loaded_at"] },
    });
    expect(parsed.volatile).toEqual({ clean_orders: ["loaded_at"] });
  });

  it("is optional, which is what almost every task registers", () => {
    const parsed = RegisterBody.parse({
      name: "clean_orders",
      reads: [],
      writes: ["clean_orders"],
    });
    expect(parsed.volatile).toBeUndefined();
  });

  it("refuses a table name a URN could not be recovered from", () => {
    // Same rule as `writes`: the key is interpolated into a dataset URN, and
    // `dataset_short_name` recovers a name by splitting on commas and dots.
    expect(() =>
      RegisterBody.parse({
        name: "clean_orders",
        reads: [],
        writes: ["clean_orders"],
        volatile: { "clean,orders": ["loaded_at"] },
      }),
    ).toThrow();
  });

  it("refuses an empty column name", () => {
    expect(() =>
      RegisterBody.parse({
        name: "clean_orders",
        reads: [],
        writes: ["clean_orders"],
        volatile: { clean_orders: [""] },
      }),
    ).toThrow();
  });
});
