"use client";

/**
 * The coordinator's own account of what it just did: `GET /api/trace`, polled.
 *
 * Polled at the swarm's rate rather than the activity feed's, because these
 * steps arrive in a burst — a whole cascade is emitted inside one agent's
 * completion request — and at two seconds the sequence a viewer is meant to
 * read as it happens would land in one lump instead.
 *
 * A failed read empties the panel rather than freezing it, the same call the
 * activity hook makes: this endpoint reads an in-memory buffer and does not
 * touch DataHub, so it failing means the server is gone, not that it is slow.
 * Holding old steps on screen then would be narrating a process that is no
 * longer running.
 */

import { useEffect, useState } from "react";

import type { TraceEvent } from "@/src/server/coordinator/types";

export const TRACE_ENDPOINT = "/api/trace";
export const TRACE_POLL_MS = 1000;

const READ_TIMEOUT_MS = 5000;

export interface TraceState {
  events: TraceEvent[];
  /** Why the last read failed, or null. Shown quietly — this feed is auxiliary. */
  error: string | null;
}

export function useTrace(): TraceState {
  const [state, setState] = useState<TraceState>({ events: [], error: null });

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    async function read(): Promise<void> {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch(TRACE_ENDPOINT, {
          cache: "no-store",
          signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`the coordinator answered ${response.status}`);
        const body: unknown = await response.json();
        if (!isTraceBody(body)) {
          throw new Error("the coordinator sent a trace this cockpit could not read");
        }
        if (cancelled) return;
        setState({ events: body.events, error: null });
      } catch (cause) {
        if (cancelled) return;
        const message = cause instanceof Error ? cause.message : "unreadable trace";
        setState({ events: [], error: message });
      } finally {
        inFlight = false;
      }
    }

    void read();
    const timer = window.setInterval(() => void read(), TRACE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return state;
}

export function isTraceBody(body: unknown): body is { events: TraceEvent[] } {
  if (typeof body !== "object" || body === null) return false;
  const events = (body as { events?: unknown }).events;
  if (!Array.isArray(events)) return false;
  // Shape-checked rather than trusted: a body that parsed but is not this would
  // otherwise reach the panel and throw during render.
  return events.every(
    (event) =>
      typeof event === "object" &&
      event !== null &&
      typeof (event as TraceEvent).seq === "number" &&
      typeof (event as TraceEvent).message === "string",
  );
}
