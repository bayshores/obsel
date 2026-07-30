"use client";

/**
 * The one place on the board that answers "what is this box".
 *
 * It replaces a panel that appeared only on a click, with nothing anywhere
 * saying a click would do anything. The affordance was invisible: a reader who
 * never guessed simply never saw any of it, and a reader who did guess found the
 * name of the thing printed three times before any of its detail.
 *
 * So the surface is always here, at three depths:
 *
 * - **idle** — one line saying what pointing and clicking do. It does not
 *   disappear after first use: that would need state the dashboard deliberately
 *   does not persist, and would hide the affordance from the next person to look
 *   at a shared screen.
 * - **hover** — the node under the pointer, in human names, no identifiers.
 * - **pinned** — a click, and everything obsel holds, until Esc or close.
 *
 * **Hovering while pinned does not change what is pinned.** The board's edges
 * follow the pointer, so a reader can see what a click would open, but a panel
 * that swapped its contents as the pointer crossed the board on the way to
 * reading it would be impossible to read.
 */

import { useEffect } from "react";

import { DataInspector, DetailsPanel, Inspector } from "./inspector";
import type { TaskRecord } from "@/src/server/coordinator/types";

import styles from "./details-surface.module.css";

export function DetailsSurface({
  pinnedTask,
  pinnedDataset,
  hoverTask,
  hoverDataset,
  tasks,
  snapshotAt,
  readAt,
  roundTripMs,
  datahubUrl,
  coverageFor,
  populated,
  onClose,
  onPin,
  onHold,
  onRelease,
}: {
  pinnedTask: TaskRecord | null;
  pinnedDataset: string | null;
  hoverTask: TaskRecord | null;
  hoverDataset: string | null;
  tasks: TaskRecord[];
  snapshotAt: string | null;
  readAt: string | null;
  roundTripMs: number | null;
  datahubUrl: string | null;
  /** What the erasure report says about one table, asked per table shown. */
  coverageFor: (dataset: string) => string | null;
  /** Whether the board has anything to point at. */
  populated: boolean;
  onClose: () => void;
  /** Clicking the preview pins it, without going back to find the small box. */
  onPin: () => void;
  onHold: () => void;
  onRelease: () => void;
}) {
  const pinned = pinnedTask !== null || pinnedDataset !== null;
  const hovering = !pinned && (hoverTask !== null || hoverDataset !== null);

  /*
   * Esc closes, from anywhere on the board.
   *
   * The close button has always been there and is still the obvious path. This
   * is for the reader who opened a node by accident while panning and wants the
   * picture back without hunting for a target. It is bound only while something
   * is pinned: a hover has no state to escape from, since moving the pointer
   * away already ends it.
   */
  useEffect(() => {
    if (!pinned) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pinned, onClose]);

  if (!pinned && !hovering) {
    if (!populated) return null;
    return (
      <div className={styles.idle}>
        {/* Short enough to hold one line at the card's own width. The wrapped
            two-line version read as a paragraph rather than as a hint. */}
        <span className={styles.idleText}>hover a box to preview it, click to pin</span>
      </div>
    );
  }

  const task = pinned ? pinnedTask : hoverTask;
  const dataset = pinned ? pinnedDataset : hoverDataset;

  return (
    <div
      className={pinned ? styles.slotPinned : styles.slot}
      onMouseEnter={onHold}
      onMouseLeave={onRelease}
      {...(pinned ? {} : { onClick: onPin })}
    >
      {/*
        The sweep, and nothing but a sweep.

        A separate element with no text in it, over the panel rather than part of
        it, so a dropped frame or an interrupted run cannot touch a single value
        the panel states. Same construction as the flare on a marked node.
      */}
      <span className={styles.sweep} aria-hidden="true" />

      <div
        /*
         * Keyed on what is being described, so moving to a second node replays
         * the reveal rather than leaving the first node's values on screen while
         * the second's arrive underneath them.
         */
        key={`${pinned ? "pin" : "hover"}:${task?.urn ?? dataset ?? "none"}`}
        className={styles.reveal}
      >
        <DetailsPanel
          pinned={pinned}
          style={{ flex: 1, minHeight: 0, border: "1px solid var(--mm-border-strong)" }}
        >
          {dataset !== null && (
            <DataInspector
              dataset={dataset}
              tasks={tasks}
              readAt={readAt}
              roundTripMs={roundTripMs}
              coverageState={coverageFor(dataset)}
              preview={!pinned}
              onClose={onClose}
            />
          )}
          {task !== null && (
            <Inspector
              task={task}
              snapshotAt={snapshotAt}
              readAt={readAt}
              roundTripMs={roundTripMs}
              // Not gated on `trusted`: this is where DataHub's UI lives, not
              // a measurement of it, so a failed read does not make it wrong.
              datahubUrl={datahubUrl}
              preview={!pinned}
              onClose={onClose}
            />
          )}
        </DetailsPanel>
      </div>
    </div>
  );
}
