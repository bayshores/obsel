"use client";

/**
 * The guide on screen: the stage `guide.ts` derived, the actions it offers,
 * and the running step's own output.
 *
 * Buttons launch real demo steps through `POST /api/demo/launch` — the same
 * commands the README documents, spawned on this machine. Nothing rendered
 * here is scripted ahead: the view prop is recomputed from observed state on
 * every poll, and the log block is the step's stdout verbatim.
 */

import { AnimatePresence, LazyMotion, domMax, m, useReducedMotion } from "motion/react";
import { Fragment, useState } from "react";
import type { ReactNode } from "react";

import { PulseDot } from "./mmux";
import { EASE } from "./motion-tokens";
import { formatDuration } from "./progress";
import { STEP_NAME } from "./guide";
import type { GuideView } from "./guide";
import type { DemoActivity, DemoStep } from "@/src/server/runner/types";

import styles from "./guide.module.css";

/** How many of the step's own lines stay visible without opening the full log. */
const TAIL_LINES = 8;

/**
 * The entrance, as one parent conducting its children.
 *
 * This replaced five hand-written `@keyframes` and a `calc()` stagger driven by
 * an `--i` custom property set inline on every item. The stagger is a
 * `staggerChildren` number here, and the items no longer have to know their own
 * position in the list to be animated in order.
 */
const REVEAL = {
  hidden: {},
  shown: { transition: { delayChildren: 0.08, staggerChildren: 0.05 } },
  gone: { opacity: 0, transition: { duration: 0.12, ease: EASE } },
};

/** One line rising into place. `--mm-dur-med`, and nothing but opacity and y. */
const RISE = {
  hidden: { opacity: 0, y: 6 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.25, ease: EASE } },
};

export function GuidePanel({
  view,
  activity,
  activityError,
  boardTrusted,
}: {
  view: GuideView;
  activity: DemoActivity | null;
  activityError: string | null;
  /** Whether the swarm read behind the board below is currently working. */
  boardTrusted: boolean;
}) {
  const [launching, setLaunching] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  async function launch(step: DemoStep): Promise<void> {
    setLaunching(true);
    setRefused(null);
    try {
      const response = await fetch("/api/demo/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const detail =
          typeof body === "object" && body !== null && "error" in body
            ? String((body as { error: unknown }).error)
            : `obsel answered ${response.status}`;
        const fix =
          typeof body === "object" &&
          body !== null &&
          "fix" in body &&
          (body as { fix: unknown }).fix
            ? ` Run this in a terminal: \`${String((body as { fix: unknown }).fix)}\``
            : "";
        setRefused(`${STEP_NAME[step]} could not be started: ${detail}.${fix}`);
      }
      // On success nothing is set here — the next activity poll reports the
      // running step, which is the truth rather than an optimistic echo.
    } catch (cause) {
      setRefused(
        `obsel could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      setLaunching(false);
    }
  }

  const running = activity?.running ?? null;
  const last = activity?.lastResult ?? null;
  const log = activity?.log ?? [];

  /*
   * Motion is a preference, and honouring it here means rendering the finished
   * picture rather than a hurried version of the animation.
   *
   * motion's own reduced-motion handling keeps opacity transitions and drops
   * transforms, which is a reasonable default and not this board's rule: the
   * guide must be complete on the first frame, the same rule `globals.css`
   * states for the CSS half. So the animation props are simply not passed, and
   * every element renders in its end state because that is the only state it is
   * ever given.
   */
  const still = useReducedMotion() === true;
  const revealing = still
    ? {}
    : {
        variants: REVEAL,
        initial: "hidden" as const,
        animate: "shown" as const,
        exit: "gone" as const,
      };
  const rising = still ? {} : { variants: RISE };

  return (
    /*
     * No Panel wrapper, and no panel title.
     *
     * This was `00 · guide — <headline>` with the subtitle "derived from the board
     * every second · not a script". Both were furniture: the first buried the one
     * sentence that should lead the board inside a panel caption, and the second
     * described the machinery to a reader who had not yet been told what they were
     * looking at. The headline is now the largest thing on screen, which is the
     * entry point the board did not have.
     */
    /*
     * `LazyMotion` with `strict`, so the animation code that ships is the code
     * this file uses. `strict` makes the full `motion.` components throw, which
     * is the point: it is the one thing stopping a later edit from importing the
     * whole library back in beside the lazy bundle.
     *
     * `domMax` rather than `domAnimation` for one feature — the layout
     * projection the rail's cursor needs to travel between two separate ticks.
     */
    <LazyMotion features={domMax} strict>
      <section
        className={styles.headliner}
        aria-label="guide"
        // What the tour's first card points at: the sentence leading the board.
        data-tour="guide"
        /*
         * Whether there is a second column to leave room for.
         *
         * The stages that offer nothing to press are also the ones with the most to
         * say: `prepare` lists every prerequisite with the shell command that fixes
         * it. Held to the narrow column it was a 700px block of instructions with
         * 800px of nothing beside it, and a `python3 -m venv …` broken across two
         * lines for want of the room sitting empty next to it.
         */
        data-actions={view.actions.length > 0 ? "true" : "false"}
      >
        {/*
         * The left column: the sentence, and under it the log of the step that
         * produced it. One grid item rather than two, because a grid row holding
         * only the log is stretched by the column of buttons beside it, which put
         * 40px of nothing between a sentence and the line that belongs to it.
         */}
        <div className={styles.column}>
          {/*
           * `key`, and the one reason for it: the entrance must run when the board
           * genuinely moves, and at no other time.
           *
           * This block is recomputed from a fresh snapshot once a second, so an
           * entrance driven by render would replay once a second forever, which is
           * a flicker rather than an arrival. Keying on the stage is what confines
           * it to a real transition and to first paint.
           *
           * `AnimatePresence` with `mode="wait"` is what the key buys here that a
           * bare remount did not: the outgoing sentence fades before the incoming
           * one arrives, instead of one being replaced mid-air by the other.
           *
           * The log block below is deliberately OUTSIDE this: it holds a
           * `<details>` somebody may have opened, and a remount would close it
           * under them.
           */}
          <AnimatePresence mode="wait">
            <m.div className={styles.reveal} key={view.stage} {...revealing}>
              {view.attention !== null && (
                <m.p className={styles.attention} role="status" {...rising}>
                  {inlineCode(view.attention)}
                </m.p>
              )}
              {refused !== null && (
                <m.p className={styles.attention} role="status" {...rising}>
                  {inlineCode(refused)}
                </m.p>
              )}

              <m.h2 className={styles.headline} {...rising}>
                {view.headline}
              </m.h2>
              {view.subline !== null && (
                <m.p className={styles.subline} {...rising}>
                  {inlineCode(view.subline)}
                </m.p>
              )}

              {/*
          Setup and connection stages only, where a shell command is worth more than
          a word count. Empty on every stage the demo actually passes through.

          Every check is listed, passing ones included. This used to render only the
          failures, so a reader fixing the third of four problems saw one line and no
          sign that three were already behind them. The tick is `aria-hidden` with
          the state in the row's own text, because a screen reader announcing "check
          mark" is not the same as announcing "done".
        */}
              {view.checks.length > 0 && (
                <ul className={styles.notes}>
                  {view.checks.map((check) => (
                    <m.li
                      key={check.name}
                      className={styles.note}
                      data-done={check.done ? "true" : "false"}
                      {...rising}
                    >
                      <span className={styles.tick} aria-hidden="true">
                        {check.done ? "✓" : "○"}
                      </span>
                      <span>
                        <span className={styles.checkName}>
                          {check.name}
                          {check.done ? ": done" : ""}
                        </span>
                        {/* Through `inlineCode`, like every other sentence here: a
                      detail that names a command names it in backticks, and
                      rendering them raw put a literal ` on screen. */}
                        {check.detail !== null && (
                          <span className={styles.checkDetail}>{inlineCode(check.detail)}</span>
                        )}
                        {check.fix !== null && (
                          <span className={styles.checkDetail}>
                            Run this in a terminal: <code>{check.fix}</code>
                          </span>
                        )}
                      </span>
                    </m.li>
                  ))}
                </ul>
              )}
            </m.div>
          </AnimatePresence>

          <div className={styles.side}>
            {running !== null && (
              <>
                {/*
              Labels the log block, and no longer names the step.

              It read "`rerun-same` is live", which leaked the launcher's own id,
              and naming the step plainly instead made it a word-for-word repeat of
              the subline four lines above ("The unchanged re-run is running now,
              and the board updates as it goes"). The subline is the one with the
              extra fact in it, so this became what it always was: the heading on
              the stream underneath.
            */}
                <span className={styles.running}>
                  <PulseDot pulse color="var(--mm-green)" />
                  live output
                </span>
                <pre className={styles.log}>{log.slice(-TAIL_LINES).join("\n")}</pre>
              </>
            )}

            {/*
          Closed by default, which is the point of it.

          A finished step's whole stdout is hundreds of lines of real agent
          output. It is genuine evidence and it stays one click away, but on the
          board it is a single summary line.
        */}
            {running === null && last !== null && (
              <details className={styles.disclosure}>
                <summary>
                  {STEP_NAME[last.step]} {describeEnd(last.exitCode)} in{" "}
                  {formatDuration(last.durationMs)}
                </summary>
                <pre className={styles.log}>{log.join("\n")}</pre>
              </details>
            )}

            {/*
              Only when the board itself is still being read.

              Two reads fail separately: this one, and the swarm read that fills
              the board below. When only this one fails, "the board below is
              unaffected" is a true and useful thing to say, because the graph is
              served by the other read and is genuinely current.

              When both fail -- a stopped server, the common case -- it is false,
              and it used to be printed anyway, directly above `cockpit.tsx`'s
              alert saying everything below is from the last read that worked and
              may already be wrong. The board told the reader that what they were
              looking at was fine and possibly wrong, in two paragraphs, one after
              the other.

              So the condition is not "did this read fail" but "did this read fail
              while the other one is working". With both down there is one fault
              and the alert is its one report.
            */}
            {activityError !== null && boardTrusted && (
              <p className={styles.aside}>
                obsel could not read what the demo is doing ({activityError}), so the buttons may
                refuse until it can. The board below is unaffected.
              </p>
            )}
          </div>
        </div>

        {/* The right column: read what happened, then choose what to do about it.
          Keyed on the stage for the same reason the sentence is, and separately
          from it because they are two items in the grid. */}
        {view.actions.length > 0 && (
          <m.div className={styles.actions} key={`actions-${view.stage}`} {...revealing}>
            {view.actions.map((action) => (
              <m.button
                key={action.step}
                type="button"
                className={
                  action.primary === true
                    ? `${styles.action} ${styles.actionPrimary}`
                    : styles.action
                }
                /*
                 * How the tour finds this control. It points at the button that
                 * performs the act it is asking for, and it reads the label off
                 * `view.actions` rather than writing its own, so it can never
                 * name a button this board is not offering.
                 */
                data-tour-action={action.step}
                disabled={launching}
                onClick={() => void launch(action.step)}
                {...rising}
              >
                <span className={styles.actionLabel}>{action.label}</span>
                <span className={styles.actionDetail}>{action.detail}</span>
              </m.button>
            ))}
          </m.div>
        )}

        {/*
        The join panel used to be here, as one closed 17px line under the
        actions. It is `joining-panel.tsx` now, a real panel below the graph,
        and that file's header records why it moved.
      */}
      </section>
    </LazyMotion>
  );
}

/**
 * How a finished step is described, without a process detail in it.
 *
 * Was "finished clean (exit 0)", "exited 3", "was stopped by SIGTERM". An exit
 * code is the right answer to "what happened" only for a reader who already knows
 * that 0 means it worked, and this line is the summary of a `<details>` whose body
 * is the step's entire stdout: anybody who wants the code is one click from it,
 * printed by the step itself.
 *
 * The signal name went the same way, and with it this function's second argument.
 * A step killed by SIGTERM and a step that exited 3 are two different things to a
 * maintainer and the same thing to somebody watching a demo: it stopped, and the
 * output says why.
 */
function describeEnd(exitCode: number | null): string {
  if (exitCode === 0) return "finished";
  return exitCode === null ? "was stopped" : "did not finish";
}

/** Backtick spans become <code>, so fix commands read and copy as commands. */
function inlineCode(text: string): ReactNode {
  const parts = text.split("`");
  if (parts.length === 1) return text;
  return parts.map((part, index) =>
    index % 2 === 1 ? <code key={index}>{part}</code> : <Fragment key={index}>{part}</Fragment>,
  );
}
