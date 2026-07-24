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

import { Fragment, useState } from "react";
import type { ReactNode } from "react";

import { PulseDot } from "./mmux";
import { formatDuration } from "./progress";
import { STEP_NAME } from "./guide";
import type { GuideView } from "./guide";
import type { DemoActivity, DemoStep } from "@/src/server/runner/types";

import styles from "./guide.module.css";

/** How many of the step's own lines stay visible without opening the full log. */
const TAIL_LINES = 8;

export function GuidePanel({
  view,
  activity,
  activityError,
}: {
  view: GuideView;
  activity: DemoActivity | null;
  activityError: string | null;
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
    <section className={styles.headliner} aria-label="What just happened">
      {view.attention !== null && (
        <p className={styles.attention} role="status">
          {inlineCode(view.attention)}
        </p>
      )}
      {refused !== null && (
        <p className={styles.attention} role="status">
          {inlineCode(refused)}
        </p>
      )}

      <h2 className={styles.headline}>{view.headline}</h2>
      {view.subline !== null && <p className={styles.subline}>{inlineCode(view.subline)}</p>}

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
            <li key={check.name} className={styles.note} data-done={check.done ? "true" : "false"}>
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
            </li>
          ))}
        </ul>
      )}

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

          A finished step's whole stdout is hundreds of lines of real Codex
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

        {activityError !== null && (
          <p className={styles.aside}>
            obsel could not read what the demo is doing ({activityError}), so the buttons may refuse
            until it can. The board below is unaffected.
          </p>
        )}
      </div>

      {/* Last in the DOM as well as on screen: read what happened, then choose
          what to do about it. */}
      {view.actions.length > 0 && (
        <div className={styles.actions}>
          {view.actions.map((action) => (
            <button
              key={action.step}
              type="button"
              className={styles.action}
              disabled={launching}
              onClick={() => void launch(action.step)}
            >
              <span className={styles.actionLabel}>{action.label}</span>
              <span className={styles.actionDetail}>{action.detail}</span>
            </button>
          ))}
        </div>
      )}
    </section>
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
