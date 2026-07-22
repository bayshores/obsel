"use client";

/**
 * The cascade ledger — the panel that answers "why".
 *
 * Every stale row carries its whole mark at rest: the status word, how many
 * hops from the change, which part of the upstream output moved, when, and the
 * complete reason sentence. Nothing is behind a hover, a tooltip, or a
 * line-clamp. A viewer watching a compressed recording cannot hover, and a
 * truncated reason is a mark with no traceable cause — which CLAUDE.md rules
 * out as not actionable.
 */

import { shortName } from "./graph/layout";
import { Badge, PulseDot } from "./mmux";
import { activityNote, stampLabel } from "./progress";
import { clockTime } from "./timing";
import { STALE, STATUS_WORD, nodeTone } from "./tone";
import type { TaskRecord } from "@/src/server/coordinator/types";

import styles from "./ledger.module.css";

/**
 * What this row says about the task, in one sentence.
 *
 * The stale branch prints the reason the coordinator wrote, verbatim. It is not
 * rephrased here: the sentence stored on the mark is the same one written into
 * DataHub, and two wordings of the same fact invite the question of which is
 * authoritative.
 */
function note(task: TaskRecord): string {
  if (task.status === "stale" && task.stale !== null) {
    return `${task.name} ${task.stale.reason}.`;
  }
  if (task.status === "complete") {
    const wrote = task.writes[0];
    return wrote === undefined
      ? "finished · wrote nothing"
      : `wrote ${shortName(wrote)} · fingerprint recorded`;
  }
  if (task.status === "running") return "working · its outputs are not final yet";
  // Before a task has run, its row is where a newcomer learns what the agent
  // is for — the registered job description, when the agent declared one.
  const job = task.description ?? null;
  const waiting =
    task.reads.length === 0
      ? "waiting to start"
      : `waiting on ${task.reads.map(shortName).join(", ")}`;
  return job === null ? waiting : `${job} · ${waiting}`;
}

export function LedgerRow({
  task,
  snapshotAt = null,
  selected = false,
  onSelect,
}: {
  task: TaskRecord;
  /**
   * When the snapshot this row came from was taken, on obsel's clock.
   *
   * Passed in rather than read from `Date.now()` here. An in-flight elapsed is
   * this minus the task's `startedAt`, and both have to come off the same clock
   * for the difference to mean anything — the browser's would be a second one.
   */
  snapshotAt?: string | null;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const isStale = task.status === "stale";
  const tone = nodeTone(task.status, task.stale !== null);
  const mark = task.stale;
  const activity = activityNote(task, snapshotAt);

  return (
    <li
      className={[styles.row, isStale ? styles.rowStale : "", selected ? styles.rowSelected : ""]
        .filter(Boolean)
        .join(" ")}
      style={{ borderLeftColor: tone.fill }}
    >
      <div className={styles.head}>
        <PulseDot color={tone.fill} pulse={task.status === "running"} />
        <span className={styles.status} style={{ color: tone.fill }}>
          {STATUS_WORD[task.status]}
        </span>
        <span className={styles.name}>{task.name}</span>

        {mark !== null && (
          <span className={styles.hops}>
            {mark.hops} {mark.hops === 1 ? "hop" : "hops"}
          </span>
        )}
        {mark !== null && <Badge tone="neutral">{mark.changeKind}</Badge>}

        {/* A mark on a task that is not itself stale is the re-run case: the
            work is in flight but the mark has not been earned back yet. */}
        {mark !== null && !isStale && (
          <span className={styles.carried} style={{ color: STALE }}>
            mark still attached
          </span>
        )}

        {/* Labelled, because the graph's task box carries a timestamp too and
            for a stale task they are different instants: this one is when the
            mark was applied, that one is when the task last finished. A running
            task shows its start instead — see stampLabel. */}
        <span className={styles.clock}>{stampLabel(task, clockTime)}</span>

        {/*
          A real <button>, not a click handler on the <li>: reachable by
          keyboard, announced as a control, and impossible to trigger by
          selecting the row's text. It sits on the header LINE rather than in
          its own grid row — as a direct child of .row it claimed row 1 and
          pushed everything down, costing the graph 40px of height for a
          control that is not part of any demo beat.
        */}
        {onSelect !== undefined && (
          <button
            type="button"
            className={styles.select}
            aria-pressed={selected}
            onClick={onSelect}
          >
            {selected ? "hide raw" : "inspect"}
          </button>
        )}
      </div>

      <p className={isStale ? `${styles.reason} ${styles.reasonStale}` : styles.reason}>
        {note(task)}
      </p>

      {/* Only when something was actually measured. An agent that reported no
          detail leaves this out entirely rather than rendering an empty line —
          absence of a measurement is not a measurement. */}
      {activity !== null && <p className={styles.activity}>{activity}</p>}
    </li>
  );
}
