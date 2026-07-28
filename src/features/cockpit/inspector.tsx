"use client";

/**
 * What obsel holds about one node, at two depths.
 *
 * Everything else in the cockpit is compressed to be readable at a glance and
 * on video: URNs become short names, 64-hex fingerprints become their first
 * eight characters. That compression is right for the graph and wrong for a
 * technical viewer asking "which entity exactly, and is that really a different
 * hash?". This panel is where the uncompressed values live.
 *
 * `preview` is the shallow depth, shown while a reader is only pointing at a
 * node. It carries what the board cannot fit and a person would ask first, in
 * human names with no URNs and no hashes at all. Pinning gives the full record.
 * The two are one component rather than two so that a field added to the record
 * cannot go missing from the panel a reader actually opens.
 *
 * Neither depth computes a freshness, an age, or a "last seen": the cockpit
 * knows when it read a value, not when that value became true, and an inspector
 * is exactly where that distinction would be quietly lost.
 */

import { datahubTaskUrl } from "./datahub-link";
import { Divider, Panel } from "./mmux";
import { datasetTitle, flowLine, taskTitle } from "./naming";
import { activityNote, runStamp } from "./progress";
import { Schematic } from "./schematic";
import { clockTime } from "./timing";
import { STATUS_WORD } from "./tone";
import type { ColumnChange, TaskRecord } from "@/src/server/coordinator/types";

import styles from "./inspector.module.css";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.field}>
      <dt className={styles.label}>{label}</dt>
      <dd className={styles.value}>{children}</dd>
    </div>
  );
}

/**
 * The header, identical for both kinds.
 *
 * One name, once. The panel previously stated it three times — as the section
 * title, again in a meta line describing the kind, and again here — which is
 * what the surrounding rewrite exists to stop. `kind` is one word and is not the
 * name in another form: a preview of a node the reader has not clicked needs to
 * say which of the two kinds of box it is describing.
 */
function Head({
  name,
  kind,
  pinned,
  onClose,
}: {
  name: string;
  kind: "agent" | "table";
  pinned: boolean;
  onClose: () => void;
}) {
  return (
    <div className={styles.head}>
      <h2 className={styles.name}>{name}</h2>
      <span className={styles.kind}>{kind}</span>
      {pinned ? (
        <button type="button" className={styles.close} onClick={onClose}>
          close
        </button>
      ) : (
        <span className={styles.pinHint}>click to pin</span>
      )}
    </div>
  );
}

/** A dataset with its human name above its exact identifier, stated once. */
function DatasetRow({ urn }: { urn: string }) {
  return (
    <li className={styles.datasetRow}>
      <span className={styles.datasetName}>{datasetTitle(urn)}</span>
      <code className={styles.urn}>{urn}</code>
    </li>
  );
}

/** The column diff a mark recorded, in words. Null when it recorded none. */
function columnWords(columns: ColumnChange | null | undefined): string | null {
  if (columns == null) return null;
  const parts = [
    columns.removed.length > 0 ? `left: ${columns.removed.join(", ")}` : null,
    columns.added.length > 0 ? `arrived: ${columns.added.join(", ")}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

export function Inspector({
  task,
  snapshotAt = null,
  readAt = null,
  roundTripMs = null,
  datahubUrl = null,
  preview = false,
  onClose,
}: {
  /** Never null: the surface mounts this only once something is hovered or pinned. */
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
  /** Shallow depth: human names, no identifiers, no hashes. */
  preview?: boolean;
  onClose: () => void;
}) {
  const run = activityNote(task, snapshotAt);

  return (
    <>
      <Head name={taskTitle(task)} kind="agent" pinned={!preview} onClose={onClose} />

      <dl className={styles.fields}>
        <Field label="status">
          {STATUS_WORD[task.status]}
          {task.stale === null
            ? ""
            : ` · ${task.stale.hops} ${task.stale.hops === 1 ? "hop" : "hops"} from the change`}
        </Field>

        {/* Present only when the agent declared one at registration — the
            same text stored on the DataJob's description in DataHub. */}
        {task.description != null && <Field label="job">{task.description}</Field>}

        {/* The same sentence the ledger row uses, so a reader who saw it there
            is not asked to learn a second phrasing of the same fact. */}
        {preview && <Field label="reads and writes">{flowLine(task)}</Field>}

        {/* What the last run reported about itself. This was a line on every
            ledger row; it belongs here, where there is room to label it as the
            agent's own account rather than obsel's measurement. */}
        {run !== null && <Field label="last run reported">{run}</Field>}

        {/*
          The mark, in full and near the top.

          It was last in the field list, below eleven rows of identifiers and
          hashes, which put the one thing a reader opens this panel to read
          furthest from where they started reading.
        */}
        {task.stale !== null && (
          <>
            <Field label="mark · reason">{task.stale.reason}</Field>
            {!preview && (
              <>
                <Field label="mark · caused by">
                  <span className={styles.datasetName}>{datasetTitle(task.stale.causedBy)}</span>
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
                {columnWords(task.stale.columns) !== null && (
                  <Field label="mark · columns">{columnWords(task.stale.columns)}</Field>
                )}
                <Field label="mark · since">{clockTime(task.stale.since)}</Field>
                <Field label="mark · detected in">
                  {/* Null is a real state, not a missing value: the engine
                      writes the mark first and stamps the measurement in a
                      second write, so this is briefly absent by design. */}
                  {task.stale.detectedMs === null ? "not measured" : `${task.stale.detectedMs} ms`}
                </Field>
              </>
            )}
          </>
        )}

        {!preview && (
          <Field label="last finished">
            {task.finishedAt === null ? "never" : clockTime(task.finishedAt)}
          </Field>
        )}
      </dl>

      {!preview && (
        <>
          <div className={styles.divider}>
            <Divider label="the raw record" />
          </div>

          <dl className={styles.fields}>
            <Field label="reads">
              {task.reads.length === 0 ? (
                "nothing"
              ) : (
                <ul className={styles.list}>
                  {task.reads.map((urn) => (
                    <DatasetRow key={urn} urn={urn} />
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
                    <DatasetRow key={urn} urn={urn} />
                  ))}
                </ul>
              )}
            </Field>

            {/* The code identifier, labelled. The header shows the human name,
                so this is where the two are tied together. */}
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

            {Object.keys(task.fingerprints)
              .sort()
              .map((dataset) => (
                <Field key={dataset} label={`fingerprint · ${datasetTitle(dataset)}`}>
                  <div className={styles.print}>
                    <span className={styles.printLabel}>schema</span>
                    <code className={styles.hash}>{task.fingerprints[dataset].schema}</code>
                    <span className={styles.printLabel}>content</span>
                    <code className={styles.hash}>{task.fingerprints[dataset].content}</code>
                  </div>
                </Field>
              ))}

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
        </>
      )}
    </>
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
  coverageState = null,
  preview = false,
  onClose,
}: {
  /** Dataset URN. Never null: mounted only once a table is hovered or pinned. */
  dataset: string;
  /** The whole snapshot, to derive the table's neighbourhood from. */
  tasks: TaskRecord[];
  readAt?: string | null;
  roundTripMs?: number | null;
  /**
   * What the erasure report says about this table, when one has been read and
   * the board is showing it. Null covers both "not asked" and "asked, and this
   * table was not reached", which the field distinguishes in words.
   */
  coverageState?: string | null;
  preview?: boolean;
  onClose: () => void;
}) {
  const producer = tasks.find((task) => task.writes.includes(dataset)) ?? null;
  const readers = tasks.filter((task) => task.reads.includes(dataset));
  const shape = producer?.run?.outputs[dataset] ?? null;
  const fingerprint = producer?.fingerprints[dataset] ?? null;
  const previous = producer?.previousFingerprints?.[dataset] ?? null;

  /*
   * The change that a mark says started here, if one did.
   *
   * Read off the marks rather than derived by comparing fingerprints: a
   * fingerprint is a hash and cannot name a column, so the diff exists only
   * because the engine recorded it when it decided the mark.
   */
  const originMark = tasks
    .map((task) => task.stale)
    .find((m) => m != null && m.causedBy === dataset);
  const change = originMark?.columns ?? null;
  const stamp = producer?.run == null ? null : runStamp(producer.run);

  return (
    <>
      <Head name={datasetTitle(dataset)} kind="table" pinned={!preview} onClose={onClose} />

      <dl className={styles.fields}>
        <Field label="written by">
          {/* A table nothing here writes is the swarm's starting point, and
              saying so matters: it is the one table whose changes no
              completion report will ever announce. */}
          {producer === null
            ? "no agent here writes it; it comes from outside the swarm"
            : `${taskTitle(producer)}${stamp === null ? "" : ` · ${stamp}`}`}
        </Field>

        <Field label="read by">
          {readers.length === 0 ? "no agent here reads it" : readers.map(taskTitle).join(", ")}
        </Field>

        {/* From the writer's last completion report, so absence is honest:
            a table whose writer has not finished has no reported shape. */}
        {shape !== null && (
          <div className={styles.field}>
            <dt className={styles.label}>shape</dt>
            <dd className={styles.value}>
              <Schematic
                shape={shape}
                change={change ?? null}
                changeKey={`${dataset}|${fingerprint?.content ?? "none"}`}
              />
            </dd>
          </div>
        )}

        {originMark != null && (
          <>
            <Field label="last change">
              {originMark.changeKind}
              {columnWords(originMark.columns) === null
                ? ""
                : ` · ${columnWords(originMark.columns)}`}
            </Field>
            <Field label="changed at">{clockTime(originMark.since)}</Field>
          </>
        )}

        {shape === null && fingerprint === null && (
          <Field label="contents">
            nothing reported yet; its writer has not finished, or nothing here writes it
          </Field>
        )}

        {coverageState !== null && <Field label="erasure report says">{coverageState}</Field>}
      </dl>

      {!preview && (
        <>
          <div className={styles.divider}>
            <Divider label="the raw record" />
          </div>

          <dl className={styles.fields}>
            <Field label="table urn">
              <code className={styles.urn}>{dataset}</code>
            </Field>

            {shape?.path !== undefined && (
              <Field label="file, as the writer reported it">
                <code className={styles.urn}>{shape.path}</code>
              </Field>
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

            {/* The one version back obsel keeps, which is what the current
                fingerprint was compared against when the mark was decided. */}
            {previous !== null && (
              <Field label="previous fingerprint">
                <div className={styles.print}>
                  <span className={styles.printLabel}>schema</span>
                  <code className={styles.hash}>{previous.schema}</code>
                  <span className={styles.printLabel}>content</span>
                  <code className={styles.hash}>{previous.content}</code>
                </div>
              </Field>
            )}
          </dl>

          <p className={styles.note}>
            Derived from the agents around this table
            {readAt === null ? "" : `, read at ${readAt}`}
            {roundTripMs === null ? "" : `, round trip ${roundTripMs} ms`}. obsel stores nothing on
            the table itself, so everything above is what its writer last reported.
          </p>
        </>
      )}
    </>
  );
}

/** The surface both panels are mounted inside, so the shell is written once. */
export function DetailsPanel({
  children,
  pinned,
  style,
}: {
  children: React.ReactNode;
  pinned: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <Panel label="Details" padded={false} style={style} bodyStyle={{ flex: 1, minHeight: 0 }}>
      <div className={pinned ? styles.bodyPinned : styles.body}>{children}</div>
    </Panel>
  );
}
