/**
 * What an erasure state is called on screen, and what colour it is drawn in.
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

/** What each state resolves to. Never a colour value, always an mmux token. */
export interface CoverageTone {
  /** Tints the asset's marker and its state word. */
  fill: string;
}

/**
 * The colour of each state, and one of the three is deliberately not amber.
 *
 * Amber on this board means exactly one thing, stated in `tone.ts`: finished
 * work went out of date. An erasure gap is not that. Nothing is out of date, no
 * upstream moved, and painting an unattested asset amber would put obsel's one
 * reserved signal on a condition it does not mean, on the same screen, minutes
 * apart. A test asserts amber appears in none of the three.
 *
 * Grey for `UNPROVEN`, because nobody having said anything is genuinely the
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
