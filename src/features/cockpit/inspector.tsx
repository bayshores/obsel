"use client";

/**
 * The raw evidence behind one task, for someone who wants to check.
 *
 * Everything else in the cockpit is compressed to be readable at a glance and
 * on video: URNs become short names, 64-hex fingerprints become their first
 * eight characters. That compression is right for the graph and wrong for a
 * technical viewer asking "which entity exactly, and is that really a different
 * hash?". This panel is where the uncompressed values live.
 *
 * **Nothing any demo beat depends on.** It is opened by a click, and the demo
 * script never clicks. It is mounted only while a task is selected — the gutter
 * that holds it is fixed in height, so appearing costs the graph, the ledger and
 * the ribbon nothing; it borrows room from the trace beside it and gives it back
 * on close.
 *
 * It reports only fields present on the record. It never computes a freshness,
 * an age, or a "last seen": the cockpit knows when it read a value, not when
 * that value became true, and an inspector is exactly where that distinction
 * would be quietly lost.
 */

import { Panel } from "./mmux";
import { taskTitle } from "./naming";
import { activityNote } from "./progress";
import { clockTime } from "./timing";
import { STATUS_WORD } from "./tone";
import type { TaskRecord } from "@/src/server/coordinator/types";

import styles from "./inspector.module.css";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.field}>
      <dt className={styles.label}>{label}</dt>
      <dd className={styles.value}>{children}</dd>
    </div>
  );
}

export function Inspector({
  task,
  snapshotAt = null,
  readAt = null,
  roundTripMs = null,
  onClose,
  style,
}: {
  /** Never null: the cockpit mounts this only once something is selected. */
  task: TaskRecord;
  /** The snapshot's own clock, so an in-flight elapsed uses obsel's time. */
  snapshotAt?: string | null;
  /** When the last successful read was answered, already formatted. */
  readAt?: string | null;
  /** Measured round trip of that read, in milliseconds. */
  roundTripMs?: number | null;
  onClose: () => void;
  style?: React.CSSProperties;
}) {
  const run = activityNote(task, snapshotAt);

  return (
    <Panel
      title={`details · ${taskTitle(task)}`}
      meta="raw values, uncompressed"
      padded={false}
      style={style}
      bodyStyle={{ flex: 1, minHeight: 0, overflowY: "auto" }}
    >
      <div className={styles.body}>
        <div className={styles.head}>
          <span className={styles.name}>{taskTitle(task)}</span>
          <button type="button" className={styles.close} onClick={onClose}>
            close
          </button>
        </div>

        <dl className={styles.fields}>
          <Field label="status">{STATUS_WORD[task.status]}</Field>
          {/* Present only when the agent declared one at registration — the
              same text stored on the DataJob's description in DataHub. */}
          {task.description != null && <Field label="job">{task.description}</Field>}
          {/* The code identifier, labelled. The panel header shows the human
              name, so this is where the two are tied together. */}
          <Field label="name in DataHub">
            <code className={styles.urn}>{task.name}</code>
          </Field>
          <Field label="task urn">
            <code className={styles.urn}>{task.urn}</code>
          </Field>
          <Field label="last finished">
            {task.finishedAt === null ? "never" : clockTime(task.finishedAt)}
          </Field>

          <Field label="reads">
            {task.reads.length === 0 ? (
              "nothing"
            ) : (
              <ul className={styles.list}>
                {task.reads.map((urn) => (
                  <li key={urn}>
                    <code className={styles.urn}>{urn}</code>
                  </li>
                ))}
              </ul>
            )}
          </Field>

          <Field label="writes">
            {task.writes.length === 0 ? (
              "nothing"
            ) : (
              <ul className={styles.list}>
                {task.writes.map((urn) => (
                  <li key={urn}>
                    <code className={styles.urn}>{urn}</code>
                  </li>
                ))}
              </ul>
            )}
          </Field>

          {Object.keys(task.fingerprints)
            .sort()
            .map((dataset) => (
              <Field key={dataset} label={`fingerprint · ${dataset.split(",")[1] ?? dataset}`}>
                <div className={styles.print}>
                  <span className={styles.printLabel}>schema</span>
                  <code className={styles.hash}>{task.fingerprints[dataset].schema}</code>
                  <span className={styles.printLabel}>content</span>
                  <code className={styles.hash}>{task.fingerprints[dataset].content}</code>
                </div>
              </Field>
            ))}

          {/* What the last run reported about itself. This was a line on every
              ledger row; it belongs here, where there is room to label it as the
              agent's own account rather than obsel's measurement. */}
          {run !== null && <Field label="last run reported">{run}</Field>}

          {task.stale !== null && (
            <>
              <Field label="mark · caused by">
                <code className={styles.urn}>{task.stale.causedBy}</code>
              </Field>
              <Field label="mark · caused by task">
                <code className={styles.urn}>{task.stale.causedByTask ?? "not recorded"}</code>
              </Field>
              <Field label="mark · hops">{task.stale.hops}</Field>
              <Field label="mark · change kind">{task.stale.changeKind}</Field>
              {/* The diff the graph draws on the changed table, in full. Absent
                  on a content-only change and on marks written before obsel
                  recorded it, which is why it is conditional rather than
                  rendered as an empty pair of lists. */}
              {task.stale.columns != null && (
                <Field label="mark · columns">
                  {[
                    task.stale.columns.removed.length > 0
                      ? `left: ${task.stale.columns.removed.join(", ")}`
                      : null,
                    task.stale.columns.added.length > 0
                      ? `arrived: ${task.stale.columns.added.join(", ")}`
                      : null,
                  ]
                    .filter((part): part is string => part !== null)
                    .join(" · ")}
                </Field>
              )}
              <Field label="mark · since">{clockTime(task.stale.since)}</Field>
              <Field label="mark · detected in">
                {/* Null is a real state, not a missing value: the engine
                    writes the mark first and stamps the measurement in a
                    second write, so this is briefly absent by design. */}
                {task.stale.detectedMs === null ? "not measured" : `${task.stale.detectedMs} ms`}
              </Field>
              <Field label="mark · reason">{task.stale.reason}</Field>
            </>
          )}
        </dl>

        {/*
          Where these values came from, and when.

          The read latency and the answered-at clock used to sit in the cockpit's
          footer as "re-read every 1s · last read took 33 ms, answered 21:42:43".
          They are diagnostics about the read rather than news about the work, so
          they belong beside the sentence that already says these are polled
          values. Both are measured; neither is shown when the read failed.
        */}
        <p className={styles.note}>
          Read from <code>GET /api/swarm</code>
          {readAt === null ? "" : ` at ${readAt}`}
          {roundTripMs === null ? "" : `, round trip ${roundTripMs} ms`}. These are the values
          DataHub returned when the cockpit last polled, not a live read of the entity.
        </p>
      </div>
    </Panel>
  );
}
