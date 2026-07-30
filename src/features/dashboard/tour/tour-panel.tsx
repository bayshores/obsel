"use client";

/**
 * The tour on screen: a window you can pick up, and a glow on whatever it is
 * currently talking about.
 *
 * Why a window rather than another region of the board is recorded at the top of
 * `tour.module.css`. What it does is here:
 *
 * - **It teaches one thing at a time.** The card holds one title, one short
 *   paragraph, and one thing to do. There is no point at which the whole flow is
 *   handed over at once.
 * - **It points.** The region the current step is about is outlined and lit on
 *   the board itself, and scrolled into view if it is off screen.
 * - **It waits.** An action step has no next button. It quotes the real control
 *   by the label the guide is currently painting on it, shows what is happening
 *   while it happens, and moves on when the board says the thing is done.
 * - **It gets out of the way.** Drag it anywhere by its bar, or close it; the
 *   opener in the header brings it back where it was left.
 */

import {
  AnimatePresence,
  LazyMotion,
  domMax,
  m,
  useDragControls,
  useReducedMotion,
} from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { PulseDot } from "../mmux";
import { EASE, SPRING } from "../motion-tokens";
import { STEP_NAME } from "../guide/guide";
import { TOUR } from "./steps";
import type { ActStep, TourStep, TourTarget } from "./steps";
import type { TourState } from "./use-tour";
import type { PanelSide } from "../panel/use-panel";
import type { GuideInput, GuideView } from "../guide/guide";

import styles from "./tour.module.css";

/**
 * The window arriving and leaving.
 *
 * A spring rather than a duration. Everything else on the board is an instrument
 * reading and moves on a fixed curve; this is a physical object being put down
 * on the screen and picked back up, and the small overshoot is what makes it
 * read that way. The panel is the other object of that kind and uses the same
 * spring, which is why it lives in `motion-tokens.ts` rather than here.
 */
const WINDOW = {
  hidden: { opacity: 0, y: 24, scale: 0.96 },
  shown: { opacity: 1, y: 0, scale: 1, transition: SPRING },
  gone: { opacity: 0, y: 12, scale: 0.98, transition: { duration: 0.16, ease: EASE } },
};

/** One card leaving as the next arrives. Sideways, so the order is legible. */
const CARD = {
  hidden: { opacity: 0, x: 18 },
  shown: { opacity: 1, x: 0, transition: { duration: 0.32, ease: EASE } },
  gone: { opacity: 0, x: -14, transition: { duration: 0.14, ease: EASE } },
};

/** Where the window sits before anybody moves it: out of the board's way. */
const HOME = { edge: 24, bottom: 24 } as const;

/**
 * The corner the window rests in: the one the panel is not using.
 *
 * It was always the bottom right, which was correct while the board was a
 * column and every region ran the full width. With a panel down one side, the
 * bottom right is a panel: the window opened on top of the panel and covered the
 * two measured numbers pinned at its foot, which are the figures the whole
 * demonstration exists to establish.
 *
 * A reader can still drag it anywhere. This only decides where it starts, and
 * it starts out of the way.
 */
function homeCorner(panelSide: PanelSide): { left?: number; right?: number; bottom: number } {
  return panelSide === "right"
    ? { left: HOME.edge, bottom: HOME.bottom }
    : { right: HOME.edge, bottom: HOME.bottom };
}

/**
 * The board region a step points at, as a selector.
 *
 * `data-tour` attributes rather than the panels' accessible names: those are
 * user-facing copy and get reworded, and a highlight that silently stops
 * appearing when somebody improves a heading is worse than no highlight.
 */
function selectorFor(step: TourStep, view: GuideView): string | null {
  if (step.kind === "act") {
    const offered = offeredAction(step, view);
    return offered === null ? null : `[data-tour-action="${offered.step}"]`;
  }
  return step.target === "none" ? null : `[data-tour="${step.target}"]`;
}

/** The guide's own button for this act, when it is currently offering one. */
function offeredAction(step: ActStep, view: GuideView): GuideView["actions"][number] | null {
  for (const wanted of step.launches) {
    const found = view.actions.find((action) => action.step === wanted);
    if (found !== undefined) return found;
  }
  return null;
}

export function TourPanel({
  tour,
  view,
  input,
  reveal,
  panelSide,
}: {
  tour: TourState;
  view: GuideView;
  input: GuideInput;
  /**
   * Ask the board to put a region on screen before it is pointed at.
   *
   * Three of the regions the tour names are tabs of one panel now, so at any
   * moment two of them are not rendered at all. A highlight applied to nothing
   * fails silently: the step would appear to have pointed somewhere, and the
   * reader would be told to look at a panel that is not there. The tour asks,
   * the dashboard opens the right tab, and this file goes back to knowing only
   * about selectors.
   */
  reveal?: (target: TourTarget) => void;
  /**
   * Which edge the panel is on, so the window can rest against the other one.
   *
   * Passed rather than read from the store, because this file knows nothing
   * about the panel and should not start: all it needs is which corner is free.
   */
  panelSide: PanelSide;
}) {
  const still = useReducedMotion() === true;
  const step = tour.step;
  const controls = useDragControls();

  /*
   * The glow, applied to somebody else's element.
   *
   * Every target is a component that styles itself inline, so a class added
   * here cannot be handed down through props without threading a tour concept
   * through four unrelated files. Adding it to the node and taking it off again
   * keeps the knowledge in one place, and the cleanup runs on every change of
   * step, so two regions can never be lit at once.
   */
  useEffect(() => {
    if (!tour.open) return;
    if (reveal) reveal(step.target);
    const selector = selectorFor(step, view);
    if (selector === null) return;

    /*
     * Found now, or on one of the next few frames.
     *
     * A revealed tab mounts through `AnimatePresence`, so on the frame this
     * effect runs the element it is looking for may not exist yet. A single
     * `querySelector` would miss it and the step would light nothing. This
     * retries for a handful of frames and then gives up, which is long enough
     * for a mount and short enough that a genuinely absent target does not leave
     * a timer running behind the reader.
     */
    let frame = 0;
    let tries = 0;
    let lit: Element | null = null;
    const look = (): void => {
      const target = document.querySelector(selector);
      if (target === null) {
        tries += 1;
        if (tries < 10) frame = requestAnimationFrame(look);
        return;
      }
      lit = target;
      target.classList.add(styles.lit);
      /*
       * Only when it is genuinely off screen, and the scroll now happens inside
       * whichever panel holds the target rather than on the page: the page does
       * not scroll at all. `scrollIntoView` walks up to the nearest scrollable
       * ancestor, which is the panel's own body, so this still works and moves
       * nothing a reader was looking at.
       */
      const box = target.getBoundingClientRect();
      if (box.top < 0 || box.bottom > window.innerHeight) {
        target.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "center" });
      }
    };
    look();

    return () => {
      cancelAnimationFrame(frame);
      if (lit !== null) lit.classList.remove(styles.lit);
    };
    // `view` is a new object every poll, and re-running this a second would
    // restart the scroll; the step and the open flag are what genuinely change.
  }, [tour.open, step, view, still, reveal]);

  // Esc closes, from anywhere. A window with no keyboard exit is a trap.
  useEffect(() => {
    if (!tour.open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") tour.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tour.open, tour]);

  /*
   * How far the window may be dragged, so it can never be put somewhere it
   * cannot be got back from. Recomputed on resize, because a window parked in
   * the far corner of a wide display is off screen entirely on a narrow one.
   */
  const [bounds, setBounds] = useState({ left: 0, right: 0, top: 0, bottom: 0 });
  const frame = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const measure = (): void => {
      const box = frame.current?.getBoundingClientRect();
      // Its own height, not a guess: the cards differ by tens of pixels and a
      // guessed one either lets the bar go under the top edge or stops short of
      // it. Falls back only on the frame before the first measurement.
      const height = box?.height ?? 260;
      const width = box?.width ?? Math.min(400, window.innerWidth - 32);
      /*
       * The travel available from wherever it rests, in both directions.
       *
       * It used to rest against the right edge, so it could only ever be
       * dragged left and up and the other two limits were zero. It now rests
       * against whichever edge the panel is not on, so the room is on the other
       * side and the constraint has to be worked out from where it actually is
       * rather than assumed.
       */
      const spare = Math.max(0, window.innerWidth - width - HOME.edge - 16);
      const up = -Math.max(0, window.innerHeight - height - HOME.bottom - 16);
      setBounds(
        panelSide === "right"
          ? { left: 0, right: spare, top: up, bottom: 0 }
          : { left: -spare, right: 0, top: up, bottom: 0 },
      );
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
    // Re-measured per step, because each card is a different height, and per
    // panel side, because that decides which way the window has room to go.
  }, [tour.open, step, panelSide]);

  const settled = step.kind === "act" && step.done(input);

  return (
    <LazyMotion features={domMax} strict>
      <AnimatePresence>
        {tour.open && (
          <m.section
            ref={frame}
            className={styles.window}
            style={homeCorner(panelSide)}
            aria-label="guide"
            /*
             * Dragged by the bar, not by the whole window.
             *
             * `dragListener={false}` switches off motion's own pointer listener
             * on the window, and the bar starts the drag through `dragControls`
             * instead. Without that, selecting a word of the explanation would
             * pick the window up and carry it across the screen.
             */
            drag
            dragListener={false}
            dragControls={controls}
            dragConstraints={bounds}
            dragMomentum={false}
            dragElastic={0.04}
            {...(still
              ? {}
              : { variants: WINDOW, initial: "hidden", animate: "shown", exit: "gone" })}
          >
            <Bar tour={tour} onGrab={(event) => controls.start(event)} />
            <Rail at={tour.number - 1} />

            <AnimatePresence mode="wait">
              <m.div
                className={styles.body}
                key={step.id}
                {...(still
                  ? {}
                  : { variants: CARD, initial: "hidden", animate: "shown", exit: "gone" })}
              >
                <h2 className={styles.title}>{step.title}</h2>
                <p className={styles.text}>{step.body}</p>
                {step.kind === "act" && (
                  <Ask step={step} view={view} input={input} settled={settled} />
                )}
              </m.div>
            </AnimatePresence>

            <Foot tour={tour} settled={settled} />
          </m.section>
        )}
      </AnimatePresence>
    </LazyMotion>
  );
}

/** The bar: the handle, the name, which chapter, and the way out. */
function Bar({ tour, onGrab }: { tour: TourState; onGrab: (event: ReactPointerEvent) => void }) {
  return (
    // The whole strip is the handle, which is why the close button below stops
    // the event: a pointer down on the × must not also begin a drag.
    <div className={styles.bar} onPointerDown={onGrab}>
      <span className={styles.grip} aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
        <span />
        <span />
      </span>
      <span className={styles.barName}>guide</span>
      <span className={styles.barChapter}>
        {tour.step.chapter === 1 ? "the screen" : "the run"}
      </span>
      <button
        type="button"
        className={styles.close}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={tour.close}
        aria-label="close guide"
      >
        ×
      </button>
    </div>
  );
}

/** Ten segments in two groups: four explanations, then the run. */
function Rail({ at }: { at: number }) {
  return (
    <div className={styles.rail} aria-hidden="true">
      {TOUR.map((step, index) => (
        <span
          key={step.id}
          className={styles.segment}
          data-state={index === at ? "now" : index < at ? "done" : "ahead"}
          data-first-of-chapter={
            index > 0 && TOUR[index - 1].chapter !== step.chapter ? "true" : "false"
          }
        />
      ))}
    </div>
  );
}

/**
 * What an action step asks for, in whichever of its three states it is in.
 *
 * The label is read off the guide's live action list rather than written here,
 * so the instruction always quotes a control that is genuinely on screen. When
 * the guide is offering none — because a step is already running, or because
 * this board is somebody else's swarm — the card says what is happening instead
 * of naming a button that is not there.
 */
function Ask({
  step,
  view,
  input,
  settled,
}: {
  step: ActStep;
  view: GuideView;
  input: GuideInput;
  settled: boolean;
}) {
  if (settled) {
    return (
      <p className={styles.settled}>
        <PulseDot color="var(--mm-green)" />
        done, and the board shows it
      </p>
    );
  }

  const running = input.activity?.running ?? null;
  const inFlight = running !== null && step.launches.includes(running.step);
  const offered = offeredAction(step, view);
  const progress = step.progress(input);

  return (
    <div className={styles.ask}>
      {inFlight ? (
        <>
          <span className={styles.askLead}>running now</span>
          <span className={styles.askLabel}>{STEP_NAME[running.step]}</span>
          <span className={styles.live} data-tone="running">
            <PulseDot pulse color="var(--mm-green)" />
            {progress ?? "this takes a few minutes; you can close this window"}
          </span>
        </>
      ) : offered !== null ? (
        <>
          {/* No direction in the words. The button's position moves with the
              viewport -- the controls sit beside the sentence on a wide screen
              and under it on a narrow one -- and the glow on the board is the
              thing actually doing the pointing. */}
          <span className={styles.askLead}>press this, glowing on the page</span>
          <span className={styles.askLabel}>{offered.label}</span>
          <span className={styles.live}>
            <PulseDot pulse color="var(--mm-rose-hot)" />
            waiting for you
          </span>
        </>
      ) : (
        <>
          <span className={styles.askLead}>waiting for the board</span>
          <span className={styles.live}>
            <PulseDot pulse color="var(--mm-rose-hot)" />
            {progress ?? "this step is not offered for this pipeline"}
          </span>
        </>
      )}
    </div>
  );
}

/**
 * Back, forward, and the count.
 *
 * The forward control is absent on an action step that has not happened yet, and
 * that absence is the rule the whole tour rests on: there is no way to tell it
 * you did something you did not do. It comes back the moment the board shows the
 * act is done, and it is present on every explanation.
 */
function Foot({ tour, settled }: { tour: TourState; settled: boolean }) {
  const waiting = tour.step.kind === "act" && !settled;
  const last = tour.number === tour.total;

  return (
    <div className={styles.foot}>
      <span className={styles.count}>
        {tour.number} of {tour.total}
      </span>
      <button
        type="button"
        className={styles.step}
        onClick={tour.back}
        disabled={tour.number === 1}
      >
        back
      </button>
      {last ? (
        <button type="button" className={styles.step} data-primary="true" onClick={tour.close}>
          done
        </button>
      ) : (
        !waiting && (
          <button type="button" className={styles.step} data-primary="true" onClick={tour.next}>
            next
          </button>
        )
      )}
    </div>
  );
}

/**
 * The opener, in the header.
 *
 * Lit and breathing on a browser that has never met the tour, with one line
 * beside it saying what it is. Quiet for good afterwards. A guide nobody finds
 * is the failure the three attempts before this one shipped with, and a guide
 * that keeps asking after being turned down is the failure on the other side.
 */
export function TourOpener({ tour }: { tour: TourState }) {
  return (
    <span className={styles.offer}>
      {tour.fresh && !tour.open && <span>new here?</span>}
      <button
        type="button"
        className={styles.opener}
        data-fresh={tour.fresh && !tour.open ? "true" : "false"}
        onClick={tour.open ? tour.close : tour.start}
        aria-expanded={tour.open}
      >
        {tour.open ? "hide the guide" : "start the guide"}
      </button>
      {/* After the button, not before it. Read left to right the other way
          round it says "new here? not now start the guide", which offers the
          refusal before the thing being refused. */}
      {tour.fresh && !tour.open && (
        <button type="button" className={styles.notNow} onClick={tour.dismiss}>
          not now
        </button>
      )}
    </span>
  );
}
