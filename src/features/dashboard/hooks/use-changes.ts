"use client";

/**
 * The board's change history, polled while the panel showing it is open.
 *
 * Follows `erasure/use-erasure.ts` in every respect but one, and the exception is
 * the point: **there is a list here, and there is no list there.** obsel cannot
 * enumerate erasure requests, so that tab takes an id a reader pastes in and says
 * so plainly. Change records are different — their URNs are derived from the flow
 * the server is already pointed at, counting up from one — so the server can
 * enumerate them without searching for anything, and this asks for all of them.
 *
 * A failed read withholds the history rather than keeping the last one on screen.
 * The rule the board keeps everywhere: an empty history and a read that broke look
 * identical to a reader, and one of them is a claim that nothing ever happened.
 *
 * Polls slowly, and only while something is showing it. History is append-only and
 * grows once per cascade, not once per second, so a one-second poll would be a
 * request per second for a list that changes a few times an hour.
 */

import { useEffect, useState } from "react";

import type { ChangeHistory } from "@/src/server/coordinator/change-ledger";

const POLL_MS = 5_000;
const READ_TIMEOUT_MS = 8_000;

export interface ChangesState {
  history: ChangeHistory | null;
  error: string | null;
  /** False until the first read has come back, so nothing claims an empty board early. */
  everRead: boolean;
}

function isHistory(value: unknown): value is ChangeHistory {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Partial<ChangeHistory>;
  return typeof body.flowId === "string" && Array.isArray(body.entries);
}

/**
 * @param active whether anything on screen is currently showing the history.
 */
export function useChanges(active: boolean): ChangesState {
  const [state, setState] = useState<ChangesState>({
    history: null,
    error: null,
    everRead: false,
  });

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let inFlight = false;

    async function read(): Promise<void> {
      // One read at a time. A DataHub slow enough to outrun the interval would
      // otherwise stack requests, each walking the whole history again.
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch("/api/changes", {
          cache: "no-store",
          signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const message =
            typeof body === "object" && body !== null && "error" in body
              ? String((body as { error: unknown }).error)
              : `obsel answered ${response.status}`;
          if (cancelled) return;
          setState({ history: null, error: message, everRead: true });
          return;
        }
        if (!isHistory(body)) throw new Error("obsel sent a history this page could not read");
        if (cancelled) return;
        setState({ history: body, error: null, everRead: true });
      } catch (cause) {
        if (cancelled) return;
        const message = cause instanceof Error ? cause.message : "unreadable history";
        setState({ history: null, error: message, everRead: true });
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
  }, [active]);

  return state;
}
