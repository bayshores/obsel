"use client";

/**
 * The demo runner's report: `GET /api/demo/activity`, polled.
 *
 * Second poll beside `use-swarm`, same discipline — skip a tick rather than
 * queue behind a slow answer, and never invent state on failure. The one
 * deliberate difference: a failed read here nulls the activity instead of
 * keeping the last one, because the guide treats a missing activity as
 * "unknown, proceed" while a *stale* activity would keep showing a step as
 * running after the server that spawned it restarted.
 */

import { useEffect, useState } from "react";

import type { DemoActivity } from "@/src/server/runner/types";

export const ACTIVITY_ENDPOINT = "/api/demo/activity";
export const ACTIVITY_POLL_MS = 2000;

/** Generous: a preflight probing a dead DataHub holds the answer for ~3 s. */
const READ_TIMEOUT_MS = 8000;

export interface ActivityState {
  activity: DemoActivity | null;
  /** Why the last read failed, or null. Shown quietly — this feed is auxiliary. */
  error: string | null;
}

export function useActivity(): ActivityState {
  const [state, setState] = useState<ActivityState>({ activity: null, error: null });

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    async function read(): Promise<void> {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch(ACTIVITY_ENDPOINT, {
          cache: "no-store",
          signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        });
        if (!response.ok) {
          throw new Error(`the demo runner answered ${response.status}`);
        }
        const body: unknown = await response.json();
        if (!isDemoActivity(body)) {
          throw new Error("the demo runner sent a reply this page could not read");
        }
        if (cancelled) return;
        setState({ activity: body, error: null });
      } catch (cause) {
        if (cancelled) return;
        const message = cause instanceof Error ? cause.message : "unreadable activity";
        setState({ activity: null, error: message });
      } finally {
        inFlight = false;
      }
    }

    void read();
    const timer = window.setInterval(() => void read(), ACTIVITY_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return state;
}

export function isDemoActivity(body: unknown): body is DemoActivity {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as Partial<DemoActivity>;
  if (!Array.isArray(candidate.log)) return false;
  const preflight = candidate.preflight;
  if (typeof preflight !== "object" || preflight === null) return false;
  for (const key of ["datahub", "vocabulary", "venv", "runner"] as const) {
    const check = preflight[key];
    if (typeof check !== "object" || check === null) return false;
    if (typeof check.ok !== "boolean") return false;
  }
  return candidate.running !== undefined && candidate.lastResult !== undefined;
}
