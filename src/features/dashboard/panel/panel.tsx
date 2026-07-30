"use client";

/**
 * The panel: the guide, the evidence, and the two numbers, in one column beside
 * the picture.
 *
 * This is the half of the redesign that fixed the complaint. The activity feed
 * used to be a strip under a fixed-height graph panel, and after five other
 * regions took their share of a 990px column it landed on its 172px floor with a
 * 105px scroller: three steps of eighty-six, the top one cut through its own
 * text. Nothing about that was tunable, because the strip was the residual of a
 * stack and every other region was content-sized. Here it is a tab in a column
 * as tall as the frame.
 *
 * One `LazyMotion` root for the whole panel. `strict` makes the full `motion.`
 * components throw, which is what stops a later edit importing the library back
 * in beside the lazy bundle, and `domMax` rather than `domAnimation` is required
 * by exactly one thing: the travelling underline in `tabs.tsx` needs layout
 * projection.
 */

import {
  AnimatePresence,
  LazyMotion,
  domMax,
  m,
  useDragControls,
  useReducedMotion,
} from "motion/react";
import { useCallback, useRef, useState } from "react";

import { GuidePanel } from "../guide/guide-panel";
import { Stats } from "./stats";
import { HistoryPanel } from "../history/history-panel";
import { JoiningPanel } from "../joining/joining-panel";
import { YourDataPanel } from "../your-data/your-data-panel";
import { EASE, SPRING } from "../motion-tokens";
import { TracePanel } from "../trace/trace-panel";
import { SnapPreview } from "./snap-preview";
import { Tabs, panelId } from "./tabs";
import type { TabId } from "./tabs";
import { clampWidth } from "./use-panel";
import type { PanelSide } from "./use-panel";
import type { GuideView } from "../guide/guide";
import type { RevealTarget } from "../guide/guide-view";
import type { JoinView } from "../joining/joining";
import type { ChangesState } from "../hooks/use-changes";
import type { YourDataView } from "../your-data/your-data";
import type { SwarmTotals } from "../timing";
import type { DemoActivity } from "@/src/server/runner/types";
import type { TaskRecord, TraceEvent } from "@/src/server/coordinator/types";

import styles from "./panel.module.css";

/** One pane leaving as the next arrives. Sideways, so the order is legible. */
const PANE = {
  hidden: { opacity: 0, x: 14 },
  shown: { opacity: 1, x: 0, transition: { duration: 0.24, ease: EASE } },
  gone: { opacity: 0, x: -10, transition: { duration: 0.12, ease: EASE } },
};

export interface PanelProps {
  side: PanelSide;
  width: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSetSide: (side: PanelSide) => void;
  onSetWidth: (width: number) => void;
  activeTab: TabId;
  onSelectTab: (tab: TabId) => void;

  guideView: GuideView;
  activity: DemoActivity | null;
  activityError: string | null;
  trusted: boolean;
  /** Opens one of this panel's own tabs, for the guide's reveal actions. */
  onReveal: (target: RevealTarget) => void;

  traceEvents: TraceEvent[];
  traceError: string | null;

  /**
   * The board's change history, as its hook returns it.
   *
   * Passed as the hook's own state rather than flattened into three props,
   * because "read failed", "not read yet" and "read, and empty" are three
   * different things this panel has to render differently, and splitting them
   * across sibling props is how two of them get confused.
   */
  changes: ChangesState;

  joinView: JoinView;
  mineView: YourDataView;
  tasks: TaskRecord[];
  totals: SwarmTotals;

  /**
   * The erasure tab's body, built by the dashboard and handed over whole.
   *
   * The panel composes; it does not know what erasure is. Passing the element
   * rather than eight more props keeps the report's own state, its polling and
   * its vocabulary in one place, next to the rules they have to obey.
   */
  erasure: React.ReactNode;
}

export function Panel(props: PanelProps) {
  const still = useReducedMotion() === true;
  const controls = useDragControls();

  /** Which edge the pointer is over mid-drag, and nothing when not dragging. */
  const [landing, setLanding] = useState<PanelSide | null>(null);
  const [carrying, setCarrying] = useState(false);

  /*
   * The width while the edge is being dragged, before it is committed.
   *
   * Kept here rather than pushed straight into the stored preference, because
   * that preference writes to `localStorage`: tracking a drag through it would
   * write sixty times a second to record a number that is about to change again.
   * The reader sees the live value; the disk sees the settled one.
   */
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const resizing = useRef(false);
  const width = dragWidth ?? props.width;

  const onResizeMove = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!resizing.current) return;
      // The panel's inner edge is under the pointer, so its width is the distance
      // from that pointer to whichever screen edge the panel is anchored to.
      const raw = props.side === "right" ? window.innerWidth - event.clientX : event.clientX;
      setDragWidth(clampWidth(raw, window.innerWidth));
    },
    [props.side],
  );

  const endResize = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!resizing.current) return;
      resizing.current = false;
      event.currentTarget.releasePointerCapture(event.pointerId);
      if (dragWidth !== null) props.onSetWidth(dragWidth);
      setDragWidth(null);
    },
    [dragWidth, props],
  );

  if (props.collapsed) {
    return (
      <div
        className={props.side === "left" ? `${styles.rail} ${styles.railLeft}` : styles.rail}
        data-panel="rail"
      >
        <button
          type="button"
          className={styles.railButton}
          onClick={props.onToggleCollapsed}
          /*
           * Named for what pressing it does, not for what it looks like. "open
           * the panel" is the sentence a screen reader should read out; the
           * arrow is decoration and is hidden from it.
           */
          aria-label="Open the panel"
          title="Open the panel"
        >
          <span aria-hidden="true">{props.side === "left" ? "›" : "‹"}</span>
        </button>
        {/*
          The one fact a collapsed panel must still report.

          A reader collapses this to see the whole graph, and gives up the guide
          to do it. What they must not give up is whether anything on the board
          is out of date, so the count comes with them, rotated into the rail.
        */}
        <span className={styles.railNote}>
          {props.trusted
            ? props.totals.stale > 0
              ? `${props.totals.stale} out of date`
              : "nothing out of date"
            : "not connected"}
        </span>
      </div>
    );
  }

  return (
    <LazyMotion features={domMax} strict>
      <SnapPreview side={landing} width={width} still={still} />
      <m.aside
        className={[
          styles.panel,
          props.side === "left" ? styles.panelLeft : "",
          carrying ? styles.carrying : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={{ flex: `0 0 ${width}px`, width }}
        aria-label="obsel controls"
        data-panel={props.side}
        data-panel-carrying={carrying ? "true" : "false"}
        /*
         * Picked up by the grip only, never by its contents.
         *
         * `dragListener={false}` is what makes that true: without it, selecting a
         * line of the guide's log or scrolling the feed would start dragging the
         * whole panel. The grip hands the gesture over explicitly.
         */
        drag={still ? false : "x"}
        dragListener={false}
        dragControls={controls}
        dragMomentum={false}
        dragElastic={0.2}
        /*
         * Springs back to where it started, always. The panel does not stay where
         * it was dropped: it lands on one of two edges, and the layout is what
         * puts it there. The snap back is the gesture ending, and the side change
         * underneath it is the result.
         */
        dragSnapToOrigin
        onDragStart={() => setCarrying(true)}
        onDrag={(_event, info) => {
          setLanding(info.point.x < window.innerWidth / 2 ? "left" : "right");
        }}
        onDragEnd={(_event, info) => {
          setCarrying(false);
          setLanding(null);
          props.onSetSide(info.point.x < window.innerWidth / 2 ? "left" : "right");
        }}
        /*
         * `layout` so that moving to the other side is a move rather than a cut.
         * The DOM order never changes (the deck reverses instead), so this is the
         * one element whose box genuinely travels across the frame.
         */
        layout={still ? false : "position"}
        transition={SPRING}
      >
        {/*
          The edge that resizes the panel, on the side facing the graph.

          A button rather than a div: it is a control, it takes focus, and the
          keyboard can work it. Arrow keys move it in the same direction the
          pointer would, which is the only way this is reachable without a mouse.
        */}
        <button
          type="button"
          className={`${styles.resizer} ${
            props.side === "right" ? styles.resizerRight : styles.resizerLeft
          }`}
          aria-label="Resize the panel"
          data-panel-resizer="true"
          onPointerDown={(event) => {
            resizing.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            event.preventDefault();
          }}
          onPointerMove={onResizeMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onKeyDown={(event) => {
            const step = event.key === "ArrowLeft" ? -24 : event.key === "ArrowRight" ? 24 : 0;
            if (step === 0) return;
            event.preventDefault();
            // Widening is leftwards when the panel is on the right, and rightwards
            // when it is on the left. The key moves the edge, not the number.
            const delta = props.side === "right" ? -step : step;
            props.onSetWidth(clampWidth(props.width + delta, window.innerWidth));
          }}
        />

        <div
          className={carrying ? `${styles.grip} ${styles.gripping}` : styles.grip}
          data-panel-grip="true"
          onPointerDown={(event) => {
            if (still) return;
            controls.start(event);
          }}
        >
          <span className={styles.gripLines} aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className={styles.gripLabel}>obsel</span>
          <span className={styles.gripButtons}>
            {/*
              The keyboard and screen-reader path to the other side, because a
              drag is neither. Two edges is the whole range, so this is a single
              control that names where it will go rather than a pair.
            */}
            <button
              type="button"
              className={styles.gripButton}
              onClick={() => props.onSetSide(props.side === "right" ? "left" : "right")}
              aria-label={`Move the panel to the ${props.side === "right" ? "left" : "right"}`}
              title={`Move the panel to the ${props.side === "right" ? "left" : "right"}`}
            >
              <span aria-hidden="true">{props.side === "right" ? "⇤" : "⇥"}</span>
            </button>
            <button
              type="button"
              className={styles.gripButton}
              onClick={props.onToggleCollapsed}
              aria-label="Hide the panel and show the whole graph"
              title="Hide the panel and show the whole graph"
            >
              <span aria-hidden="true">{props.side === "left" ? "‹" : "›"}</span>
            </button>
          </span>
        </div>

        <div className={styles.guide}>
          <GuidePanel
            view={props.guideView}
            activity={props.activity}
            activityError={props.activityError}
            boardTrusted={props.trusted}
            onReveal={props.onReveal}
          />
        </div>

        <Tabs active={props.activeTab} onSelect={props.onSelectTab} still={still} />

        <div className={styles.body}>
          {/*
            `mode="wait"` so the outgoing pane is gone before the incoming one
            arrives. Two panes cross-fading in a 420px column overlap their text,
            which reads as a rendering fault rather than as a transition.
          */}
          <AnimatePresence mode="wait" initial={false}>
            <m.div
              key={props.activeTab}
              className={styles.pane}
              id={panelId(props.activeTab)}
              role="tabpanel"
              /*
               * Focusable, because the panel scrolls. A scrollable region that
               * cannot be focused cannot be scrolled from the keyboard at all,
               * which on the activity tab means the feed is unreachable without
               * a mouse.
               */
              tabIndex={0}
              {...(still
                ? {}
                : { variants: PANE, initial: "hidden", animate: "shown", exit: "gone" })}
            >
              {props.activeTab === "activity" && (
                <TracePanel
                  events={props.traceEvents}
                  error={props.traceError}
                  boardTrusted={props.trusted}
                  style={{
                    // Zero basis, like every other region in this column: the
                    // feed's own content height must not decide the layout.
                    flex: "1 1 0",
                    minHeight: 0,
                    border: "none",
                    display: "flex",
                    flexDirection: "column",
                  }}
                />
              )}
              {props.activeTab === "history" && (
                <HistoryPanel
                  history={props.changes.history}
                  error={props.changes.error}
                  everRead={props.changes.everRead}
                  boardTrusted={props.trusted}
                />
              )}
              {props.activeTab === "join" && (
                <div className={styles.paneScrolls}>
                  <JoiningPanel view={props.joinView} />
                </div>
              )}
              {/* `YourDataPanel` renders the tableForm inside itself; its own header
                  records why the two belong together rather than as siblings. */}
              {props.activeTab === "data" && (
                <div className={styles.paneScrolls}>
                  <YourDataPanel view={props.mineView} tasks={props.tasks} />
                </div>
              )}
              {props.activeTab === "erasure" && props.erasure}
            </m.div>
          </AnimatePresence>
        </div>

        <div className={styles.stats}>
          <Stats trusted={props.trusted} totals={props.totals} />
        </div>
      </m.aside>
    </LazyMotion>
  );
}
