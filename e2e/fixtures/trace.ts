/**
 * Canned `GET /api/trace` bodies for the browser suite.
 *
 * Typed as `TraceEvent[]` so a drift between what the coordinator emits and
 * what the panel reads fails `pnpm typecheck` before any browser starts.
 *
 * These are invented values. Nothing here may be screenshotted into the
 * submission or quoted as a measurement — the real trace is narration of real
 * writes, and a fixture that looks like one is exactly the thing obsel must not
 * put on screen.
 */

import type { TraceEvent } from "@/src/server/coordinator/types";

/** Nothing has happened yet — the panel's own empty state. */
export function noSteps(): TraceEvent[] {
  return [];
}

/**
 * One complete cascade, in the order the coordinator performs it.
 *
 * The shape matters more than the wording: a read, a comparison that found a
 * change, one walk reporting how many were affected, one mark per affected task,
 * and a measured close. A panel that rendered these out of order would show
 * marks before the comparison that caused them.
 */
export function cascadeSteps(): TraceEvent[] {
  return [
    {
      seq: 1,
      at: "2026-07-22T09:00:00.000Z",
      phase: "read",
      message: "Orders cleaner finished",
      outcome: "read 4 tasks from DataHub",
    },
    {
      seq: 2,
      at: "2026-07-22T09:00:00.100Z",
      phase: "compare",
      message: "compared clean orders",
      outcome: "columns changed, values did not",
    },
    {
      seq: 3,
      at: "2026-07-22T09:00:00.200Z",
      phase: "walk",
      message: "walked lineage from clean orders",
      outcome: "Daily revenue (1 hop), Revenue report (2 hops), Table docs (2 hops)",
    },
    {
      seq: 4,
      at: "2026-07-22T09:00:00.300Z",
      phase: "mark",
      message: "marked Daily revenue out of date",
      outcome: "1 hop from the change",
    },
    {
      seq: 5,
      at: "2026-07-22T09:00:00.400Z",
      phase: "done",
      message: "marked 3 out of date",
      outcome: "142 ms end to end",
    },
  ];
}

/**
 * Several quiet decisions ahead of the cascade, which is what a real session holds.
 *
 * A live board after `run` then `change` held 25 steps in five passes: one judgement
 * per agent completion, four of which found nothing to do, then the one that
 * cascaded. This fixture reproduces that shape, and exists for two assertions the
 * short fixture cannot make.
 *
 * The panel must group them. Undivided, four separate judgements read as one long
 * preamble in which nothing happened, and those four are half of what makes the
 * fifth believable.
 *
 * And the board's word ceiling must not move when obsel narrates more. The panel
 * renders the whole trace now rather than the last eight steps, so a ceiling counting
 * DOM text would grow with the length of the run, and the way to pass it would be to
 * narrate less. Roughly a dozen steps are on screen whatever is held.
 */
export function manyDecisions(): TraceEvent[] {
  const quiet: TraceEvent[] = ["Orders cleaner", "Daily revenue", "Revenue report", "Table docs"]
    .flatMap((who, index): Omit<TraceEvent, "seq">[] => [
      {
        at: `2026-07-22T08:5${index}:00.000Z`,
        phase: "read",
        message: `${who} finished`,
        outcome: "read 4 tasks from DataHub",
      },
      {
        at: `2026-07-22T08:5${index}:00.100Z`,
        phase: "compare",
        message: "compared its output",
        outcome: "first run, nothing to compare against",
      },
      {
        at: `2026-07-22T08:5${index}:00.200Z`,
        phase: "done",
        message: "nothing marked",
        outcome: "84 ms end to end",
      },
    ])
    // Sequence numbers are assigned here rather than written out, so inserting a
    // pass cannot silently duplicate one and make React reuse a row.
    .map((event, index) => ({ ...event, seq: index + 1 }));

  const offset = quiet.length;
  return [...quiet, ...cascadeSteps().map((event) => ({ ...event, seq: event.seq + offset }))];
}
