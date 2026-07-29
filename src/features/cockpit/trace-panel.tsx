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

/*
 * `m` with no `LazyMotion` of its own: this panel is rendered inside the dock,
 * which provides one with `domMax`. A second root nested in the first would load
 * a second feature bundle to animate the same elements.
 */
import { m, useReducedMotion } from "motion/react";
import { Fragment, useEffect, useRef, useState } from "react";

import { EASE } from "./motion-tokens";
import { Panel } from "./mmux";
import { passSummary, passesOf } from "./passes";
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

/*
 * There is no cap on how many steps are rendered, and there used to be.
 *
 * `SHOWN = 8` sliced the list to the most recent eight, which was defensible when
 * this panel was 220px tall and indefensible once it grew. Measured on the live
 * board at 1920 x 990: the scroller was 307px, a row was 45px, eight rows were in
 * the DOM and **six** were fully visible, with the top one cut off entirely and a
 * third of the second gone. Meanwhile the header read `last 8 of 25`, so it named
 * 17 steps that were not in the DOM at all: scrolling up reached the top of the
 * eight and stopped, and the promise had no way to be kept.
 *
 * Rendering everything makes the scroller mean what it looks like. The buffer is
 * bounded at 200 by `trace-buffer.ts`, so this is bounded too, and 200 list items
 * is nothing. The word-count guard in `e2e/cockpit.spec.ts` counts the log's
 * VISIBLE rows for the same reason it excludes the screen-reader region: text
 * behind a scroller is not visual density.
 */

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

/** A step arriving. Short, because several can land in one poll. */
const STEP = {
  hidden: { opacity: 0, y: 5 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.22, ease: EASE } },
};

export function TracePanel({
  events,
  error,
  boardTrusted,
  style,
}: {
  events: TraceEvent[];
  error: string | null;
  /**
   * Whether the swarm read behind the board is currently working.
   *
   * Same reason as `GuidePanel`'s: this panel's own read failing says nothing
   * about the board, and saying so is useful. Both failing is one stopped server,
   * and "the board is unaffected" is then false.
   */
  boardTrusted: boolean;
  style?: React.CSSProperties;
}) {
  const passes = passesOf(events);
  const list = useRef<HTMLOListElement>(null);
  const still = useReducedMotion() === true;

  /*
   * The highest sequence number that was already here when this panel mounted.
   *
   * Only steps above it animate in. Everything at or below it is history the
   * reader arrived to find, and history should be on screen rather than dealt
   * out: a panel that animated eighty-six existing steps on load would be putting
   * on a performance of work that finished before anybody was watching.
   *
   * State with a lazy initialiser, so it is computed from the first render's own
   * events and never again. A ref would do the same job and cannot be read during
   * render, which is exactly when the first list of rows needs it.
   */
  const [mountedAt] = useState(() => events.reduce((high, event) => Math.max(high, event.seq), 0));
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
      label="What obsel is doing"
      // Counts decisions, and promises nothing the scroller cannot reach. Every
      // step it counts is in the DOM and scrolling up gets to the first of them.
      meta={passSummary(passes)}
      tour="trace"
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
        {passes.length === 0 ? (
          <li className={styles.quiet}>
            {error === null
              ? "nothing yet. Every step obsel takes appears here as it happens."
              : boardTrusted
                ? `could not be read (${error}). Nothing else on this page is affected.`
                : `could not be read (${error}).`}
          </li>
        ) : (
          /*
           * Newest last, grouped by the decision each step belongs to.
           *
           * Order is never reversed. The steps are a sequence obsel performed, and
           * putting the latest on top would read the cascade backwards: marks
           * before the comparison that caused them.
           *
           * The grouping is what the flat list could not show. Four of the five
           * passes a `run` plus a `change` produces are quiet ones, each a separate
           * judgement that found nothing to do, and the four quiet judgements are
           * half of what makes the noisy one believable. Undivided they read as one
           * long stream in which nothing happened until the end.
           */
          passes.map((pass) => (
            <Fragment key={pass.key}>
              {/*
                The `read` step, as the group's heading rather than as its first row.
                Its message is already the trigger, "Orders cleaner finished", so it
                identifies the decision without repeating anything inside it.

                Sticky, so the heading of the pass a reader is scrolling through
                stays in view. That also solves a measured defect: with the list
                pinned to the bottom, the top edge used to cut a row in half, 63px
                into a 45px row, so the first thing a viewer saw was a fragment of a
                sentence. An opaque heading occupies that edge instead, and a row
                passing under a heading reads as intended rather than as broken.
              */}
              {pass.header !== null && (
                <li className={styles.heading}>
                  <span className={styles.headingText}>{pass.header.message}</span>
                  {pass.header.outcome !== null && (
                    <span className={styles.headingNote}>{pass.header.outcome}</span>
                  )}
                </li>
              )}
              {pass.events.map((event) => (
                /*
                 * Steps that arrive while somebody is watching rise into place;
                 * steps that were already here do not.
                 *
                 * The key is the sequence number, so a poll that re-serves the
                 * same step re-renders this row without remounting it, and the
                 * entrance does not replay once a second. That is the same rule
                 * the guide's own entrance keeps, for the same reason.
                 */
                <m.li
                  key={event.seq}
                  className={styles.row}
                  style={{ borderLeftColor: TONE[event.phase] }}
                  {...(still || event.seq <= mountedAt
                    ? {}
                    : { variants: STEP, initial: "hidden", animate: "shown" })}
                >
                  <span className={styles.clock}>{clockTime(event.at)}</span>
                  <span className={styles.text} style={{ color: TONE[event.phase] }}>
                    {event.message}
                  </span>
                  {/* Only when there is one. An outcome slot rendered empty would
                      imply obsel had nothing to report from a step that did in fact
                      report something. */}
                  {event.outcome !== null && (
                    <span className={styles.outcome}>{event.outcome}</span>
                  )}
                </m.li>
              ))}
            </Fragment>
          ))
        )}
      </ol>

      {/*
        One fact, and the one that matters: what obsel decides is not private to
        this screen. Whittled from three sentences, then from two, because in a
        220px gutter this footnote cost more height than the steps it described.

        Said "marks are written into DataHub itself". A mark is obsel's own word
        for the thing it attaches to out-of-date work, defined nowhere a reader of
        this line can see, and the sentence is worth nothing to anyone who does not
        already have it.
      */}
      <p className={styles.disclosure}>
        obsel writes all of this into DataHub, not just onto this screen
      </p>
    </Panel>
  );
}
