/**
 * Who moves the change ledger's head, and when.
 *
 * The ledger is a dense sequence. `changeHeadFor` and `readChangesFor` both count
 * up from one and stop at the first genuine 404, so one empty position hides
 * every record above it from every reader, permanently. `recordChange` in
 * `src/server/coordinator/completion-writes.ts` catches a failed ledger write and
 * carries on, by design, which means the failed write has to leave the sequence
 * exactly where it found it.
 *
 * These run without DataHub and without a stand-in for it. The head cache is the
 * real one, seeded through `noteChangeWritten`, which is the same call
 * `writeChangeRecord` makes after a record is confirmed present; with the cache
 * seeded, neither function under test reads anything over the network.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  changeHeadFor,
  forgetChangeHeads,
  nextChangeSequence,
  noteChangeWritten,
} from "@/src/server/datahub/documents";

const FLOW = "obsel_change_sequence_test";
const OTHER = "obsel_change_sequence_other";

beforeEach(() => {
  forgetChangeHeads();
});

describe("reserving a sequence number", () => {
  it("hands back the position after the head", async () => {
    noteChangeWritten(FLOW, 4);
    expect(await nextChangeSequence(FLOW)).toBe(5);
  });

  it("leaves the head where it was, so a write that never happened costs nothing", async () => {
    noteChangeWritten(FLOW, 1);

    // The state `completion-writes.ts` leaves behind when `writeChangeRecord`
    // throws: a number was reserved and no record was written at it.
    expect(await nextChangeSequence(FLOW)).toBe(2);
    expect(await changeHeadFor(FLOW)).toBe(1);

    // The next decision has to refill 2. Reserving 3 would leave 2 empty, and
    // from then on no reader sees 3 or anything after it.
    expect(await nextChangeSequence(FLOW)).toBe(2);
  });

  it("advances only once the record at that position is confirmed", async () => {
    noteChangeWritten(FLOW, 1);
    const reserved = await nextChangeSequence(FLOW);
    noteChangeWritten(FLOW, reserved);

    expect(await changeHeadFor(FLOW)).toBe(2);
    expect(await nextChangeSequence(FLOW)).toBe(3);
  });

  it("does not walk the head backwards when a retry refills an earlier position", async () => {
    noteChangeWritten(FLOW, 7);
    noteChangeWritten(FLOW, 3);
    expect(await changeHeadFor(FLOW)).toBe(7);
  });

  it("keeps one board's head out of another's", async () => {
    noteChangeWritten(FLOW, 9);
    noteChangeWritten(OTHER, 2);

    expect(await nextChangeSequence(FLOW)).toBe(10);
    expect(await nextChangeSequence(OTHER)).toBe(3);
  });

  it("forgets one board's head without disturbing the rest", async () => {
    noteChangeWritten(FLOW, 9);
    noteChangeWritten(OTHER, 2);
    forgetChangeHeads(OTHER);

    expect(await changeHeadFor(FLOW)).toBe(9);
  });
});
