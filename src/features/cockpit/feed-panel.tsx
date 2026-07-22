"use client";

/**
 * What obsel's own reads observed changing, poll to poll.
 *
 * Titled "changes between reads" and not "log", "recorder", "activity" or
 * "events". Those words all imply a witness that saw things happen. This saw
 * two JSON bodies a second apart and subtracted them, and the title is the
 * first place a viewer forms a belief about what they are looking at.
 *
 * The disclosure under the rows is not boilerplate. `coordinateCompletion`
 * writes a task's completion BEFORE it writes any stale mark, so a diff can
 * truthfully observe "new output recorded" one poll and "three tasks stale" the
 * next — and a viewer reading the gap as an all-clear would be drawing exactly
 * the conclusion obsel exists to prevent.
 */

import { FEED_LIMIT } from "./feed";
import type { FeedEvent, FeedEventKind } from "./feed";
import { shortName } from "./graph/layout";
import { Panel } from "./mmux";
import { clockTime } from "./timing";
import { GREEN, MUTE, ROSE, STALE } from "./tone";

import styles from "./feed-panel.module.css";

/**
 * Each event's colour, from the same four the rest of the cockpit uses.
 *
 * Amber appears here for exactly one kind, matching `nodeTone`'s invariant: a
 * row is amber if and only if it is reporting work that went stale.
 */
const TONE: Record<FeedEventKind, string> = {
  appeared: MUTE,
  started: ROSE,
  finished: GREEN,
  "went-stale": STALE,
  cleared: GREEN,
  "output-changed": ROSE,
  left: MUTE,
};

/**
 * The sentence for each event.
 *
 * Every one of these states something that appeared or changed. None asserts an
 * absence — no row says nothing happened, nothing was marked, or anything is
 * clear. See the module note on why that is a rule rather than a style.
 */
function sentence(event: FeedEvent): string {
  switch (event.kind) {
    case "appeared":
      return `${event.taskName} appeared in the swarm`;
    case "started":
      return `${event.taskName} started running`;
    case "finished":
      return `${event.taskName} finished`;
    case "went-stale":
      // "out of date", matching the status word on the ledger row — the feed
      // and the board must not use two vocabularies for the same fact.
      return `${event.taskName} went out of date — its recorded reason is on its row`;
    case "cleared":
      return `${event.taskName} is no longer out of date — a fresh run earned its mark back`;
    case "output-changed":
      return `${event.taskName}'s recorded fingerprint for ${shortName(event.dataset ?? "")} differs from the last read`;
    case "left":
      return `${event.taskName} is no longer listed in the swarm`;
  }
}

export function Feed({ events, style }: { events: FeedEvent[]; style?: React.CSSProperties }) {
  return (
    <Panel
      title="changes between reads"
      meta={`${events.length}${events.length >= FEED_LIMIT ? ` of the last ${FEED_LIMIT}` : ""}`}
      padded={false}
      style={style}
      bodyStyle={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <ol className={styles.rows}>
        {events.length === 0 ? (
          <li className={styles.quiet}>
            Nothing has differed between two reads yet. The first read is the baseline and is not
            compared against anything.
          </li>
        ) : (
          events.map((event) => (
            <li key={event.id} className={styles.row} style={{ borderLeftColor: TONE[event.kind] }}>
              <span className={styles.clock}>{clockTime(event.observedAt)}</span>
              <span className={styles.text} style={{ color: TONE[event.kind] }}>
                {sentence(event)}
              </span>
              {event.mark !== null && (
                <span className={styles.because}>
                  {event.mark.hops} {event.mark.hops === 1 ? "hop" : "hops"} ·{" "}
                  {event.mark.changeKind} · caused by {shortName(event.mark.causedBy)}
                </span>
              )}
            </li>
          ))
        )}
      </ol>

      {/* Pinned, and short enough to fit the folded gutter without clipping —
          a disclosure that scrolls out of view is not a disclosure. */}
      <p className={styles.disclosure}>
        Two <code>/api/swarm</code> replies, subtracted. It did not watch obsel read the graph,
        compare fingerprints or confirm a write — none of that reaches the browser. Anything that
        changed and changed back inside one second is not here. Silence is not an all-clear.
      </p>
    </Panel>
  );
}
