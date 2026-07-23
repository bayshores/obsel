"use client";

/**
 * What obsel just did, step by step, in its own words.
 *
 * This replaced a panel that diffed two `/api/swarm` replies and reported what
 * had changed between them. That panel was honest but thin: it could say three
 * tasks were suddenly stale, and it could not say *how* obsel knew, because
 * none of the deciding reached the browser. It could also only ever describe
 * results, so the quiet case — a re-run compared and found identical — looked
 * exactly like nothing having happened.
 *
 * These steps come from the coordinator itself, emitted as it reads DataHub,
 * compares a fingerprint, walks the lineage graph and writes each mark. Newest
 * last, so it reads top to bottom like the sequence it is.
 */

import { useEffect, useRef } from "react";

import { Panel } from "./mmux";
import { clockTime } from "./timing";
import { GREEN, MUTE, ROSE, STALE } from "./tone";
import type { TraceEvent, TracePhase } from "@/src/server/coordinator/types";

import styles from "./trace-panel.module.css";

/**
 * How close to the bottom still counts as "watching the newest step".
 *
 * Above this, the reader is taken to be reading back through earlier steps and
 * is left alone. One row is about 34px, so this is roughly a row and a half of
 * tolerance — enough that a partly-scrolled row does not read as deliberate
 * scrolling.
 */
const NEAR_BOTTOM_PX = 48;

/**
 * Each phase's colour, from the same four the rest of the cockpit uses.
 *
 * Amber appears for exactly one phase, holding the invariant the whole board
 * keeps: amber means work went out of date, and nothing else.
 */
const TONE: Record<TracePhase, string> = {
  read: MUTE,
  compare: ROSE,
  walk: ROSE,
  mark: STALE,
  write: MUTE,
  done: GREEN,
};

export function TracePanel({
  events,
  error,
  style,
}: {
  events: TraceEvent[];
  error: string | null;
  style?: React.CSSProperties;
}) {
  const list = useRef<HTMLOListElement>(null);
  /*
   * Whether the newest step should be scrolled into view.
   *
   * Updated from the scroll handler rather than measured when new steps arrive:
   * by then the list has already grown, and a list that just got taller is never
   * "near the bottom" any more, so measuring after the fact would read every
   * arriving step as the reader having scrolled away and would stop following
   * for good. The handler instead records the reader's actual intent at the
   * moment they act on it. Starts true, so the panel opens on the latest step.
   */
  const following = useRef(true);

  /*
   * Keep the newest step in view. Steps are appended at the bottom, and a
   * scroller does not follow its own growth: with 21 steps held, the panel
   * opened showing step 1 while the work being narrated was step 21 — the newest
   * step, which is the entire point, was the one guaranteed to be off screen.
   * (`overflow-anchor` does not solve this; it preserves position when content
   * is inserted ABOVE the anchor.)
   *
   * Deliberately has NO dependency array, so it re-pins after every commit
   * rather than only when a new step arrives. Two measured failures came from
   * keying it on the newest sequence number: on a fresh load the rows grew
   * ~370px taller when the web font swapped in AFTER the scroll, and a panel
   * resized by the stage above it grows without any step arriving. In both the
   * list ends up taller than the position it was pinned to, with nothing left to
   * trigger a correction. One scrollTop write per poll is not worth outsmarting.
   *
   * It cannot fight a reader: scrolling up sets `following` false in the handler
   * below, and scrolling back to the bottom resumes.
   */
  useEffect(() => {
    if (following.current && list.current !== null) {
      list.current.scrollTop = list.current.scrollHeight;
    }
  });

  return (
    <Panel
      title="what obsel is doing"
      meta={events.length === 0 ? "idle" : `${events.length} steps`}
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
      <ol
        className={styles.rows}
        ref={list}
        onScroll={(event) => {
          const el = event.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
        }}
      >
        {events.length === 0 ? (
          <li className={styles.quiet}>
            {error === null
              ? "obsel has done nothing yet. Every step it takes — reading DataHub, comparing a result against last time, following the chain, writing a mark — appears here as it happens."
              : `The step feed could not be read (${error}). The board above is unaffected.`}
          </li>
        ) : (
          // Newest last. The steps are a sequence obsel performed in order, and
          // reversing them to put the latest on top would read the cascade
          // backwards — marks before the comparison that caused them.
          events.map((event) => (
            <li
              key={event.seq}
              className={styles.row}
              style={{ borderLeftColor: TONE[event.phase] }}
            >
              <span className={styles.clock}>{clockTime(event.at)}</span>
              <span className={styles.text} style={{ color: TONE[event.phase] }}>
                {event.message}
              </span>
              {/* Only when there is one. An outcome slot rendered empty would
                  imply obsel had nothing to report from a step that did in fact
                  report something. */}
              {event.outcome !== null && <span className={styles.outcome}>{event.outcome}</span>}
            </li>
          ))
        )}
      </ol>

      {/*
        Two facts, tersely. This was a three-sentence footnote, which in a 220px
        gutter cost more height than the steps it was describing — its careful
        distinctions paid for by the thing they were about.

        The second clause moved here from under the ledger, where it sat as a
        standalone line saying the same thing about the same writes. This is
        where it belongs: the panel above is obsel writing to DataHub, and the
        reason that matters is that the marks are not private to this screen.
      */}
      <p className={styles.disclosure}>
        each step recorded after it happened · marks land in DataHub itself, so anything else
        reading the graph sees them
      </p>
    </Panel>
  );
}
