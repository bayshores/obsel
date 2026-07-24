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

import { datahubTaskUrl } from "./datahub-link";
import { Panel } from "./mmux";
import { datasetTitle, taskTitle } from "./naming";
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
  datahubUrl = null,
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
  /**
   * Base URL of DataHub's UI, or null when the server has none configured, in
   * which case no link is offered. A guessed default would render a link that
   * looks live and goes nowhere.
   */
  datahubUrl?: string | null;
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

          {/*
            What DataHub currently holds, not what obsel intended to write.

            This is the one thing obsel contributes to the catalog that a person
            browsing DataHub can see without knowing obsel exists, and until now the
            board could not report whether it was actually there. Read back off the
            entity, so an empty list is a real answer.

            It renders every tag rather than only obsel's, which is the point as much
            as the tag itself: a human-authored tag sitting beside `obsel-stale` is
            visible evidence that obsel's writes are additive and did not replace
            anyone's metadata.
          */}
          <Field label="tags in DataHub">
            {task.tags === undefined ? (
              // Absent, not empty. A snapshot captured before obsel read tags back
              // knows nothing about them, and saying "none" would claim DataHub
              // holds no tags when obsel simply never looked.
              "not recorded in this snapshot"
            ) : task.tags.length === 0 ? (
              "none"
            ) : (
              <ul className={styles.list}>
                {task.tags.map((tag) => (
                  <li key={tag}>
                    <code className={styles.urn}>{tag}</code>
                  </li>
                ))}
              </ul>
            )}
          </Field>

          {datahubUrl !== null && (
            <Field label="in DataHub's own UI">
              <a
                className={styles.link}
                href={datahubTaskUrl(datahubUrl, task.urn)}
                target="_blank"
                rel="noreferrer"
              >
                open this job in DataHub
              </a>
              {/*
                Said plainly rather than discovered by clicking. DataHub's UI
                requires the quickstart login, and its redirect discards the path
                it was asked for: observed 2026-07-23, a signed-out visit to
                `/tasks/<urn>` landed on `/` with the URN gone, so signing in
                afterwards lands on the home page rather than this job.
              */}
              <span className={styles.hint}>
                needs a DataHub login, and a signed-out visit loses the link
              </span>
            </Field>
          )}

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

/**
 * The same panel for a table, which is where a table stops being a box.
 *
 * A table has no record of its own to show: obsel deliberately stores nothing
 * on datasets, so everything here is derived from the tasks around it — who
 * writes it, who reads it, and what the writer's last run said came out. That
 * derivation is stated in the copy rather than hidden, because "as its writer
 * last reported it" is a genuinely different claim from "as it is on disk",
 * and this panel exists for the reader who cares about the difference.
 */
export function DataInspector({
  dataset,
  tasks,
  readAt = null,
  roundTripMs = null,
  onClose,
  style,
}: {
  /** Dataset URN. Never null: mounted only once a table is selected. */
  dataset: string;
  /** The whole snapshot, to derive the table's neighbourhood from. */
  tasks: TaskRecord[];
  readAt?: string | null;
  roundTripMs?: number | null;
  onClose: () => void;
  style?: React.CSSProperties;
}) {
  const producer = tasks.find((task) => task.writes.includes(dataset)) ?? null;
  const readers = tasks.filter((task) => task.reads.includes(dataset));
  const shape = producer?.run?.outputs[dataset] ?? null;
  const fingerprint = producer?.fingerprints[dataset] ?? null;

  return (
    <Panel
      title={`details · ${datasetTitle(dataset)}`}
      meta="a table, as last reported"
      padded={false}
      style={style}
      bodyStyle={{ flex: 1, minHeight: 0, overflowY: "auto" }}
    >
      <div className={styles.body}>
        <div className={styles.head}>
          <span className={styles.name}>{datasetTitle(dataset)}</span>
          <button type="button" className={styles.close} onClick={onClose}>
            close
          </button>
        </div>

        <dl className={styles.fields}>
          <Field label="table urn">
            <code className={styles.urn}>{dataset}</code>
          </Field>

          <Field label="written by">
            {/* A table nothing here writes is the swarm's starting point, and
                saying so matters: it is the one table whose changes no
                completion report will ever announce. */}
            {producer === null
              ? "no agent here writes it; it comes from outside the swarm"
              : taskTitle(producer)}
          </Field>

          <Field label="read by">
            {readers.length === 0 ? "no agent here reads it" : readers.map(taskTitle).join(", ")}
          </Field>

          {/* From the writer's last completion report, so absence is honest:
              a table whose writer has not finished has no reported shape. */}
          {shape !== null && (
            <>
              <Field label="columns">{shape.columns.join(", ")}</Field>
              <Field label="rows">{shape.rows}</Field>
              {shape.path !== undefined && (
                <Field label="file, as the writer reported it">
                  <code className={styles.urn}>{shape.path}</code>
                </Field>
              )}
            </>
          )}

          {fingerprint !== null && (
            <Field label="fingerprint">
              <div className={styles.print}>
                <span className={styles.printLabel}>schema</span>
                <code className={styles.hash}>{fingerprint.schema}</code>
                <span className={styles.printLabel}>content</span>
                <code className={styles.hash}>{fingerprint.content}</code>
              </div>
            </Field>
          )}

          {shape === null && fingerprint === null && (
            <Field label="contents">
              nothing reported yet; its writer has not finished, or nothing here writes it
            </Field>
          )}
        </dl>

        <p className={styles.note}>
          Derived from the agents around this table
          {readAt === null ? "" : `, read at ${readAt}`}
          {roundTripMs === null ? "" : `, round trip ${roundTripMs} ms`}. obsel stores nothing on
          the table itself, so everything above is what its writer last reported.
        </p>
      </div>
    </Panel>
  );
}
