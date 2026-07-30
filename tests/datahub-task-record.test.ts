/**
 * Reading a client's account of itself back off a DataJob.
 *
 * These sit on the *drop* side of the rule `task-record.ts` states in its own
 * header: a field obsel decides with throws when it is unreadable, a field that
 * only renders is dropped. The client stamps only render. A malformed one costing
 * a line on the details panel is a missing sentence; a malformed one throwing
 * would fail `readSnapshot`, and one unparseable version string would blank the
 * whole board — which is why every case below is asserted to return null rather
 * than to raise.
 *
 * The stale properties beside them are the opposite and stay that way: those are
 * covered by `staleness.test.ts` and the live engine suite.
 */

import { describe, expect, it } from "vitest";

import { PROP } from "@/src/server/datahub/properties";
import { toTaskRecord } from "@/src/server/datahub/task-record";

const URN = "urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),clean_orders)";

function entity(props: Record<string, string>) {
  return {
    urn: URN,
    dataJobInfo: {
      value: {
        name: "clean_orders",
        description: "obsel agent task",
        customProperties: { [PROP.status]: "registered", ...props },
      },
    },
  };
}

describe("the MCP client obsel recorded", () => {
  it("reads a full stamp back at the moment it was written", () => {
    const record = toTaskRecord(
      entity({
        [PROP.clientRegistered]: JSON.stringify({
          name: "claude-code",
          version: "2.1",
          at: "2026-07-29T10:00:00.000Z",
        }),
      }),
    );

    expect(record.client?.registered).toEqual({
      name: "claude-code",
      version: "2.1",
      at: "2026-07-29T10:00:00.000Z",
    });
    // The other two moments are separate observables and stay empty.
    expect(record.client?.started).toBeNull();
    expect(record.client?.reported).toBeNull();
  });

  it("keeps a name that arrived without a version or a timestamp", () => {
    // Both are optional on the way in, and a client that sent a bare name has
    // still told obsel who it is. Dropping the record to keep the clock would
    // lose the only fact worth having.
    const record = toTaskRecord(
      entity({ [PROP.clientReported]: JSON.stringify({ name: "some-agent" }) }),
    );

    expect(record.client?.reported).toEqual({ name: "some-agent", version: null, at: null });
  });

  it("drops a stamp with no name rather than rendering a blank client", () => {
    const record = toTaskRecord(
      entity({ [PROP.clientStarted]: JSON.stringify({ version: "2.1" }) }),
    );

    expect(record.client?.started).toBeNull();
  });

  it("drops an empty name, which would render as a gap on the panel", () => {
    const record = toTaskRecord(entity({ [PROP.clientStarted]: JSON.stringify({ name: "" }) }));

    expect(record.client?.started).toBeNull();
  });

  it("survives a property that is not JSON at all", () => {
    // The case that decides the leniency rule. A throw here would take
    // `readSnapshot` down, and every task on the board with it.
    expect(() => toTaskRecord(entity({ [PROP.clientRegistered]: "claude-code" }))).not.toThrow();
    expect(
      toTaskRecord(entity({ [PROP.clientRegistered]: "claude-code" })).client?.registered,
    ).toBeNull();
  });

  it("survives JSON of the wrong shape", () => {
    for (const raw of ["[]", '"claude-code"', "null", "42"]) {
      const record = toTaskRecord(entity({ [PROP.clientRegistered]: raw }));
      expect(record.client?.registered, `${raw} must not become a client`).toBeNull();
    }
  });

  it("ignores a version that is not a string instead of failing the read", () => {
    const record = toTaskRecord(
      entity({ [PROP.clientReported]: JSON.stringify({ name: "codex-cli", version: 144 }) }),
    );

    expect(record.client?.reported).toEqual({ name: "codex-cli", version: null, at: null });
  });

  it("reports every moment empty on a task no client ever spoke about", () => {
    // The ordinary case: obsel's own workers and the page's table form are not
    // MCP clients of anything.
    const record = toTaskRecord(entity({}));

    expect(record.client).toEqual({ registered: null, started: null, reported: null });
  });
});
