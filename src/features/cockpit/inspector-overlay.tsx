"use client";

/**
 * The details panel, floating over the canvas.
 *
 * The contents are unchanged: `inspector.tsx` still renders every field, the
 * DataHub link, and a mark's reason verbatim rather than summarised. What
 * changed is where it appears and how it arrives.
 *
 * It arrives on the same spring the tour window uses, because it is the same
 * kind of thing: an object a reader deliberately picked up, put down over the
 * picture, and will put away again. Everything else on this board is an
 * instrument reading and moves on a fixed curve.
 */

import { AnimatePresence, LazyMotion, domMax, m, useReducedMotion } from "motion/react";
import { useEffect } from "react";

import { DataInspector, Inspector } from "./inspector";
import { EASE, SPRING } from "./motion-tokens";
import type { TaskRecord } from "@/src/server/coordinator/types";

import styles from "./inspector-overlay.module.css";

const CARD = {
  hidden: { opacity: 0, y: 14, scale: 0.98 },
  shown: { opacity: 1, y: 0, scale: 1, transition: SPRING },
  gone: { opacity: 0, y: 8, scale: 0.99, transition: { duration: 0.16, ease: EASE } },
};

export function InspectorOverlay({
  task,
  dataset,
  tasks,
  snapshotAt,
  readAt,
  roundTripMs,
  datahubUrl,
  onClose,
}: {
  task: TaskRecord | null;
  dataset: string | null;
  tasks: TaskRecord[];
  snapshotAt: string | null;
  readAt: string | null;
  roundTripMs: number | null;
  datahubUrl: string | null;
  onClose: () => void;
}) {
  const still = useReducedMotion() === true;
  const open = task !== null || dataset !== null;

  /*
   * Esc closes, from anywhere on the board.
   *
   * The close button has always been there and is still the obvious path. This
   * is for the reader who opened a node by accident while panning and wants the
   * picture back without hunting for a target.
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const body: React.CSSProperties = {
    flex: "1 1 auto",
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    border: "1px solid var(--mm-border-strong)",
  };

  return (
    <LazyMotion features={domMax} strict>
      <AnimatePresence>
        {open && (
          <m.div
            /*
             * Keyed on what is being shown, so clicking a second node replaces
             * the card rather than leaving the first one's values on screen
             * while the new ones arrive underneath them.
             */
            key={task?.urn ?? dataset ?? "none"}
            className={styles.slot}
            {...(still
              ? {}
              : { variants: CARD, initial: "hidden", animate: "shown", exit: "gone" })}
          >
            {dataset !== null && (
              <DataInspector
                dataset={dataset}
                tasks={tasks}
                readAt={readAt}
                roundTripMs={roundTripMs}
                onClose={onClose}
                style={body}
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
                onClose={onClose}
                style={body}
              />
            )}
          </m.div>
        )}
      </AnimatePresence>
    </LazyMotion>
  );
}
