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
 *
 * "Never" includes the tab nobody is looking at, which is where it used to stop:
 * the poll stops with the tab and what had been read stayed, so re-opening the
 * tab showed the old report as the current one. `showingReport` is that rule:
 * the read is dropped when nothing is showing it, which happens while the tab is
 * unmounted, so no frame a reader sees carries it. `shownRead` masks the read
 * for the render in which that is still on its way.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { PublishedErasureReport } from "@/src/server/coordinator/erasure-report";

const ERASURE_POLL_MS = 5000;
const READ_TIMEOUT_MS = 8000;
const STORE = "obsel.erasure.v1";

/** What one read produced, which is all the tab is ever allowed to show. */
export interface ErasureRead {
  report: PublishedErasureReport | null;
  /** Why the last read failed, or null. */
  error: string | null;
  /** True when obsel answered that it holds no such request. */
  missing: boolean;
  /** Whether a first read has come back, so the tab can tell empty from waiting. */
  everRead: boolean;
}

/** Nothing read. The state this hook starts in and returns to. */
export const NOT_READ: ErasureRead = {
  report: null,
  error: null,
  missing: false,
  everRead: false,
};

/**
 * What may be shown, given the last read and whether anything is showing it.
 *
 * The poll stops when nothing is showing the report, so what was read stops
 * being current the moment that happens, and how far out of date it is by the
 * time somebody looks again is arbitrary. Nothing on the tab carries a read
 * time, so a held report is indistinguishable from a fresh one; and key
 * compromise is the one way coverage is lost with nobody touching data, so a
 * report from before one was reported would read "attested absent" for assets
 * that are no longer covered.
 *
 * This masks the read; it does not drop it. On its own it did nothing at all,
 * because `active` is true again on the frame a re-opened tab renders and the
 * function is then the identity: the read a reader must not see is exactly the
 * read this returns. `showingReport` below is what drops it, and this stays as
 * the second check over the render in which that has not happened yet.
 */
export function shownRead(read: ErasureRead, active: boolean): ErasureRead {
  return active ? read : NOT_READ;
}

/*
 * The last read, held outside React beside the request it is of.
 *
 * Same reason the request is: there is one board, one watched request and one
 * last read of it, and a store is where the rule about dropping it can be
 * written as a function rather than as a lifecycle. The server never reads this
 * (`serverRead` answers there and returns the constant), so nothing here is
 * shared between two requests to the server.
 */
let held: ErasureRead = NOT_READ;
const readListeners = new Set<() => void>();

/** What the last read produced, which is all the hook ever returns. */
export function heldRead(): ErasureRead {
  return held;
}

/** The server has read nothing, and that is the honest snapshot there. */
function serverRead(): ErasureRead {
  return NOT_READ;
}

function subscribeRead(listener: () => void): () => void {
  readListeners.add(listener);
  return () => readListeners.delete(listener);
}

function publish(next: ErasureRead): void {
  if (held === next) return;
  held = next;
  for (const listener of readListeners) listener();
}

/** A read came back, or a reader named a different request and this is nothing. */
export function holdRead(read: ErasureRead): void {
  publish(read);
}

/**
 * @param active whether anything on screen is showing the report.
 *
 * Nothing showing it means nothing held. The poll stops at the same moment, so
 * anything kept past it is a report about an interval obsel did not watch, and
 * the interval a returning reader arrives after is arbitrarily long.
 *
 * This runs while the tab is unmounted, which is the whole point: by the time a
 * reader re-opens it there is nothing to render, rather than a report that a
 * fresh read replaces up to `READ_TIMEOUT_MS` later.
 */
export function showingReport(active: boolean): void {
  if (!active) publish(NOT_READ);
}

export interface ErasureState extends ErasureRead {
  /** The request id being watched, or nothing if a reader has not named one. */
  request: string | null;
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
  const state = useSyncExternalStore(subscribeRead, heldRead, serverRead);

  const watch = useCallback((next: string | null) => {
    const trimmed = next === null ? null : next.trim();
    // Clear what is on screen before the new read lands. The previous report is
    // about a different request, and leaving it up while this one is fetched
    // would attribute one subject's coverage to another.
    holdRead(NOT_READ);
    setWatching(trimmed === "" || trimmed === null ? null : trimmed);
  }, []);

  // Nothing showing the report means nothing held. Separate from the read effect
  // below, which does not run at all while `active` is false and so cannot be
  // where this is written.
  useEffect(() => {
    showingReport(active);
  }, [active]);

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
          holdRead({
            report: null,
            error: message,
            missing: response.status === 404,
            everRead: true,
          });
          return;
        }
        if (!isReport(body)) throw new Error("obsel sent a report this page could not read");
        if (cancelled) return;
        holdRead({ report: body, error: null, missing: false, everRead: true });
      } catch (cause) {
        if (cancelled) return;
        const message = cause instanceof Error ? cause.message : "unreadable report";
        holdRead({ report: null, error: message, missing: false, everRead: true });
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

  return { request, ...shownRead(state, active), watch };
}

/**
 * Shape-checked rather than trusted.
 *
 * A body that parsed but is not a report would otherwise reach the tab and throw
 * during render, and the tab is the one surface whose job is to report gaps
 * honestly. Failing to render is the worst way to fail at that.
 */
function isReport(body: unknown): body is PublishedErasureReport {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as Partial<PublishedErasureReport>;
  if (!Array.isArray(candidate.coverage)) return false;
  if (typeof candidate.summary !== "object" || candidate.summary === null) return false;
  if (typeof candidate.assurance !== "object" || candidate.assurance === null) return false;
  // The limits are required on the wire, so a body without them is not a report
  // this tab can honestly render: the counts would arrive with nothing stating
  // what they were measured over.
  if (!Array.isArray(candidate.assurance.limits)) return false;
  return candidate.coverage.every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof entry.asset === "string" &&
      typeof entry.state === "string" &&
      typeof entry.explanation === "string",
  );
}
