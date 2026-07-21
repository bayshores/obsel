"use client";

/**
 * One agent task on the board.
 *
 * Every state is spelled out in words as well as colour. A judge may be watching
 * a compressed recording, colourblind, or both, and the difference between "done"
 * and "out of date" is the entire point of the demo.
 */

import type { TaskRecord } from "@/src/server/coordinator/types";

import styles from "./swarm-board.module.css";

const STATE_LABEL: Record<TaskRecord["status"], string> = {
  registered: "waiting",
  running: "running",
  complete: "done",
  stale: "out of date",
};

const STATE_CLASS: Record<TaskRecord["status"], string> = {
  registered: styles.stateWaiting,
  running: styles.stateRunning,
  complete: styles.stateDone,
  stale: styles.stateStale,
};

interface TaskRowProps {
  task: TaskRecord;
  /** Names of the tasks this one is waiting on, from `GET /api/swarm`. */
  waitingOn: string[];
  /** True when the coordinator lists this task as free to start. */
  ready: boolean;
}

export function TaskRow({ task, waitingOn, ready }: TaskRowProps) {
  const mark = task.status === "stale" ? task.stale : null;

  return (
    <li className={`${styles.row} ${task.status === "stale" ? styles.rowStale : ""}`.trim()}>
      <div className={styles.stateCell}>
        <span className={`${styles.state} ${STATE_CLASS[task.status]}`}>
          {STATE_LABEL[task.status]}
        </span>
      </div>

      <div className={styles.bodyCell}>
        <div className={styles.titleLine}>
          <h2 className={styles.taskName}>{task.name}</h2>
          {mark !== null && (
            <span className={styles.hops}>
              {mark.hops === 1 ? "hit directly" : `${mark.hops} steps from the change`}
            </span>
          )}
          {task.finishedAt !== null && (
            <span className={styles.finishedAt}>finished {clockTime(task.finishedAt)}</span>
          )}
        </div>

        {mark !== null && (
          <p className={styles.reason}>
            {task.name} {mark.reason}.
          </p>
        )}

        {task.status === "registered" && (
          <p className={styles.note}>
            {waitingOn.length > 0
              ? `Waiting on ${joinNames(waitingOn)}.`
              : ready
                ? "Ready to start; nothing it reads is still being written."
                : "Registered, not started."}
          </p>
        )}

        {task.status === "running" && (
          <p className={styles.note}>Working. Its outputs are not final yet.</p>
        )}

        <dl className={styles.io}>
          <div className={styles.ioGroup}>
            <dt className={styles.ioLabel}>reads</dt>
            <dd className={styles.ioValue}>{renderDatasets(task.reads)}</dd>
          </div>
          <div className={styles.ioGroup}>
            <dt className={styles.ioLabel}>writes</dt>
            <dd className={styles.ioValue}>{renderDatasets(task.writes)}</dd>
          </div>
        </dl>
      </div>
    </li>
  );
}

function renderDatasets(urns: string[]) {
  if (urns.length === 0) return <span className={styles.ioEmpty}>nothing</span>;
  return urns.map((urn) => (
    <span key={urn} className={styles.dataset} title={urn}>
      {shortName(urn)}
    </span>
  ));
}

/**
 * Last dotted segment of a dataset URN.
 *
 * Deliberately a copy of the helper in the staleness engine rather than an
 * import: that module is server code, and the board must not pull server modules
 * into the browser bundle for four lines of string handling.
 */
function shortName(datasetUrn: string): string {
  const parts = datasetUrn.split(",");
  const path = parts.length > 1 ? parts[1] : datasetUrn;
  const segments = path.split(".");
  return segments[segments.length - 1];
}

function joinNames(names: string[]): string {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function clockTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleTimeString();
}
