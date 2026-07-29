"use client";

/**
 * Where the panel will land if you let go now.
 *
 * The one thing that makes a draggable panel feel like a placed object rather
 * than a guess: the answer is on screen before the commitment. Without it a
 * reader drags, releases, and finds out; with it they drag, see, and decide.
 *
 * An outline rather than a filled block, and `pointer-events: none`, so the
 * board underneath stays readable while the choice is being made. A solid
 * rectangle would hide the graph, which is the thing the reader is rearranging
 * the screen in order to see.
 */

import { AnimatePresence, m } from "motion/react";

import { EASE } from "../motion-tokens";
import type { PanelSide } from "./use-panel";

import styles from "./panel.module.css";

export function SnapPreview({
  side,
  width,
  still,
}: {
  /** Which edge the pointer is currently over, or nothing when not dragging. */
  side: PanelSide | null;
  width: number;
  /** Reduced motion: the outline appears rather than fades. */
  still: boolean;
}) {
  return (
    <AnimatePresence>
      {side !== null && (
        <m.div
          /*
           * Keyed on the side, so crossing the middle of the screen replaces the
           * outline rather than sliding one rectangle across the board. A
           * travelling ghost would read as a thing being dragged, and the thing
           * being dragged is the panel itself, already under the pointer.
           */
          key={side}
          className={styles.ghost}
          style={{ width, [side]: 0 }}
          aria-hidden="true"
          {...(still
            ? {}
            : {
                initial: { opacity: 0 },
                animate: { opacity: 1, transition: { duration: 0.12, ease: EASE } },
                exit: { opacity: 0, transition: { duration: 0.1, ease: EASE } },
              })}
        />
      )}
    </AnimatePresence>
  );
}
