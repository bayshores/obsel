"use client";

/**
 * The door an outside agent joins through, and how far one has got.
 *
 * This was a `<details>` inside the guide's headliner: one 17px line reading
 * "Bring your own agent", closed, above the graph. Measured on the running
 * board at 1440 x 900 before it was replaced, it was 12px type in a 17px row.
 * The owner of this repository, who wrote the panel's contents, did not know it
 * was there, and asked why obsel had no way to help somebody connect. A door
 * nobody finds is not a door.
 *
 * It is a real panel now, in the reading order a judge follows: under the graph
 * they have just watched, above the numbers. `Panel` from `mmux.tsx` rather than
 * a hand-rolled surface, and the stock tick and copy affordances rather than new
 * ones, because the house style here is to restyle what exists.
 *
 * **The heading is always painted; the steps fold.** `joining.ts` decides which,
 * and its comment on `expanded` says why. The short version is that four steps
 * plus a command is more prose than a board showing obsel's own demonstration
 * can afford. What folding must never buy is invisibility, so it takes the
 * sentences and leaves the heading and the count.
 *
 * Tool names are written out. This is the panel where that is correct: a
 * visiting agent calls `register_task` and it has no other name. The
 * bare-identifier guard excludes this panel by its `aria-label` for that reason,
 * so the label is load bearing.
 */

import { useRef, useState } from "react";

import { Panel } from "./mmux";
import type { JoinView } from "./joining";

import styles from "./joining.module.css";

/** What each of obsel's tools is for, in the visiting agent's own voice. */
const TOOLS: readonly { name: string; what: string }[] = [
  { name: "check_freshness", what: "before working: are my inputs still trustworthy?" },
  { name: "register_task", what: "say what I read and what I write, once" },
  { name: "announce_start", what: "before writing, so work in flight is never flagged" },
  {
    name: "report_complete",
    what: "what I produced; obsel replies with what that broke or proved",
  },
  { name: "abandon_task", what: "hand the announcement back if I failed" },
  { name: "read_board", what: "which other agents are here, and how they are doing" },
  { name: "erasure_board", what: "what an erasure request still has nobody speaking for" },
  { name: "request_challenge", what: "the one-time value my attestation must be signed over" },
  { name: "submit_attestation", what: "hand over a signed claim; obsel verifies it or refuses" },
];

export function JoiningPanel({ view }: { view: JoinView }) {
  /*
   * Derived until the reader disagrees, and then theirs.
   *
   * The board re-renders every second. Handing `open` straight from the derived
   * view would slam a panel shut under somebody reading it, one second after
   * they opened it. So a choice that differs from the derivation is remembered.
   *
   * **It is remembered only while it differs, and that is the whole subtlety.**
   * The first version stored any `toggle` at all, and the panel then refused to
   * close when a read failed, which `e2e/cockpit.spec.ts` caught. `toggle` does
   * not mean "somebody clicked": React sets `open` on the DOM element after
   * creating it, the browser sees the default `false` become `true`, and fires
   * the event. Mount was therefore indistinguishable from a click, so the panel
   * recorded a preference nobody had expressed and then honoured it forever.
   *
   * Storing null when the new state already agrees with the derivation fixes it
   * exactly: React's own sync lands back on derived, and only a reader moving
   * the panel away from what obsel would have shown is held.
   */
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? view.expanded;

  return (
    <Panel
      label="Bring your own agent"
      title="bring your own agent"
      meta={view.waiting ? "nobody has joined yet" : `${view.done} of ${view.steps.length}`}
      tour="joining"
      style={{ marginTop: "var(--mm-space-md)" }}
      bodyStyle={{ padding: 0 }}
    >
      <details
        className={styles.fold}
        open={open}
        onToggle={(event) => {
          const next = event.currentTarget.open;
          setChosen(next === view.expanded ? null : next);
        }}
      >
        {/* Four words. Whatever else folds away, this heading is the part that
            must never be cut: it is the only sign the door is here. */}
        <summary className={styles.summary}>{open ? "hide this" : "how an agent joins"}</summary>

        <div className={styles.body}>
          <p className={styles.intro}>
            Any agent that speaks MCP can join. It says what it reads and what it writes, and its
            work appears on this board beside everyone else&apos;s.
          </p>

          {view.command !== null && <JoinCommand command={view.command} />}

          <Steps view={view} />

          <details className={styles.tools}>
            <summary className={styles.summary}>the nine tools obsel gives it</summary>
            <ul className={styles.toolList}>
              {TOOLS.map((tool) => (
                <li key={tool.name}>
                  <code>{tool.name}</code>
                  <span>{tool.what}</span>
                </li>
              ))}
            </ul>
          </details>

          <p className={styles.note}>
            Two things a visiting agent cannot do, on purpose: hash its own tables, and clear a
            flag. obsel hashes what it is handed, and a flag only comes off through redone work.
          </p>
        </div>
      </details>
    </Panel>
  );
}

/**
 * The four steps, with what obsel has actually seen.
 *
 * The tick is `aria-hidden` and each row says its own state in words, the same
 * decision the prerequisite checklist made: a screen reader announcing "check
 * mark" is not the same as announcing "done".
 */
function Steps({ view }: { view: JoinView }) {
  return (
    <ol className={styles.steps}>
      {view.steps.map((step) => (
        <li key={step.name} className={styles.step} data-done={step.done ? "true" : "false"}>
          <span className={styles.tick} aria-hidden="true">
            {step.done ? "✓" : "○"}
          </span>
          <span>
            <span className={styles.stepName}>
              {step.name}
              {step.done ? ": done" : ""}
            </span>
            <span className={styles.stepDetail}>{step.detail}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * This machine's real command, with the fallback path that embedded webviews
 * actually take.
 *
 * Found by clicking this button in one: no clipboard permission, so select the
 * command and ask the document to copy the selection. If even that refuses, the
 * selection itself is the fallback, and the reader finishes with one keystroke
 * instead of hand-selecting a path.
 */
function JoinCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const commandRef = useRef<HTMLElement>(null);

  async function copy(): Promise<void> {
    let landed = false;
    try {
      await navigator.clipboard.writeText(command);
      landed = true;
    } catch {
      const node = commandRef.current;
      if (node !== null) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        landed = document.execCommand("copy");
      }
    }
    if (landed) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div className={styles.command}>
      <code ref={commandRef}>{command}</code>
      <button type="button" className={styles.copy} onClick={() => void copy()}>
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}
