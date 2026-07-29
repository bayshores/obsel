/**
 * Splitting the coordinator's steps into the decisions they belong to.
 *
 * The trace is a flat list and the work it describes is not. Measured on a live
 * board after one `run` and one `change`, the 25 steps held were:
 *
 * ```
 * write write | read compare done | read compare done | read compare done
 *             | read compare done | read compare walk mark mark mark done
 * ```
 *
 * Five separate pieces of coordination, one per agent completion, and the board
 * rendered them as 25 undifferentiated lines. A viewer could not tell that the four
 * quiet passes were four *separate* judgements rather than one long one, and those
 * four quiet judgements are half of what makes the noisy one believable.
 *
 * `read` is the boundary, and that is not a convention imposed here: every piece of
 * coordination begins by reading the swarm out of DataHub, because
 * `coordinateCompletion` cannot decide anything without it. The `read` step's own
 * message is already the trigger, `"Orders cleaner finished"`, which is why it
 * becomes the group's header rather than its first row: a divider carrying the
 * pass's *conclusion* instead would print "marked 3 out of date" immediately above
 * the step that says exactly that.
 *
 * Pure and free of React, so the grouping is testable without rendering.
 */

import type { TraceEvent } from "@/src/server/coordinator/types";

export interface TracePass {
  /** Sequence number of the pass's first step. Stable across polls, unlike an index. */
  key: number;
  /**
   * The `read` that opened this pass, rendered as the group's heading.
   *
   * Null for a leading fragment. The trace buffer holds a bounded tail, so the
   * oldest steps it retains can be the middle of a pass whose `read` has already
   * been dropped. Those steps are real and are shown, just without a heading that
   * would present them as a whole decision.
   */
  header: TraceEvent | null;
  /** Every step after the header, in the order the coordinator emitted them. */
  events: TraceEvent[];
}

/**
 * Group steps into passes, oldest first, preserving order within each.
 *
 * A step that is not a `read` joins the pass in progress. That includes the
 * `started X` write emitted when the next agent begins, which therefore sits under
 * the previous decision's heading. That is deliberate: this is a timeline, the write
 * genuinely happened after that decision, and giving bookkeeping its own heading
 * would mean inventing a label for steps that already describe themselves.
 */
export function passesOf(events: readonly TraceEvent[]): TracePass[] {
  const passes: TracePass[] = [];

  for (const event of events) {
    if (event.phase === "read") {
      passes.push({ key: event.seq, header: event, events: [] });
      continue;
    }
    const current = passes[passes.length - 1];
    if (current === undefined) {
      passes.push({ key: event.seq, header: null, events: [event] });
      continue;
    }
    current.events.push(event);
  }

  return passes;
}

/**
 * How the panel's header describes what it is holding.
 *
 * It used to read `last 8 of 25`, which named 17 steps the DOM did not contain: the
 * list was sliced to the most recent eight, so scrolling up reached the top of those
 * eight and stopped. A count a reader cannot act on is worse than no count.
 *
 * Counts decisions rather than only steps, because a decision is the unit that means
 * something. "5 decisions" is a fact about what obsel did; "25 steps" alone is a
 * fact about how verbose it was.
 */
export function passSummary(passes: readonly TracePass[]): string {
  if (passes.length === 0) return "idle";
  const decisions = passes.filter((pass) => pass.header !== null).length;
  const steps = passes.reduce((n, pass) => n + pass.events.length + (pass.header ? 1 : 0), 0);
  const stepWord = `${steps} ${steps === 1 ? "step" : "steps"}`;
  if (decisions === 0) return stepWord;
  return `${decisions} ${decisions === 1 ? "decision" : "decisions"}, ${stepWord}`;
}
