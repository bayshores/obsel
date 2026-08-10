/**
 * What an erasure state is called on screen, and what color it is drawn in.
 *
 * Pure, and the single place either decision is made, for the same reason
 * `tone.ts` is that place for staleness: two surfaces disagreeing about whether
 * an asset is covered is a failure mode worth one shared function to rule out.
 *
 * **The vocabulary is enforced here rather than remembered.** `docs/erasure-
 * coverage.md` forbids "proven clean", "proof" and "complete", and forbids
 * reporting coverage as a percentage. None of those can be produced by any input
 * to any function in this file, and a test asserts it over every state. The
 * enum spellings are equally kept off the board: `ATTESTED` is an internal
 * identifier, and the board's own rule is that internal identifiers do not reach
 * a reader.
 *
 * Nothing here can mark an asset covered. There is no such function because
 * there is no such route, and the shape of this module should not suggest one
 * could be added.
 */

import type { ErasureState } from "@/src/server/coordinator/erasure";
import { agreeing } from "../naming";

/**
 * The word a reader sees, for each of the three answers.
 *
 * "attested absent" rather than "clean", and the difference is the whole
 * product: obsel holds no warehouse credentials and never reads warehouse data,
 * so it cannot say an asset is clean. It can say somebody signed a statement
 * that the subject was absent from a named version, which is a smaller claim and
 * a true one.
 *
 * "unattested" rather than "unknown" or "pending". Both of those describe
 * obsel's state of knowledge as temporary, which invites the reader to wait for
 * it to resolve. It does not resolve on its own: an asset is unattested until
 * somebody attests to it, and the list of them is the report's most useful
 * output.
 */
export function stateWord(state: ErasureState): string {
  switch (state) {
    case "ATTESTED":
      return "attested absent";
    case "UNPROVEN":
      return "unattested";
    case "CONTRADICTED":
      return "reported still present";
  }
}

/**
 * How the board is being read, decided in one place rather than in the canvas.
 *
 * Three answers, and the third exists because the first two are not enough. A
 * reader who asked for coverage colors and whose next read failed has no report
 * to color with, and the board must not answer that by drawing the staleness
 * colors: the same green would go from "attested absent" to "finished", under a
 * reader who is still asking the erasure question, with the only failure text
 * on a tab that may not be open. So the colors are withheld and the board says
 * so where the colors were.
 *
 * This is the erasure half's default rule applied to the canvas: nothing said is
 * not an all-clear, and it is not a different question's answer either.
 */
export type BoardReading =
  /** Not colored by coverage. Amber where finished work went out of date. */
  | { kind: "staleness" }
  /** Colored by a report that was read. */
  | { kind: "coverage"; states: ReadonlyMap<string, ErasureState> }
  /** Coverage was asked for and there is no report to color with. */
  | { kind: "withheld"; notice: string };

export function boardReading(input: {
  /** Whether a reader asked for the board to be colored by coverage. */
  graphMode: boolean;
  /** Whether obsel is watching a request at all, which is what a read needs. */
  watching: boolean;
  /** What the last read produced, or nothing when it failed or has not landed. */
  coverage: readonly { asset: string; state: ErasureState }[] | null;
  /** Whether a read has come back at all, which separates a failure from a wait. */
  everRead: boolean;
}): BoardReading {
  if (!input.graphMode) return { kind: "staleness" };
  if (input.coverage === null) {
    // Three ways there is no report, and obsel may only say the one that
    // happened. No request named means nothing is being read at all: a reader
    // who clears the field while the colors are on was told obsel was reading a
    // report it had never been given. Of the remaining two, a read still in
    // flight is not a failed one, and calling it one reports an outcome obsel
    // does not have. All three withhold the colors, for the same reason.
    const cause = !input.watching
      ? "No erasure request has been named, so there is no report to color this board by."
      : input.everRead
        ? "obsel could not read the erasure report, so there is nothing to color this board by."
        : "obsel is reading the erasure report.";
    return {
      kind: "withheld",
      notice: `${cause} The board is left uncolored rather than falling back to the out-of-date colors, where green means finished work rather than attested absent.`,
    };
  }
  return {
    kind: "coverage",
    states: new Map(input.coverage.map((entry) => [entry.asset, entry.state])),
  };
}

/** What each state resolves to. Never a color value, always an mmux token. */
export interface CoverageTone {
  /** Tints the asset's marker and its state word. */
  fill: string;
}

/**
 * The color of each state, and one of the three is deliberately not amber.
 *
 * Amber on this board means exactly one thing, stated in `tone.ts`: finished
 * work went out of date. An erasure gap is not that. Nothing is out of date, no
 * upstream moved, and painting an unattested asset amber would put obsel's one
 * reserved signal on a condition it does not mean, on the same screen, minutes
 * apart. A test asserts amber appears in none of the three.
 *
 * Gray for `UNPROVEN`, because nobody having said anything is genuinely the
 * absence of a signal rather than a signal of its own. Red for `CONTRADICTED`,
 * which `globals.css` warns against for staleness and which is right here: a
 * stale task succeeded and was then undermined, whereas a contradicted asset has
 * an attestor reporting the subject is still in it. That is an adverse finding
 * about the data, which is what red is for.
 */
export function coverageTone(state: ErasureState): CoverageTone {
  switch (state) {
    case "ATTESTED":
      return { fill: "var(--mm-green)" };
    case "UNPROVEN":
      return { fill: "var(--obsel-text-quiet)" };
    case "CONTRADICTED":
      return { fill: "var(--mm-red)" };
  }
}

/** The counts `summarize` produces, which this module states in words. */
export interface CoverageSummary {
  total: number;
  attested: number;
  unproven: number;
  contradicted: number;
}

/**
 * The line a report leads with.
 *
 * `"N of M assets covered, K unattested"`, which is the phrasing the
 * specification's vocabulary table requires, and never a percentage. "96%
 * covered" invites a reader to round up to done, and the four assets in the
 * remainder are the entire point of the exercise.
 *
 * The empty case is worded rather than counted. A request that reached nothing
 * would read "0 of 0 assets covered, 0 unattested", which looks like a broken
 * instrument and is the one state it is not: it is a request whose seeds have no
 * recorded lineage, and saying so is actionable where three zeroes are not.
 */
export function summaryLine(summary: CoverageSummary): string {
  if (summary.total === 0) {
    return "This request reached no assets. Nothing downstream of its seed tables is recorded in DataHub.";
  }
  const covered = `${summary.attested} of ${summary.total} ${agreeing(summary.total, "asset")} covered`;
  const unattested = `${summary.unproven} unattested`;
  return summary.contradicted > 0
    ? `${covered}, ${unattested}, ${summary.contradicted} reported still present`
    : `${covered}, ${unattested}`;
}

/**
 * How the assurance block is stated: what the walk covered, not what it proved.
 *
 * Both numbers are here because either alone misleads. A report over three
 * assets can be entirely covered and say nothing about an estate of three
 * hundred, and a reader who sees only "3 of 3 covered" has no way to tell those
 * apart. The hop count is the other half: coverage stops where the walk did.
 *
 * `assurance.limits` is deliberately not rendered. The tab already tells a
 * reader that obsel walks the lineage DataHub records and attests nothing
 * itself, and one surface may not state the same fact twice. The limits exist
 * for the JSON, whose readers do not have the tab's sentence in front of them.
 */
export function assuranceLine(assurance: {
  hopsWalked: number;
  assetsReached: number;
  evidenceRecords: number;
}): string {
  return [
    `Walked ${assurance.hopsWalked} ${agreeing(assurance.hopsWalked, "hop")} downstream`,
    `reached ${assurance.assetsReached} ${agreeing(assurance.assetsReached, "asset")}`,
    `built from ${assurance.evidenceRecords} ledger ${agreeing(assurance.evidenceRecords, "record")}`,
  ].join(", ");
}
