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

import { Panel, PulseDot } from "./mmux";
import { formatDuration } from "./progress";
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
            : `the launcher answered ${response.status}`;
        const fix =
          typeof body === "object" &&
          body !== null &&
          "fix" in body &&
          (body as { fix: unknown }).fix
            ? ` Fix: \`${String((body as { fix: unknown }).fix)}\``
            : "";
        setRefused(`Could not start \`${step}\`: ${detail}.${fix}`);
      }
      // On success nothing is set here — the next activity poll reports the
      // running step, which is the truth rather than an optimistic echo.
    } catch (cause) {
      setRefused(
        `Could not reach the launcher: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      setLaunching(false);
    }
  }

  const running = activity?.running ?? null;
  const last = activity?.lastResult ?? null;
  const log = activity?.log ?? [];

  return (
    <Panel
      title={`00 · guide — ${view.headline}`}
      meta="derived from the board every second · not a script"
    >
      <div className={styles.body}>
        {view.attention !== null && (
          <p className={`${styles.attention} ${styles.span}`} role="status">
            {inlineCode(view.attention)}
          </p>
        )}
        {refused !== null && (
          <p className={`${styles.attention} ${styles.span}`} role="status">
            {inlineCode(refused)}
          </p>
        )}

        <div className={styles.prose}>
          {view.narration.map((paragraph) => (
            <p key={paragraph} className={styles.narration}>
              {inlineCode(paragraph)}
            </p>
          ))}
        </div>

        <div className={styles.side}>
          {running !== null && (
            <>
              <span className={styles.running}>
                <PulseDot pulse color="var(--mm-green)" />
                {running.step} is live — its own output:
              </span>
              <pre className={styles.log}>{log.slice(-TAIL_LINES).join("\n")}</pre>
            </>
          )}

          {running === null && last !== null && (
            <details className={styles.disclosure}>
              <summary>
                {last.step} {describeEnd(last.exitCode, last.signal)} in{" "}
                {formatDuration(last.durationMs)} — output
              </summary>
              <pre className={styles.log}>{log.join("\n")}</pre>
            </details>
          )}

          {activityError !== null && (
            <p className={styles.aside}>
              the runner feed could not be read ({activityError}) — buttons may refuse until it
              returns; the board above is unaffected
            </p>
          )}
        </div>

        {/*
          Its own full-width row, beneath both columns, rather than stacked
          inside the narrow right-hand one.
          Measured: in a 386px column the two buttons sat one above the other
          with their detail lines wrapping three deep, making this panel 316px
          tall while 130px of the 806px prose column stood empty beside them —
          and pushing the stat ribbon that carries the measured detection time
          off the bottom of a 990px recording frame. Across the full width they
          sit side by side, and the panel is ~85px shorter for the same words.

          Last in the DOM as well as on screen: read what is happening, then
          choose what to do about it.
        */}
        {view.actions.length > 0 && (
          <div className={`${styles.actions} ${styles.span}`}>
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
      </div>
    </Panel>
  );
}

function describeEnd(exitCode: number | null, signal: string | null): string {
  if (exitCode === 0) return "finished clean (exit 0)";
  if (exitCode !== null) return `exited ${exitCode}`;
  return signal !== null ? `was stopped by ${signal}` : "was stopped";
}

/** Backtick spans become <code>, so fix commands read and copy as commands. */
function inlineCode(text: string): ReactNode {
  const parts = text.split("`");
  if (parts.length === 1) return text;
  return parts.map((part, index) =>
    index % 2 === 1 ? <code key={index}>{part}</code> : <Fragment key={index}>{part}</Fragment>,
  );
}
