/**
 * The bounded buffer behind the coordinator's trace, with no ambient state.
 *
 * Separated from `trace.ts` for the same reason `staleness.ts` is separated from
 * `engine.ts`: that file is `server-only`, which cannot be imported under the
 * test runner, and the behaviour worth pinning down — ordering, bounding, that a
 * caller cannot corrupt the buffer, that emitting can never throw — lives here
 * where a test can reach it.
 */

import type { TraceEvent, TracePhase } from "./types";

export interface TraceBuffer {
  emit: (phase: TracePhase, message: string, outcome?: string | null) => void;
  /** Oldest first. A copy: a caller mutating it cannot corrupt the buffer. */
  read: () => TraceEvent[];
  clear: () => void;
}

/**
 * A buffer keeping the newest `limit` steps.
 *
 * `now` is injected so a test can pin the clock without touching global state.
 * The sequence counter deliberately survives `clear`: the dashboard tells new
 * steps from ones it has already rendered by `seq`, and restarting the count
 * after a reset would make a fresh step look like one already seen.
 */
export function createTraceBuffer(
  limit: number,
  now: () => string = () => new Date().toISOString(),
): TraceBuffer {
  let events: TraceEvent[] = [];
  let next = 1;

  return {
    emit(phase, message, outcome = null) {
      events.push({ seq: next++, at: now(), phase, message, outcome });
      if (events.length > limit) events = events.slice(events.length - limit);
    },
    read() {
      return [...events];
    },
    clear() {
      events = [];
    },
  };
}
