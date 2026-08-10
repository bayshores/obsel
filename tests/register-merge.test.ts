/**
 * What re-registering a task that already exists is allowed to do to its record.
 *
 * The defect these cover: `POST /api/tasks/register` called `registerTask`
 * unconditionally, and `registerTask` rebuilt `dataJobInfo.customProperties`
 * from the declaration alone. The OpenAPI v3 upsert replaces the whole aspect,
 * so a task that had already finished lost its recorded fingerprints,
 * `finishedAt`, its previous and observed fingerprints and any stale mark, and
 * kept its lineage — a record that looks intact and has no baseline behind it.
 * Its next completion compared against nothing, `compareFingerprints` read that
 * as a first run, and a real change was reported as no change with nothing
 * downstream marked. Re-declaring a task you already own is an ordinary thing
 * for an agent to do, and the MCP door already refused to re-POST for exactly
 * this reason while the HTTP door did not.
 *
 * The decision is deterministic and lives in `registration.ts`, so it is checked
 * here. That the round trip through DataHub really preserves the aspect is
 * `tests/live/register-preserves.live.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { PROP } from "@/src/server/datahub/properties";
import {
  registrationProperties,
  sameDeclaration,
  type Declaration,
} from "@/src/server/datahub/registration";

const DECLARED: Declaration = {
  reads: ["urn:li:dataset:raw_orders"],
  writes: ["urn:li:dataset:clean_orders"],
  volatile: '{"urn:li:dataset:clean_orders":["loaded_at"]}',
  title: "Orders cleaner",
  description: "cleans the orders table",
};

/** What one finished run left on the DataJob. */
const FINISHED: Record<string, string> = {
  [PROP.status]: "complete",
  [PROP.title]: "Orders cleaner",
  [PROP.volatile]: '{"urn:li:dataset:clean_orders":["loaded_at"]}',
  [PROP.fingerprints]: '{"urn:li:dataset:clean_orders":{"schema":"sha1","content":"sha2"}}',
  [PROP.previousFingerprints]: '{"urn:li:dataset:clean_orders":{"schema":"sha0","content":"sha0"}}',
  [PROP.observed]: '{"urn:li:dataset:clean_orders":{"schema":"sha1","content":"sha3"}}',
  [PROP.finishedAt]: "2026-08-10T09:00:00.000Z",
  [PROP.startedAt]: "2026-08-10T08:59:00.000Z",
  [PROP.runRunner]: "codex",
  [PROP.staleCausedBy]: "urn:li:dataset:raw_orders",
  [PROP.staleSince]: "2026-08-10T09:30:00.000Z",
  [PROP.staleHops]: "1",
  [PROP.staleChangeKind]: "content",
  [PROP.clientRegistered]: '{"name":"claude-code","version":"1","at":"2026-08-10T08:00:00.000Z"}',
};

/** The declaration a registration restates about itself, and nothing else. */
const RESTATED: Record<string, string> = {
  [PROP.status]: "registered",
  [PROP.title]: "Orders cleaner",
  [PROP.volatile]: '{"urn:li:dataset:clean_orders":["loaded_at"]}',
};

describe("a declaration already on file", () => {
  it("is recognized, so nothing is written over it", () => {
    expect(sameDeclaration(DECLARED, { ...DECLARED })).toBe(true);
  });

  it("is recognized when the same tables are listed in another order", () => {
    const twoReads = { ...DECLARED, reads: ["urn:li:dataset:a", "urn:li:dataset:b"] };
    const reversed = { ...twoReads, reads: ["urn:li:dataset:b", "urn:li:dataset:a"] };
    expect(sameDeclaration(twoReads, reversed)).toBe(true);
  });

  it("is not recognized when a table is added, so the new lineage is written", () => {
    const wider = { ...DECLARED, reads: [...DECLARED.reads, "urn:li:dataset:raw_refunds"] };
    expect(sameDeclaration(DECLARED, wider)).toBe(false);
  });

  it("is not recognized when an output moves", () => {
    expect(sameDeclaration(DECLARED, { ...DECLARED, writes: ["urn:li:dataset:other"] })).toBe(
      false,
    );
  });

  it("is not recognized when the volatile list differs", () => {
    expect(sameDeclaration(DECLARED, { ...DECLARED, volatile: "{}" })).toBe(false);
  });

  it("is not recognized when the title or the description differs", () => {
    expect(sameDeclaration(DECLARED, { ...DECLARED, title: "Orders scrubber" })).toBe(false);
    expect(sameDeclaration(DECLARED, { ...DECLARED, description: "something else" })).toBe(false);
  });
});

describe("a re-registration that genuinely differs", () => {
  const merged = registrationProperties(FINISHED, RESTATED);

  it("keeps the fingerprints the next comparison needs", () => {
    // The whole defect in one assertion: without these the next completion has
    // no baseline, reads as a first run, and reports a real change as none.
    expect(merged[PROP.fingerprints]).toBe(FINISHED[PROP.fingerprints]);
    expect(merged[PROP.previousFingerprints]).toBe(FINISHED[PROP.previousFingerprints]);
    expect(merged[PROP.observed]).toBe(FINISHED[PROP.observed]);
  });

  it("keeps when the work finished, and the run behind it", () => {
    expect(merged[PROP.finishedAt]).toBe(FINISHED[PROP.finishedAt]);
    expect(merged[PROP.startedAt]).toBe(FINISHED[PROP.startedAt]);
    expect(merged[PROP.runRunner]).toBe(FINISHED[PROP.runRunner]);
  });

  it("keeps the status, and with it the stale mark", () => {
    // `parseStale` drops a mark on a task whose status is `registered`, so a
    // status reset here would take the mark down without the work being redone.
    expect(merged[PROP.status]).toBe("complete");
    expect(merged[PROP.staleCausedBy]).toBe(FINISHED[PROP.staleCausedBy]);
    expect(merged[PROP.staleSince]).toBe(FINISHED[PROP.staleSince]);
    expect(merged[PROP.staleHops]).toBe("1");
    expect(merged[PROP.staleChangeKind]).toBe("content");
  });

  it("keeps who declared the task, which is recorded once", () => {
    const again = registrationProperties(FINISHED, {
      ...RESTATED,
      [PROP.clientRegistered]: '{"name":"curl","version":null,"at":"2026-08-10T10:00:00.000Z"}',
    });
    expect(again[PROP.clientRegistered]).toBe(FINISHED[PROP.clientRegistered]);
  });

  it("takes the new title, because a re-declaration may rename the task", () => {
    const renamed = registrationProperties(FINISHED, {
      ...RESTATED,
      [PROP.title]: "Orders scrubber",
    });
    expect(renamed[PROP.title]).toBe("Orders scrubber");
  });

  it("leaves a property obsel does not own alone", () => {
    const foreign = registrationProperties({ ...FINISHED, "team.owner": "analytics" }, RESTATED);
    expect(foreign["team.owner"]).toBe("analytics");
  });
});

describe("a first registration", () => {
  const fresh = registrationProperties(undefined, RESTATED);

  it("writes exactly what was declared", () => {
    expect(fresh).toEqual(RESTATED);
  });

  it("says registered, because there is no run on file to keep", () => {
    expect(fresh[PROP.status]).toBe("registered");
  });
});
