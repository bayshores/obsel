"use client";

/**
 * The dashboard's one source of truth: `GET /api/swarm`, polled.
 *
 * Polling rather than a websocket is deliberate — one endpoint, no connection
 * state to explain on camera, and a failure mode a viewer can understand. The
 * cost is that a mark can appear up to one poll late, which is why the timing
 * the dashboard reports is measured by the coordinator from its own timestamps
 * and never by this hook.
 */

import { useEffect, useState } from "react";

import type { RerunPlan } from "@/src/server/coordinator/rerun";
import type { SwarmSnapshot, TaskRecord } from "@/src/server/coordinator/types";

const POLL_MS = 1000;
const ENDPOINT = "/api/swarm";

/**
 * A read that has not answered by this point is treated as a failure.
 *
 * Without it, a coordinator that accepts the connection but never replies
 * leaves the dashboard showing its last snapshot forever, with no error and no
 * hint that the screen is out of date. A calm "everything they were built on is
 * still true" rendered from a minute-old read is the same wrong answer obsel
 * exists to prevent, so it has to be loud. Generous enough to clear a slow GMS,
 * which the server allows 20 s per call.
 */
const READ_TIMEOUT_MS = 8000;

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
   * to the dashboard: render no link.
   */
  datahubUrl?: string | null;
  /**
   * What to redo and in what order, when anything is flagged.
   *
   * Optional for the same reason as `datahubUrl`: a recorded response from a
   * build that predates it must still parse. Nothing on the board renders it
   * today — the graph already orders the tasks it draws, and a second ordering
   * beside it would state the same fact twice. It is here because
   * `GET /api/swarm` is what an agent or an operator's script reads.
   */
  rerun?: RerunPlan;
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
      // better than queueing requests the dashboard will only throw away.
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
          throw new Error("the coordinator sent a reply this page could not read");
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
        // says so — see the alert row in dashboard.tsx.
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

function explain(cause: unknown): string {
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
  return "obsel could not read the agents, and the failure gave no reason.";
}

/**
 * Shape-checked rather than trusted, entry by entry.
 *
 * An array of tasks was once the whole check, and a record missing `reads` and
 * `writes` — what a server or proxy that does not match this build answers with
 * — passed it, reached `inDependencyOrder`, and threw during render. The board
 * then goes blank: no snapshot, no error row, nothing saying obsel read
 * anything at all. A body this page cannot render honestly has to read as a
 * failed read, which is the state the banner and the guide already describe.
 *
 * `stale` is required for the same reason rather than for tidiness: `totals`
 * counts a task as flagged on `stale !== null`, which holds for a field that is
 * absent, so a partial record would be counted as marked work.
 */
export function isSwarmResponse(body: unknown): body is SwarmResponse {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as Partial<SwarmResponse>;
  const snapshot = candidate.snapshot;
  if (typeof snapshot !== "object" || snapshot === null) return false;
  const tasks = (snapshot as SwarmSnapshot).tasks;
  if (!Array.isArray(tasks)) return false;
  if (!tasks.every(isTaskRecord)) return false;
  return Array.isArray(candidate.ready) && Array.isArray(candidate.blocked);
}

/**
 * Every field a `TaskRecord` is required to carry.
 *
 * The nullable ones are checked for presence rather than for type, because
 * absent and null differ here: an absent key is a record from something that is
 * not this build, and the board reads each of them without asking.
 */
function isTaskRecord(task: unknown): task is TaskRecord {
  if (typeof task !== "object" || task === null) return false;
  const candidate = task as Partial<TaskRecord>;
  if (typeof candidate.urn !== "string") return false;
  if (typeof candidate.name !== "string") return false;
  if (typeof candidate.status !== "string") return false;
  if (!Array.isArray(candidate.reads) || !Array.isArray(candidate.writes)) return false;
  if (typeof candidate.fingerprints !== "object" || candidate.fingerprints === null) return false;
  return ["finishedAt", "startedAt", "run", "stale"].every((field) => field in candidate);
}
