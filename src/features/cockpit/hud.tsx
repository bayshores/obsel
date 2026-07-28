"use client";

/**
 * The two measured numbers, pinned to the bottom of the dock.
 *
 * They were a ribbon across the foot of the page, which worked until the page
 * got long enough to scroll: on the forty-task board the demo script had to
 * describe a deliberate scroll past two folded panels to reach the figure the
 * whole demonstration exists to establish. Pinned here they are in frame in
 * every state, on every tab, at both target viewports, and the page does not
 * scroll at all.
 *
 * Nothing else moved. The ribbon, the cells, the five states of the write-back
 * count and the rule that a withheld read blanks every figure are exactly as
 * they were; this file is where they now live.
 */

import { useReducedMotion } from "motion/react";

import { StatCell, StatRibbon } from "./mmux";
import { agreeing } from "./naming";
import { useCountUp } from "./use-count-up";
import type { SwarmTotals } from "./timing";

/**
 * What a withheld number reads as.
 *
 * Was an em dash. The honesty rule it serves is unchanged: when a read fails,
 * every derived figure renders as this rather than holding its last value,
 * because a stale "0 out of date" beside a broken connection is exactly the false
 * all-clear obsel exists to prevent. Only the character changed.
 */
export const BLANK = "··";

export function Hud({ trusted, totals }: { trusted: boolean; totals: SwarmTotals }) {
  const still = useReducedMotion() === true;

  /*
   * The detection figure, run up from zero when it arrives.
   *
   * This is the number the whole demonstration exists to establish, and between
   * two polls it used to appear fully formed, which is the same as not appearing
   * at all to anybody who blinked. Counting it makes the moment visible.
   *
   * Keyed on which change is being timed, not on the number. A board polled once
   * a second re-serves the same figure for as long as the marks stand, so keying
   * on the value would restart the count every second forever. `source` names the
   * task whose output moved and `flagged` how many marks came from it, which
   * together change exactly when a different change is being reported.
   *
   * The animation cannot alter the value: `useCountUp` renders the target itself
   * on its last frame, and returns it immediately when there is no counting to do.
   */
  const measured = trusted && totals.timing !== null ? totals.timing.ms : null;
  const counted = useCountUp(
    measured,
    totals.timing === null ? "none" : `${totals.timing.source}|${totals.timing.flagged}`,
    !still && trusted,
  );

  return (
    /*
     * Two figures, down from five.
     *
     * `tasks`, `finished` and `out of date` all left: every one of them is
     * countable off the graph, and between this ribbon, the headline and the
     * feed the board was stating "3 of 4" four separate times. What is left is
     * the pair a reader cannot derive by looking, and the one the whole demo
     * exists to establish.
     */
    <StatRibbon label="Detection" tour="numbers">
      {[
        <StatCell
          key="detection"
          label="detection time"
          value={counted === null ? BLANK : String(counted)}
          /*
           * "nothing detected yet" rather than "not measured".
           *
           * Both are true and only one of them says which. A settled board is
           * obsel's good outcome, and it was reporting that outcome in the
           * vocabulary of a broken instrument: two cells reading "not measured"
           * and "nothing marked" side by side look like a failed read, which is
           * the one thing they are not.
           */
          unit={trusted ? (totals.timing !== null ? "ms" : "nothing detected yet") : undefined}
          accent={trusted && totals.timing !== null}
          glow={trusted && totals.timing !== null}
        />,
        writeBack(trusted, totals),
      ]}
    </StatRibbon>
  );
}

/**
 * The write-back cell, in every state it can honestly be in.
 *
 * obsel writes a tag and its properties onto each marked job through the MCP
 * server, and this counts those tags back off the entities. A real check, not a
 * badge: obsel writes the mark before the tag and DataHub's writes are
 * asynchronous, so a marked task legitimately has no tag for a moment and the
 * count reads low until it lands. That is why this is a count rather than a
 * tick. A number moving from 2 of 3 to 3 of 3 reads as a write in flight, where
 * a red cross would read as a failure and be wrong.
 *
 * Five states, and the distinctions between them are the point:
 *
 * - **read failed** — withheld, like every other measured figure on the board.
 * - **not recorded** — this snapshot predates obsel reading tags back, so it says
 *   so. Rendering `0 of 3` would claim three tags are missing that obsel never
 *   looked for, which understates its own contribution and is still a false claim.
 * - **nothing marked** — a calm board. `0 of 0 tagged` is true and reads as a
 *   failure, so it is worded rather than counted.
 * - **left over** — DataHub holds a tag for work obsel considers clean. Unlike a
 *   shortfall this never resolves by waiting, so it gets its own words.
 * - **counted** — `N of M`, accented only when every write is confirmed.
 */
function writeBack(trusted: boolean, t: SwarmTotals): React.ReactElement {
  // `preserveCase`, because the ribbon lowercases labels and this one carries
  // DataHub's name. It rendered as "written into datahub" until this was added,
  // misspelling the product on the one cell that exists to credit it.
  const cell = (value: string, unit?: string, lit = false): React.ReactElement => (
    <StatCell
      key="written"
      label="written into DataHub"
      preserveCase
      value={value}
      unit={unit}
      accent={lit}
      glow={lit}
    />
  );

  if (!trusted) return cell(BLANK);
  if (t.tagged === null || t.leftOver === null) return cell(BLANK, "obsel did not check");
  if (t.marked === 0) {
    return t.leftOver > 0
      ? cell(String(t.leftOver), `${agreeing(t.leftOver, "tag")} left over from before`)
      : cell(BLANK, "nothing to write yet");
  }
  return cell(
    `${t.tagged} of ${t.marked}`,
    t.leftOver > 0 ? `tagged, ${t.leftOver} left over from before` : "tagged",
    t.tagged === t.marked,
  );
}
