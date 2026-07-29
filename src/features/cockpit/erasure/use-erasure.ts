"use client";

/**
 * One erasure request's coverage, read back from `GET /api/erasure/{id}`.
 *
 * **There is no list, and this hook does not pretend there is one.** The ledger
 * derives every URN it reads and never searches, because DataHub's search index
 * lags and a report that cannot see an attestation calls the asset unattested,
 * which is indistinguishable from a real finding. That rule means obsel cannot
 * enumerate the requests it holds, so the tab takes an id a reader pastes in and
 * says so plainly rather than showing an empty list that looks like an answer.
 *
 * Polled at five seconds rather than the board's one. Each read walks the
 * lineage graph from the request's seeds and then reads the ledger once per
 * reachable asset, which is a great deal more work than reading a swarm
 * snapshot, and coverage changes when somebody signs something rather than
 * continuously.
 *
 * A failed read reports the failure and withholds the report. It never keeps the
 * last one on screen: an asset that reads "attested absent" beside a broken
 * connection is exactly the false all-clear the whole erasure half exists to
 * prevent, and it is the same rule the swarm board keeps for its numbers.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import type { PublishedErasureReport } from "@/src/server/coordinator/erasure-report";

export const ERASURE_POLL_MS = 5000;
const READ_TIMEOUT_MS = 8000;
const STORE = "obsel.erasure.v1";

export interface ErasureState {
  /** The request id being watched, or nothing if a reader has not named one. */
  request: string | null;
  report: PublishedErasureReport | null;
  /** Why the last read failed, or null. */
  error: string | null;
  /** True when obsel answered that it holds no such request. */
  missing: boolean;
  /** Whether a first read has come back, so the tab can tell empty from waiting. */
  everRead: boolean;
  watch: (request: string | null) => void;
}

/*
 * Which request is being watched, held outside React.
 *
 * `localStorage` is an external store and `useSyncExternalStore` is the hook for
 * reading one: it takes a separate server snapshot, so the markup rendered on
 * the server and the markup hydrated against it agree by construction. Copying
 * the value into state from an effect instead would render the field empty for
 * one frame and then fill it, which for a text input a reader may already be
 * typing into is a real fault rather than a cosmetic one.
 */
let watching: string | null | undefined;
const listeners = new Set<() => void>();

function readStore(): string | null {
  try {
    const stored = window.localStorage.getItem(STORE);
    return stored === null || stored === "" ? null : stored;
  } catch {
    return null;
  }
}

function getSnapshot(): string | null {
  if (watching === undefined) watching = readStore();
  return watching;
}

/** The server has no store, and no request is the honest answer there. */
function getServerSnapshot(): string | null {
  return null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setWatching(next: string | null): void {
  if (getSnapshot() === next) return;
  watching = next;
  try {
    if (next === null) window.localStorage.removeItem(STORE);
    else window.localStorage.setItem(STORE, next);
  } catch {
    // A browser refusing storage is not a reason to refuse to read a report.
  }
  for (const listener of listeners) listener();
}

/**
 * @param active whether anything on screen is currently showing this report.
 *
 * The tab and the graph mode are the two things that can be, and when neither
 * is, the poll stops. A five-second graph walk running behind a tab nobody has
 * open is load obsel is putting on DataHub for no reader.
 */
export function useErasure(active: boolean): ErasureState {
  const request = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [state, setState] = useState<{
    report: PublishedErasureReport | null;
    error: string | null;
    missing: boolean;
    everRead: boolean;
  }>({ report: null, error: null, missing: false, everRead: false });

  const watch = useCallback((next: string | null) => {
    const trimmed = next === null ? null : next.trim();
    // Clear what is on screen before the new read lands. The previous report is
    // about a different request, and leaving it up while this one is fetched
    // would attribute one subject's coverage to another.
    setState({ report: null, error: null, missing: false, everRead: false });
    setWatching(trimmed === "" || trimmed === null ? null : trimmed);
  }, []);

  useEffect(() => {
    if (request === null || !active) return;
    let cancelled = false;
    let inFlight = false;

    async function read(): Promise<void> {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch(`/api/erasure/${encodeURIComponent(request!)}`, {
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
          // A 404 is not a fault. It means obsel holds no such request, which is
          // a real answer to the question the reader asked and reads differently
          // from a connection that broke.
          setState({
            report: null,
            error: message,
            missing: response.status === 404,
            everRead: true,
          });
          return;
        }
        if (!isReport(body)) throw new Error("obsel sent a report this page could not read");
        if (cancelled) return;
        setState({ report: body, error: null, missing: false, everRead: true });
      } catch (cause) {
        if (cancelled) return;
        const message = cause instanceof Error ? cause.message : "unreadable report";
        setState({ report: null, error: message, missing: false, everRead: true });
      } finally {
        inFlight = false;
      }
    }

    void read();
    const timer = window.setInterval(() => void read(), ERASURE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [request, active]);

  return { request, ...state, watch };
}

/**
 * Shape-checked rather than trusted.
 *
 * A body that parsed but is not a report would otherwise reach the tab and throw
 * during render, and the tab is the one surface whose job is to report gaps
 * honestly. Failing to render is the worst way to fail at that.
 */
export function isReport(body: unknown): body is PublishedErasureReport {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as Partial<PublishedErasureReport>;
  if (!Array.isArray(candidate.coverage)) return false;
  if (typeof candidate.summary !== "object" || candidate.summary === null) return false;
  if (typeof candidate.assurance !== "object" || candidate.assurance === null) return false;
  return candidate.coverage.every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof entry.asset === "string" &&
      typeof entry.state === "string" &&
      typeof entry.explanation === "string",
  );
}
