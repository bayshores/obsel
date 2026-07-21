"use client";

/**
 * The board a judge watches while the demo runs.
 *
 * It polls `GET /api/swarm` once a second. Polling rather than a websocket is a
 * deliberate choice: one endpoint, no connection state to explain on camera, and
 * a failure mode a viewer can understand. The cost is that a flag can appear up
 * to one poll late, which is why the timing shown in the summary is measured by
 * the coordinator from its own timestamps rather than by this component.
 */

import { useEffect, useMemo, useState } from "react";

// Type-only import. These interfaces are the contract the coordinator and this
// board both build against, and `import type` is erased at compile time, so no
// server module reaches the browser bundle.
import type { StaleMark, SwarmSnapshot, TaskRecord } from "@/src/server/coordinator/types";

import { TaskRow } from "./task-row";
import styles from "./swarm-board.module.css";

const POLL_MS = 1000;
const ENDPOINT = "/api/swarm";

/**
 * A read that has not answered by this point is treated as a failure.
 *
 * Without it, a coordinator that accepts the connection but never replies leaves
 * the board showing its last snapshot forever, with no error and no hint that the
 * screen is out of date. A green "everything they were built on is still true"
 * rendered from a minute-old read is the same wrong answer obsel exists to
 * prevent, so it has to be loud. Generous enough to clear a slow GMS, which the
 * server allows 20 s per call.
 */
const READ_TIMEOUT_MS = 8000;

/** The body of `GET /api/swarm`. */
interface SwarmResponse {
  snapshot: SwarmSnapshot;
  ready: TaskRecord[];
  blocked: { task: TaskRecord; waitingOn: string[] }[];
}

export function SwarmBoard() {
  const [data, setData] = useState<SwarmResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastReadAt, setLastReadAt] = useState<string | null>(null);
  const [everRead, setEverRead] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    async function read() {
      // A slow answer must not stack up behind the interval; skipping a tick is
      // better than queueing requests the board will only throw away.
      if (inFlight) return;
      inFlight = true;
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
          throw new Error("the coordinator sent a reply this board could not read");
        }
        if (cancelled) return;
        setData(body);
        setLastReadAt(new Date().toISOString());
        setError(null);
      } catch (cause) {
        if (cancelled) return;
        setError(explain(cause));
      } finally {
        inFlight = false;
        if (!cancelled) setEverRead(true);
      }
    }

    void read();
    const timer = window.setInterval(() => void read(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const tasks = useMemo(() => inDependencyOrder(data?.snapshot.tasks ?? []), [data]);
  const timing = useMemo(() => detectionTiming(tasks), [tasks]);

  const waitingOnByUrn = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const entry of data?.blocked ?? []) map.set(entry.task.urn, entry.waitingOn);
    return map;
  }, [data]);

  const readyUrns = useMemo(() => new Set((data?.ready ?? []).map((task) => task.urn)), [data]);

  const staleCount = tasks.filter((task) => task.status === "stale").length;
  const finishedCount = tasks.filter(
    (task) => task.status === "complete" || task.status === "stale",
  ).length;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.wordmark}>obsel</h1>
        <p className={styles.tagline}>
          Finished agent work that a later upstream change invalidated.
        </p>
      </header>

      {error !== null && (
        <div className={styles.problem} role="alert">
          <p className={styles.problemHeadline}>{error}</p>
          <p className={styles.problemDetail}>
            {data === null
              ? "Nothing is being shown below because obsel has not read the swarm yet. This is a connection problem, not an empty swarm."
              : `Showing the last successful read${lastReadAt ? ` from ${clockTime(lastReadAt)}` : ""}. It may already be out of date.`}
          </p>
        </div>
      )}

      {/* Only ever summarise something obsel actually read. A calm "0 out of
          date" next to a connection failure would read as an all-clear. */}
      {data !== null && (
        <section className={styles.summary} aria-live="polite">
          <div className={styles.summaryCount}>
            <span className={staleCount > 0 ? styles.summaryNumberStale : styles.summaryNumberCalm}>
              {staleCount}
            </span>
            <span className={styles.summaryLabel}>
              {staleCount === 1 ? "task is out of date" : "tasks are out of date"}
            </span>
          </div>
          <p className={styles.summaryDetail}>
            {summaryLine(tasks.length, finishedCount, staleCount)}
          </p>
          <p className={styles.summaryTiming}>{timingLine(timing)}</p>
        </section>
      )}

      {!everRead && data === null && error === null ? (
        <p className={styles.notice}>Reading the swarm from DataHub.</p>
      ) : null}

      {data !== null && tasks.length === 0 ? (
        <p className={styles.notice}>
          No tasks registered yet. obsel is connected and the swarm is empty — nothing has been
          registered into DataHub.
        </p>
      ) : null}

      {tasks.length > 0 && (
        <ul className={styles.list}>
          {tasks.map((task) => (
            <TaskRow
              key={task.urn}
              task={task}
              waitingOn={waitingOnByUrn.get(task.urn) ?? []}
              ready={readyUrns.has(task.urn)}
            />
          ))}
        </ul>
      )}

      <footer className={styles.footer}>
        <span>
          Reading <code className={styles.code}>{ENDPOINT}</code> every {POLL_MS} ms
          {lastReadAt ? `, last answer at ${clockTime(lastReadAt)}` : ""}
        </span>
        <span>
          obsel does not judge whether work is good, only whether it is still built on something
          true.
        </span>
      </footer>
    </main>
  );
}

/**
 * Sort tasks so a reader can follow the pipeline top to bottom: a task appears
 * after whatever produces the data it reads.
 *
 * Layer by layer rather than a plain depth-first walk, so tasks at the same
 * distance from the source sit together, and alphabetically inside a layer so
 * the order does not jitter between polls. A cycle in the graph must not drop
 * tasks off the board, so anything left over is appended in a stable order.
 */
function inDependencyOrder(tasks: TaskRecord[]): TaskRecord[] {
  const producerOf = new Map<string, string>();
  for (const task of tasks) {
    for (const output of task.writes) producerOf.set(output, task.urn);
  }

  const dependencies = new Map<string, string[]>();
  for (const task of tasks) {
    const upstream = task.reads
      .map((input) => producerOf.get(input))
      .filter((urn): urn is string => urn !== undefined && urn !== task.urn);
    dependencies.set(task.urn, upstream);
  }

  const ordered: TaskRecord[] = [];
  const placed = new Set<string>();
  let remaining = [...tasks];

  while (remaining.length > 0) {
    const layer = remaining
      .filter((task) => (dependencies.get(task.urn) ?? []).every((urn) => placed.has(urn)))
      .sort(byName);

    if (layer.length === 0) {
      ordered.push(...[...remaining].sort(byName));
      break;
    }

    for (const task of layer) {
      ordered.push(task);
      placed.add(task.urn);
    }
    remaining = remaining.filter((task) => !placed.has(task.urn));
  }

  return ordered;
}

function byName(a: TaskRecord, b: TaskRecord): number {
  return a.name.localeCompare(b.name);
}

interface DetectionTiming {
  /** Coordinator-measured milliseconds: report received, to marks confirmed in DataHub. */
  ms: number;
  /** Name of the task whose output changed. */
  source: string;
  /** How many tasks that one change invalidated. */
  flagged: number;
}

/**
 * How long detection took, taken from the number the coordinator measured.
 *
 * `detectedMs` is recorded onto the mark itself and covers the whole job: the
 * completion report arriving, the graph being read, the decision, and every mark
 * written and confirmed in DataHub.
 *
 * An earlier version subtracted the changed task's `finishedAt` from `mark.since`.
 * That was wrong twice over. The two timestamps are stamped in different
 * processes, and `since` is captured before any write happens — so the figure
 * excluded the very writes the sentence claimed to be timing. It also went
 * negative as soon as the upstream task ran again, which deleted the number from
 * the screen during the demo's closing shot while three tasks sat there flagged.
 */
function detectionTiming(tasks: TaskRecord[]): DetectionTiming | null {
  const marks = tasks
    .filter((task) => task.status === "stale")
    .map((task) => task.stale)
    .filter((mark): mark is StaleMark => mark !== null);

  if (marks.length === 0) return null;

  const newest = marks.reduce((a, b) => (Date.parse(b.since) > Date.parse(a.since) ? b : a));
  const causeUrn = newest.causedByTask;
  if (causeUrn === null) return null;

  const cause = tasks.find((task) => task.urn === causeUrn);
  if (cause === undefined) return null;

  const fromSameChange = marks.filter((mark) => mark.causedByTask === causeUrn);
  const measured = fromSameChange
    .map((mark) => mark.detectedMs)
    .filter((ms): ms is number => typeof ms === "number" && Number.isFinite(ms) && ms >= 0);

  // A mark written before this was recorded has no measurement, and the board
  // says so rather than inventing one.
  if (measured.length === 0) return null;

  return { ms: Math.max(...measured), source: cause.name, flagged: fromSameChange.length };
}

function summaryLine(total: number, finished: number, stale: number): string {
  if (total === 0) return "No tasks registered yet.";
  if (finished === 0) {
    return `No task has finished yet, so there is nothing that could be out of date. ${total} registered.`;
  }
  if (stale === 0) {
    return `${finished} of ${total} ${total === 1 ? "task has" : "tasks have"} finished, and everything they were built on is still true.`;
  }
  return `${stale} of ${finished} finished ${finished === 1 ? "task is" : "tasks are"} built on something that has since changed.`;
}

function timingLine(timing: DetectionTiming | null): string {
  if (timing === null) return "No detection time to report yet.";
  const flags = timing.flagged === 1 ? "flag" : "flags";
  return `${timing.flagged} ${flags} written and confirmed in DataHub ${timing.ms} ms after ${timing.source} reported finishing.`;
}

function clockTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleTimeString();
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
  return "obsel could not read the swarm, and the failure gave no reason.";
}

function isSwarmResponse(body: unknown): body is SwarmResponse {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as Partial<SwarmResponse>;
  const snapshot = candidate.snapshot;
  if (typeof snapshot !== "object" || snapshot === null) return false;
  if (!Array.isArray((snapshot as SwarmSnapshot).tasks)) return false;
  return Array.isArray(candidate.ready) && Array.isArray(candidate.blocked);
}
