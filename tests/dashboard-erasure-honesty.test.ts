/**
 * Two ways the erasure half could report a failed read as an answer.
 *
 * Both are the same fault in different places: something obsel read once stays
 * on screen, or stops being on screen without saying so, and in either case a
 * reader is looking at coverage obsel is not currently reading.
 *
 * The first is the board's colors. A reader who ticks "color the graph by
 * erasure coverage" is reading green as "attested absent". If the next read
 * fails and the board quietly goes back to the staleness colors, green means
 * "done" instead, and nothing where the colors are says the question changed.
 *
 * The second is the tab's own report. The hook says in its header that it never
 * keeps the last report on screen. Nothing dropped it when the tab closed, so
 * the frame a returning reader opened rendered the previous read as the current
 * one, and a hanging server left it there for the length of the read timeout.
 * Masking the read while the tab is closed does not reach that frame: the tab is
 * open on it. Dropping the read while the tab is closed does.
 */

import { describe, expect, it } from "vitest";

import { boardReading } from "@/src/features/dashboard/erasure/coverage-view";
import {
  NOT_READ,
  heldRead,
  holdRead,
  showingReport,
  shownRead,
} from "@/src/features/dashboard/erasure/use-erasure";
import type { ErasureRead } from "@/src/features/dashboard/erasure/use-erasure";
import type { PublishedErasureReport } from "@/src/server/coordinator/erasure-report";

const CUSTOMERS = "urn:li:dataset:(urn:li:dataPlatform:snowflake,warehouse.customers,PROD)";
const ORDERS = "urn:li:dataset:(urn:li:dataPlatform:snowflake,warehouse.orders,PROD)";

const ENTRIES = [
  { asset: CUSTOMERS, state: "ATTESTED" as const },
  { asset: ORDERS, state: "UNPROVEN" as const },
];

const REPORT: PublishedErasureReport = {
  request: { request: "dsr-2f9c", seeds: [CUSTOMERS], hops: 2, openedAt: "2026-08-10T09:00:00Z" },
  coverage: [
    {
      request: "dsr-2f9c",
      asset: CUSTOMERS,
      version: "v4",
      state: "ATTESTED",
      residue: [],
      explanation: "attested absent over version v4 by warehouse-team",
    },
  ],
  summary: { total: 1, attested: 1, unproven: 0, contradicted: 0 },
  assurance: {
    hopsWalked: 2,
    assetsReached: 1,
    evidenceRecords: 3,
    attestationsDroppedForKeys: [],
    limits: ["obsel reads no warehouse data"],
  },
};

const READ: ErasureRead = { report: REPORT, error: null, missing: false, everRead: true };

describe("what the board is colored by", () => {
  it("colors by coverage when a reader asked for it and a report was read", () => {
    const reading = boardReading({
      graphMode: true,
      watching: true,
      coverage: ENTRIES,
      everRead: true,
      missing: false,
    });
    expect(reading.kind).toBe("coverage");
    if (reading.kind !== "coverage") return;
    expect(reading.states.get(CUSTOMERS)).toBe("ATTESTED");
    expect(reading.states.get(ORDERS)).toBe("UNPROVEN");
  });

  it("reads as the staleness board when nobody asked for coverage", () => {
    expect(
      boardReading({
        graphMode: false,
        watching: true,
        coverage: ENTRIES,
        everRead: true,
        missing: false,
      }).kind,
    ).toBe("staleness");
    expect(
      boardReading({
        graphMode: false,
        watching: false,
        coverage: null,
        everRead: false,
        missing: false,
      }).kind,
    ).toBe("staleness");
  });

  /*
   * The defect. A failed read leaves the reader's choice standing and the
   * report gone, and the board must not answer that by painting the other
   * question's colors: the reader is still asking about erasure coverage.
   */
  it("withholds the colors rather than returning to the staleness board when the read fails", () => {
    const reading = boardReading({
      graphMode: true,
      watching: true,
      coverage: null,
      everRead: true,
      missing: false,
    });
    expect(reading.kind).toBe("withheld");
  });

  it("does not call a read that has not come back a failed one", () => {
    const waiting = boardReading({
      graphMode: true,
      watching: true,
      coverage: null,
      everRead: false,
      missing: false,
    });
    if (waiting.kind !== "withheld") throw new Error("a board with no report colors nothing");
    // The colors are withheld either way. What differs is which of the two
    // obsel is entitled to say has happened.
    expect(waiting.notice).toContain("is reading");
    expect(waiting.notice).not.toContain("could not read");
  });

  /*
   * The third way there is no report, and the one the first two readings
   * misreported: nobody has named a request, so obsel is not reading anything.
   * Submitting an empty field with the colors on is enough to reach it, and the
   * board answered by saying obsel was reading a report it had never been given.
   */
  it("does not say it is reading a report when it was never given a request", () => {
    const none = boardReading({
      graphMode: true,
      watching: false,
      coverage: null,
      everRead: false,
      missing: false,
    });
    if (none.kind !== "withheld") throw new Error("a board with no report colors nothing");
    expect(none.notice).not.toContain("is reading the erasure report");
    expect(none.notice).not.toContain("could not read");
    expect(none.notice).toContain("No erasure request has been named");
  });

  /*
   * The fourth way there is no report, which the other three readings reported
   * as the first: obsel answered 404, meaning it holds no such request. The
   * ledger was read and the request is not in it, so "obsel could not read the
   * erasure report" names a failure that did not happen, and a reader who
   * mistyped a request id is sent to look at obsel's connection instead of at
   * what they typed.
   */
  it("says the request is not in the ledger rather than that the read failed", () => {
    const none = boardReading({
      graphMode: true,
      watching: true,
      coverage: null,
      everRead: true,
      missing: true,
    });
    if (none.kind !== "withheld") throw new Error("a board with no report colors nothing");
    expect(none.notice).toContain("not in obsel's ledger");
    expect(none.notice).not.toContain("could not read");
    expect(none.notice).not.toContain("is reading the erasure report");
    expect(none.notice).not.toContain("No erasure request has been named");
  });

  it("says where the colors are why they are missing", () => {
    const reading = boardReading({
      graphMode: true,
      watching: true,
      coverage: null,
      everRead: true,
      missing: false,
    });
    if (reading.kind !== "withheld") throw new Error("a withheld board has to carry a notice");
    expect(reading.notice.length).toBeGreaterThan(20);
    // The two colors whose meanings would otherwise be swapped are named, so a
    // reader is told what the board is not showing rather than only that
    // something failed.
    expect(reading.notice.toLowerCase()).toContain("green");
    expect(reading.notice).not.toContain("—");
    for (const word of ["proven", "proof", "complete"]) {
      expect(reading.notice.toLowerCase()).not.toContain(word);
    }
  });
});

describe("what the erasure tab holds while nothing is showing it", () => {
  it("keeps the read while something on screen is showing it", () => {
    holdRead(READ);
    showingReport(true);
    expect(heldRead()).toEqual(READ);
    expect(shownRead(READ, true)).toEqual(READ);
  });

  /*
   * The second defect. Switching tabs stops the poll, so what is held is a
   * report from an arbitrary time ago: if a signing key was reported
   * compromised in the interval, the assets it covered read "attested absent"
   * until the next read lands.
   */
  it("holds no read once nothing on screen is showing it", () => {
    holdRead(READ);
    showingReport(false);
    expect(heldRead()).toEqual(NOT_READ);
    // And not as a first read either, or the tab would say the ledger was read
    // and found nothing.
    expect(heldRead().everRead).toBe(false);
  });

  /*
   * The frame the previous fix left wrong. `shownRead` masks the read while
   * nothing is showing it, and `active` is true again on the frame a re-opened
   * tab renders, so masking alone returned the held report to the reader who
   * came back — for up to the read timeout, if the server that answers the
   * fresh read is hanging.
   */
  it("carries no report on the frame a re-opened tab renders", () => {
    holdRead(READ);
    // The reader switches to another tab, and the erasure tab unmounts.
    showingReport(false);
    // And comes back. No fresh read has landed: this is the first frame.
    showingReport(true);
    const opening = shownRead(heldRead(), true);
    expect(opening.report).toBeNull();
    expect(opening.everRead).toBe(false);
    expect(opening.error).toBeNull();
    expect(opening.missing).toBe(false);
  });

  it("drops a failed read too, so a re-opened tab reports neither an answer nor an old failure", () => {
    const failed: ErasureRead = {
      report: null,
      error: "obsel answered 500",
      missing: false,
      everRead: true,
    };
    holdRead(failed);
    showingReport(false);
    expect(heldRead().error).toBeNull();
    expect(shownRead(failed, false).error).toBeNull();
  });
});
