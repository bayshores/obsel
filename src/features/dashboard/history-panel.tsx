"use client";

/**
 * What obsel has decided about this board, kept after the fact.
 *
 * The activity feed beside it and this panel look similar and are not the same
 * thing, which is worth stating because two panels showing overlapping facts is
 * the failure this repository has a rule against. The feed is every step of the
 * pass happening now: process-local, gone on restart, and not evidence of
 * anything by its own declaration. This is the record of the decisions that
 * changed the board — cause, distance, what was flagged, what a redo closed —
 * written into DataHub as append-only documents and still here after a restart.
 *
 * So the feed answers "what is obsel doing", and this answers "what has obsel
 * decided here". A board that was changed and then repaired used to read exactly
 * like a board where nothing ever happened; this is where that history went.
 */

import { m, useReducedMotion } from "motion/react";

import { historyRows } from "./history";
import { EASE } from "./motion-tokens";
import { Panel } from "./mmux";
import { clockTime } from "./timing";
import { GREEN, MUTE, STALE } from "./tone";
import type { ChangeHistory } from "@/src/server/coordinator/change-ledger";

import styles from "./history-panel.module.css";

const ROW = {
  hidden: { opacity: 0, y: 5 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.22, ease: EASE } },
};

export function HistoryPanel({
  history,
  error,
  everRead,
  boardTrusted,
}: {
  history: ChangeHistory | null;
  error: string | null;
  /** False until the first read lands, so nothing claims an empty board early. */
  everRead: boolean;
  /**
   * Whether the swarm read behind the board is working.
   *
   * Same reason `TracePanel` takes it: this panel's own read failing says nothing
   * about the board, and both failing is one stopped server rather than two
   * separate faults.
   */
  boardTrusted: boolean;
}) {
  const still = useReducedMotion() === true;
  const rows = history === null ? [] : historyRows(history.entries);

  return (
    <Panel
      label="What obsel has decided"
      title="what obsel has decided"
      meta={metaOf(rows.length, error, everRead)}
      tour="history"
      bodyStyle={{ padding: 0, display: "flex", flexDirection: "column", minHeight: 0 }}
    >
      {error !== null ? (
        <p className={styles.quiet}>
          {/* Named, not swallowed. And scoped: the board is a separate read, so a
              failure here does not entitle this panel to speak for it. */}
          obsel&apos;s history could not be read. {error}
          {boardTrusted ? " The board beside it is still current." : ""}
        </p>
      ) : !everRead ? (
        <p className={styles.quiet}>Reading this board&apos;s history from DataHub.</p>
      ) : rows.length === 0 ? (
        <p className={styles.quiet}>
          {/* States the rule rather than apologising for the emptiness: a reader
              seeing this should know it will fill when something happens, and
              that a quiet re-run deliberately does not fill it. */}
          Nothing recorded yet. obsel writes one record here when a completion puts finished work
          out of date, or when a redo clears a flag. A re-run that changes nothing records nothing.
        </p>
      ) : (
        <ol className={styles.rows}>
          {rows.map((row) => (
            <m.li
              key={row.urn}
              className={styles.row}
              style={{ borderLeftColor: row.event === "cleared" ? GREEN : STALE }}
              {...(still ? {} : { variants: ROW, initial: "hidden", animate: "shown" })}
            >
              <div className={styles.head}>
                <span className={styles.headline}>{row.headline}</span>
                <span className={styles.clock} style={{ color: MUTE }}>
                  {clockTime(row.at)}
                </span>
              </div>

              {row.cause !== null && <span className={styles.cause}>{row.cause}</span>}
              {row.columns !== null && <span className={styles.columns}>{row.columns}</span>}

              {row.affected.length > 0 && (
                <span className={styles.list}>out of date: {row.affected.join(", ")}</span>
              )}
              {row.restored.length > 0 && (
                <span className={styles.list}>cleared: {row.restored.join(", ")}</span>
              )}

              {row.elapsedMs !== null && (
                // Measured by obsel, end to end, and labelled as a measurement
                // rather than printed as a bare number.
                <span className={styles.measured}>decided in {row.elapsedMs} ms</span>
              )}
            </m.li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

/**
 * The count, or nothing.
 *
 * Deliberately silent until a read has landed and while one has failed: a "0
 * records" beside an error would be obsel asserting an empty history it could not
 * read, which is the one thing every panel on this board refuses to do.
 */
function metaOf(count: number, error: string | null, everRead: boolean): string | undefined {
  if (error !== null || !everRead) return undefined;
  if (count === 0) return undefined;
  return `${count} ${count === 1 ? "record" : "records"}`;
}
