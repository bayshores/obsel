"use client";

/**
 * The cockpit's one source of truth: `GET /api/swarm`, polled.
 *
 * Polling rather than a websocket is deliberate — one endpoint, no connection
 * state to explain on camera, and a failure mode a viewer can understand. The
 * cost is that a mark can appear up to one poll late, which is why the timing
 * the cockpit reports is measured by the coordinator from its own timestamps
 * and never by this hook.
 */

import { useEffect, useState } from "react";

import type { SwarmSnapshot, TaskRecord } from "@/src/server/coordinator/types";

export const POLL_MS = 1000;
export const ENDPOINT = "/api/swarm";

/**
 * A read that has not answered by this point is treated as a failure.
 *
 * Without it, a coordinator that accepts the connection but never replies
 * leaves the cockpit showing its last snapshot forever, with no error and no
 * hint that the screen is out of date. A calm "everything they were built on is
 * still true" rendered from a minute-old read is the same wrong answer obsel
 * exists to prevent, so it has to be loud. Generous enough to clear a slow GMS,
 * which the server allows 20 s per call.
 */
export const READ_TIMEOUT_MS = 8000;

/** The body of `GET /api/swarm`. */
export interface SwarmResponse {
  snapshot: SwarmSnapshot;
  ready: TaskRecord[];
  blocked: { task: TaskRecord; waitingOn: string[] }[];
  /**
   * Base URL of DataHub's own UI, or null when the server has none configured.
   *
   * Optional as well as nullable so a response from a build that predates it
   * parses rather than failing the read. Null and absent both mean the same thing
   * to the cockpit: render no link.
   */
  datahubUrl?: string | null;
}

export interface SwarmState {
  data: SwarmResponse | null;
  error: string | null;
  /** ISO timestamp of the last successful read. */
  lastReadAt: string | null;
  /** Milliseconds the last successful read took, end to end from the browser. */
  roundTripMs: number | null;
  /** False until the first attempt settles, so "loading" is distinguishable. */
  everRead: boolean;
}

export function useSwarm(): SwarmState {
  const [state, setState] = useState<SwarmState>({
    data: null,
    error: null,
    lastReadAt: null,
    roundTripMs: null,
    everRead: false,
  });

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    async function read(): Promise<void> {
      // A slow answer must not stack up behind the interval; skipping a tick is
      // better than queueing requests the cockpit will only throw away.
      if (inFlight) return;
      inFlight = true;
      const startedAt = performance.now();
      try {
        const response = await fetch(ENDPOINT, {
          cache: "no-store",
          signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        });
        if (!response.ok) {
          throw new Error(`the coordinator answered ${response.status} ${response.statusText}`);
        }
        const body: unknown = await response.json();
        if (!isSwarmResponse(body)) {
          throw new Error("the coordinator sent a reply this cockpit could not read");
        }
        if (cancelled) return;
        const roundTripMs = Math.round(performance.now() - startedAt);
        setState({
          data: body,
          error: null,
          lastReadAt: new Date().toISOString(),
          roundTripMs,
          everRead: true,
        });
      } catch (cause) {
        if (cancelled) return;
        // The last good snapshot is kept on screen, but the banner above it
        // says so — see the alert row in cockpit.tsx.
        setState((prev) => ({ ...prev, error: explain(cause), everRead: true }));
      } finally {
        inFlight = false;
      }
    }

    void read();
    const timer = window.setInterval(() => void read(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return state;
}

export function explain(cause: unknown): string {
  // A failed fetch throws a TypeError with a message no viewer can act on.
  if (cause instanceof TypeError) {
    return `obsel could not reach the coordinator at ${ENDPOINT}. Is the server running?`;
  }
  // AbortSignal.timeout rejects with a TimeoutError DOMException. Named
  // explicitly because "the coordinator accepted the connection and then went
  // quiet" is a different problem from "nothing is listening", and the fix
  // differs: one is a hung read against DataHub, the other is a stopped server.
  if (cause instanceof DOMException && cause.name === "TimeoutError") {
    return `The coordinator did not answer within ${READ_TIMEOUT_MS / 1000} s. It may be stuck reading DataHub, so what is on screen is not current.`;
  }
  if (cause instanceof Error) return cause.message;
  return "obsel could not read the swarm, and the failure gave no reason.";
}

export function isSwarmResponse(body: unknown): body is SwarmResponse {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as Partial<SwarmResponse>;
  const snapshot = candidate.snapshot;
  if (typeof snapshot !== "object" || snapshot === null) return false;
  if (!Array.isArray((snapshot as SwarmSnapshot).tasks)) return false;
  return Array.isArray(candidate.ready) && Array.isArray(candidate.blocked);
}
