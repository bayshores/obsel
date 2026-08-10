/**
 * A reserved sequence that is never written leaves no hole in the real ledger.
 *
 * `tests/change-sequence.test.ts` covers the bookkeeping without DataHub. What
 * only a real board can show is the consequence: `changeHeadFor` and
 * `readChangesFor` count up and stop at the first genuine 404, so if a failed
 * write had moved the head, the records written afterwards would sit above an
 * empty position and no reader would ever reach them again. `recordChange` in
 * `completion-writes.ts` catches a failed ledger write and carries on, so that
 * state is reachable in normal operation, and `resolveClosedIncidents` reads its
 * lookback window from the head, which is how a hidden record turns into a
 * DataHub incident that never resolves.
 *
 * **Its own flow id, not `FLOW_ID`.** These records are written straight through
 * `documents.ts` rather than by a completion, and appending them to the shared
 * board would put entries in the operator's history that describe no decision.
 * The flow is unique per run, so the sequence numbers here are absolute.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { requireDataHub } from "./reachable";

const { changeHeadFor, forgetChangeHeads, nextChangeSequence, readChangesFor, writeChangeRecord } =
  await import("@/src/server/datahub/documents");

const FLOW = `obsel_ledger_gap_${Date.now()}`;

function record(n: number): { at: string; body: string; assets: string[] } {
  return { at: new Date().toISOString(), body: JSON.stringify({ n }), assets: [] };
}

beforeAll(async () => {
  await requireDataHub();
});

describe("a reservation nothing was written at", () => {
  it("is handed out again, so the history stays readable to the end", async () => {
    expect(await changeHeadFor(FLOW)).toBe(0);

    const first = await nextChangeSequence(FLOW);
    await writeChangeRecord(FLOW, first, record(1));

    // Reserved and deliberately not written: exactly what `completion-writes.ts`
    // leaves behind when `writeChangeRecord` throws.
    const abandoned = await nextChangeSequence(FLOW);

    const second = await nextChangeSequence(FLOW);
    expect(second).toBe(abandoned);
    await writeChangeRecord(FLOW, second, record(2));

    // A different process's cache: the walk, against DataHub, not memory.
    forgetChangeHeads();
    expect(await changeHeadFor(FLOW)).toBe(second);

    const found = await readChangesFor(FLOW, { from: 1, limit: 10 });
    expect(found).toHaveLength(2);
    expect(found.map((entry) => JSON.parse(entry.body).n)).toEqual([1, 2]);
  });
});
