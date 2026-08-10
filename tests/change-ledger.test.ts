/**
 * What a decision looks like once it is written down.
 *
 * The rule these exist to hold: **a completion that decided nothing records
 * nothing.** Without it, every re-run of every task appends a record saying
 * nothing happened, and a history a reader has to scroll past to find the two
 * entries that matter is a history nobody reads. The trace already narrates the
 * quiet ones while they happen.
 *
 * The second rule is that the column diff has to survive into the record.
 * `decideCompletion` computes it at the one moment both column lists exist and
 * `recordCompletion` overwrites the older one a few lines later, so a record
 * built from task properties after the fact could say a table changed and never
 * which columns moved.
 */

import { describe, expect, it } from "vitest";

import {
  changeBody,
  closableIncidents,
  raisedIncidentRecord,
} from "@/src/server/coordinator/change-ledger";
import { changeUrn } from "@/src/server/datahub/documents";
import type { DatasetChange } from "@/src/server/coordinator/staleness";
import type { AffectedTask, StaleMark, TaskRecord } from "@/src/server/coordinator/types";

const AT = "2026-07-29T12:00:00.000Z";

function ds(name: string): string {
  return `urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.${name},PROD)`;
}

function task(name: string): TaskRecord {
  return {
    urn: `urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),${name})`,
    name,
    reads: [],
    writes: [],
    status: "complete",
    fingerprints: {},
    finishedAt: AT,
    startedAt: null,
    run: null,
    stale: null,
  };
}

function mark(overrides: Partial<StaleMark> = {}): StaleMark {
  return {
    causedBy: ds("clean_orders"),
    causedByTask: null,
    hops: 1,
    changeKind: "schema",
    reason: "built on clean orders, which changed after this finished",
    since: AT,
    detectedMs: 412,
    ...overrides,
  };
}

function affected(name: string, overrides: Partial<StaleMark> = {}): AffectedTask {
  return { task: task(name), mark: mark(overrides) };
}

function input(overrides: Partial<Parameters<typeof changeBody>[0]> = {}) {
  return changeBody({
    source: "completion",
    reporter: task("clean_orders"),
    at: AT,
    changes: [],
    affected: [],
    restored: [],
    elapsedMs: 412,
    ...overrides,
  });
}

describe("a decision that changed nothing is not recorded", () => {
  it("returns null for a completion that marked and cleared nothing", () => {
    // The common case by a wide margin: every identical re-run lands here.
    expect(input()).toBeNull();
  });

  it("returns null even when outputs changed but nothing finished downstream", () => {
    // A changed table with no finished readers is a real change and not a
    // decision about anybody's work. The board already shows the new
    // fingerprint; a history entry would be a row that names no consequence.
    const changes: DatasetChange[] = [{ dataset: ds("clean_orders"), kind: "schema" }];
    expect(input({ changes })).toBeNull();
  });

  it("records a decision that only cleared flags", () => {
    const body = input({
      restored: [{ task: task("write_docs"), reason: "the redo came back identical" }],
    });

    expect(body?.event).toBe("cleared");
    expect(body?.restored).toEqual([
      {
        taskUrn: task("write_docs").urn,
        name: "write_docs",
        reason: "the redo came back identical",
      },
    ]);
  });

  it("leads with the flag when one decision both flagged and cleared", () => {
    // A reader has to act on the flag and does not have to act on the clear, so
    // a decision carrying both is a marking.
    //
    // Unit-only, and worth saying why: reaching this live needs one task writing
    // two tables where one moves and the other does not, since a revert of a
    // single output is a fresh change that clears nothing (asserted in
    // `tests/live/change-ledger.live.test.ts`). A fixture built solely to produce
    // the combination belongs here, where the inputs are the subject.
    const body = input({
      affected: [affected("daily_revenue")],
      restored: [{ task: task("write_docs"), reason: "the redo came back identical" }],
    });

    expect(body?.event).toBe("marked");
    expect(body?.affected).toHaveLength(1);
    expect(body?.restored).toHaveLength(1);
  });
});

describe("what a record carries about the change", () => {
  it("keeps the column diff, which exists nowhere else by the time this is read", () => {
    const changes: DatasetChange[] = [
      {
        dataset: ds("clean_orders"),
        kind: "schema",
        columns: { added: ["order_total_usd"], removed: ["order_total"] },
      },
    ];
    const body = input({ changes, affected: [affected("daily_revenue")] });

    expect(body?.changes[0].columns).toEqual({
      added: ["order_total_usd"],
      removed: ["order_total"],
    });
  });

  it("omits a column diff the engine could not compute rather than inventing an empty one", () => {
    // `columnChange` returns null when either column list is unknown. An empty
    // added/removed pair would read as "the columns are the same", which is a
    // different claim from "obsel does not know what moved".
    const changes: DatasetChange[] = [
      { dataset: ds("clean_orders"), kind: "content", columns: null },
    ];
    const body = input({ changes, affected: [affected("daily_revenue")] });

    expect(body?.changes[0]).not.toHaveProperty("columns");
  });

  it("names the volatile columns the comparison excluded", () => {
    const changes: DatasetChange[] = [
      { dataset: ds("clean_orders"), kind: "content", excluded: ["loaded_at"] },
    ];
    const body = input({ changes, affected: [affected("daily_revenue")] });

    expect(body?.changes[0].excluded).toEqual(["loaded_at"]);
  });

  it("records an unreported change as unreported, naming who noticed", () => {
    const changes: DatasetChange[] = [
      {
        dataset: ds("clean_orders"),
        kind: "content",
        unreported: { noticedBy: task("daily_revenue") },
      },
    ];
    const body = input({ changes, affected: [affected("write_docs")] });

    expect(body?.changes[0].unreported).toEqual({ noticedBy: "daily_revenue" });
  });

  it("distinguishes an outside observation from a task that noticed", () => {
    // Presence and inner null are different facts, exactly as `DatasetChange`
    // documents: an observation had no swarm member behind it at all.
    const changes: DatasetChange[] = [
      { dataset: ds("clean_orders"), kind: "content", unreported: { noticedBy: null } },
    ];
    const body = input({
      source: "observation",
      reporter: undefined,
      changes,
      affected: [affected("write_docs")],
    });

    expect(body?.source).toBe("observation");
    expect(body?.changes[0].unreported).toEqual({ noticedBy: null });
    // No reporter at all, rather than the producer: naming it would blame it for
    // bytes it never reported writing.
    expect(body).not.toHaveProperty("reporter");
  });

  it("names each flagged task with its distance and its reason", () => {
    const body = input({
      affected: [affected("daily_revenue", { hops: 1 }), affected("write_docs", { hops: 2 })],
    });

    expect(body?.affected.map((entry) => [entry.name, entry.hops])).toEqual([
      ["daily_revenue", 1],
      ["write_docs", 2],
    ]);
    expect(body?.affected[0].reason).toContain("clean orders");
  });

  it("carries the connecting client when one reported, and omits it otherwise", () => {
    const withClient = input({
      affected: [affected("daily_revenue")],
      client: { name: "claude-code", version: "2.1" },
    });
    expect(withClient?.client).toEqual({ name: "claude-code", version: "2.1" });

    const without = input({ affected: [affected("daily_revenue")] });
    expect(without).not.toHaveProperty("client");
  });

  it("records the measured duration rather than a derived one", () => {
    const body = input({ affected: [affected("daily_revenue")], elapsedMs: 5399 });
    expect(body?.elapsedMs).toBe(5399);
  });

  it("carries the incident it raised, and omits the field when it raised none", () => {
    // The field is what the repair path reads to find out which tasks closing
    // the incident depends on. A record written before incidents existed has no
    // such field, so absent has to keep meaning "no incident".
    const raised = input({
      affected: [affected("daily_revenue")],
      incident: {
        urn: "urn:li:incident:11111111-2222-3333-4444-555555555555",
        dataset: ds("clean_orders"),
        taskUrns: [task("daily_revenue").urn],
      },
    });
    expect(raised?.incident).toEqual({
      urn: "urn:li:incident:11111111-2222-3333-4444-555555555555",
      dataset: ds("clean_orders"),
      taskUrns: [task("daily_revenue").urn],
    });

    expect(input({ affected: [affected("daily_revenue")] })).not.toHaveProperty("incident");
  });
});

describe("an incident whose confirmation did not land", () => {
  /*
   * `raiseIncident` mints the URN and returns it; obsel then polls two aspect
   * reads to confirm the incident is ACTIVE and attached to the table. Those
   * two reads can fail on a transient non-2xx or a timeout after the incident
   * already exists in DataHub. The URN is the only handle anything has on it:
   * `resolveClosedIncidents` and `resolveResetIncidents` both take their
   * candidates from change records, so a URN that never reaches a record names
   * an incident that stays ACTIVE and holds the dataset's health at FAIL with
   * nothing able to close it. An unconfirmed raise is therefore still recorded,
   * and reported as unconfirmed rather than as a success.
   */
  const RAISED = {
    urn: "urn:li:incident:99999999-8888-7777-6666-555555555555",
    dataset: ds("clean_orders"),
    taskUrns: [task("daily_revenue").urn],
  };

  it("is still recorded, so a later repair can name it", () => {
    const unconfirmed = raisedIncidentRecord(
      { urn: RAISED.urn, confirmed: false, unconfirmed: "DataHub write was not confirmed" },
      RAISED.dataset,
      RAISED.taskUrns,
    );
    expect(unconfirmed).toEqual(RAISED);

    const body = input({
      affected: [affected("daily_revenue")],
      incident: unconfirmed ?? undefined,
    });
    expect(body?.incident?.urn).toBe(RAISED.urn);
    expect(closableIncidents([body], () => false)).toEqual([RAISED]);
  });

  it("records the same entry a confirmed raise does", () => {
    expect(
      raisedIncidentRecord({ urn: RAISED.urn, confirmed: true }, RAISED.dataset, RAISED.taskUrns),
    ).toEqual(RAISED);
  });

  it("records nothing when there was no raise at all", () => {
    // The skip trap 4 forces: DataHub has no dataset under that urn, so no
    // incident exists and there is nothing for a repair to close.
    expect(raisedIncidentRecord(null, RAISED.dataset, RAISED.taskUrns)).toBeNull();
  });
});

describe("which incidents a repair has closed out", () => {
  const INCIDENT = {
    urn: "urn:li:incident:11111111-2222-3333-4444-555555555555",
    dataset: ds("clean_orders"),
    taskUrns: [task("build_revenue").urn, task("write_docs").urn],
  };

  function recorded(): ReturnType<typeof changeBody> {
    return input({ affected: [affected("build_revenue")], incident: INCIDENT });
  }

  it("closes one whose named tasks no longer cite the table it was raised on", () => {
    expect(closableIncidents([recorded()], () => false)).toEqual([INCIDENT]);
  });

  it("leaves one open when a single named task is still flagged for that table", () => {
    // The partial repair. One of two tasks redone is not the incident closing;
    // resolving here would have DataHub saying the opposite of obsel's own marks.
    const stillFlagged = (taskUrn: string): boolean => taskUrn === task("write_docs").urn;
    expect(closableIncidents([recorded()], stillFlagged)).toEqual([]);
  });

  it("ignores a mark citing some other table, which never held it open", () => {
    // The incident is about one output moving, not about the board being clean.
    const cites = (_taskUrn: string, dataset: string): boolean => dataset === ds("daily_revenue");
    expect(closableIncidents([recorded()], cites)).toEqual([INCIDENT]);
  });

  it("skips records that carry no incident, and bodies that would not parse", () => {
    const noIncident = input({ affected: [affected("build_revenue")] });
    expect(closableIncidents([noIncident, null], () => false)).toEqual([]);
  });

  it("returns one entry per incident however many records name it", () => {
    // A retried completion can write the same incident into two records. It is
    // resolved once; a second call on a resolved incident would be a write with
    // nothing behind it.
    expect(closableIncidents([recorded(), recorded()], () => false)).toEqual([INCIDENT]);
  });
});

describe("the urn a change record lands on", () => {
  it("scopes the sequence to the board, so two flows cannot interleave", () => {
    // The isolation the live suites rely on: without the flow in the urn, a test
    // run would append into the operator's history and both would read as one.
    expect(changeUrn("orders_pipeline", 1)).not.toBe(changeUrn("obsel_bench_check", 1));
  });

  it("separates sequence numbers within one board", () => {
    expect(changeUrn("orders_pipeline", 1)).not.toBe(changeUrn("orders_pipeline", 2));
  });

  it("is derived from the flow id alone, so the same board always resolves the same way", () => {
    // Derived, never searched for. A reader recomputes the urn from the flow it
    // is already pointed at, which is what keeps the search index out of this
    // path entirely.
    expect(changeUrn("orders_pipeline", 3)).toBe(changeUrn("orders_pipeline", 3));
  });

  it("keeps flow ids apart that differ only in punctuation", () => {
    // `OBSEL_FLOW_ID` is unvalidated environment input, so the readable part of
    // the slug strips punctuation — and two ids that strip to the same string
    // must still land on different urns.
    expect(changeUrn("my-board", 1)).not.toBe(changeUrn("my_board", 1));
    expect(changeUrn("my.board", 1)).not.toBe(changeUrn("myboard", 1));
  });

  it("stays inside the document namespace obsel's ledger owns", () => {
    expect(changeUrn("orders_pipeline", 1)).toMatch(/^urn:li:document:obsel\.change\./);
  });
});
