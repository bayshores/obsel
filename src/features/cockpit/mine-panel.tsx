"use client";

/**
 * The door your own tables come in through.
 *
 * `joining-panel.tsx` is the door an agent joins through, and this is the door
 * for somebody who has just watched the demonstration and wants it to happen to
 * their own data. Until this panel the only route was the MCP walkthrough in
 * `docs/setup.md`: install a server, then hand it `register_task` as JSON with
 * the table names in it. Declaring a task is pure declaration, so a form is all
 * it ever needed.
 *
 * **A separate panel rather than a fold inside the joining panel**, even though
 * the README nests the two and nesting would have been cheaper in words. Read
 * the header of `joining-panel.tsx`: that panel exists because its contents were
 * a 17px line the owner of this repository did not know was there. Putting this
 * behind a second fold inside that one would repeat exactly the mistake that
 * file records fixing, two levels deep instead of one.
 *
 * **This panel writes, which nothing else on the board does directly.** It POSTs
 * to `/api/tasks/register`, the same route the MCP door's `register_task` calls,
 * with the same body. It does not hash, it does not read a file, and it does not
 * touch a fingerprint. Registering a task says what a task will read and write;
 * it makes no claim that any work has happened.
 */

import { useState } from "react";

import { BenchPanel } from "./bench-panel";
import { Panel } from "./mmux";
import { EMPTY_DRAFT, draftProblem, registration } from "./mine";
import type { MineDraft, MineTask, MineView } from "./mine";
import type { TaskRecord } from "@/src/server/coordinator/types";

import styles from "./mine.module.css";

/** What obsel said about the last attempt, and whether it was a refusal. */
interface Said {
  tone: "refused" | "landed";
  text: string;
}

export function MinePanel({ view, tasks }: { view: MineView; tasks: TaskRecord[] }) {
  /*
   * Derived until the reader disagrees, and then theirs. The idiom, and the
   * reason a bare `onToggle` is wrong, are both in `joining-panel.tsx`: React
   * sets `open` on the element after creating it, so mount is indistinguishable
   * from a click and the panel would record a preference nobody expressed.
   */
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? view.expanded;

  const [draft, setDraft] = useState<MineDraft>(EMPTY_DRAFT);
  const [sending, setSending] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);

  const problem = draftProblem(draft, tasks);
  const untouched = draft.name === "" && draft.reads === "" && draft.writes === "";

  async function register(): Promise<void> {
    if (problem !== null) {
      setSaid({ tone: "refused", text: problem });
      return;
    }
    setSending(true);
    setSaid(null);
    try {
      const response = await fetch("/api/tasks/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(registration(draft)),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const detail =
          typeof body === "object" && body !== null && "error" in body
            ? String((body as { error: unknown }).error)
            : `obsel answered ${response.status}`;
        setSaid({ tone: "refused", text: `obsel would not register it: ${detail}` });
        return;
      }
      /*
       * The form is cleared and nothing is added to a local list.
       *
       * `useSwarm` polls every second and the task appears below because
       * DataHub has it, which is the same discipline `guide-panel.tsx` keeps
       * with the launch button and for the same reason: an optimistic row is a
       * claim obsel has not verified. DataHub's graph store also lags its
       * aspect store by about a second (`docs/environment-findings.md` §11), so
       * a row that appeared instantly would be asserting lineage that is not
       * queryable yet.
       */
      setDraft(EMPTY_DRAFT);
      setSaid({ tone: "landed", text: "Registered. It appears on the graph once DataHub has it." });
      /*
       * Pinned open, and this was found by registering a task in a real browser
       * rather than by reading the code.
       *
       * `mine.ts` paints the form only on a board with nothing on it, so the
       * first successful registration flips that derivation to folded. The
       * `chosen ?? expanded` idiom does not save the reader here: at the moment
       * they opened the panel it was already open, so their choice matched the
       * derivation and nothing was recorded. One second later the poll returned
       * a board with one task on it and the panel shut itself, taking the
       * confirmation line and the new row with it, under somebody who was
       * almost certainly about to register the second half of their pipeline.
       *
       * Recording it here rather than loosening the toggle rule: the trigger is
       * an action the reader took, not a state obsel inferred, which is exactly
       * the distinction `joining-panel.tsx` says a bare `onToggle` cannot make.
       * Closing it by hand still hands control back to the derivation.
       */
      setChosen(true);
    } catch (cause) {
      setSaid({
        tone: "refused",
        text: `obsel could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    } finally {
      setSending(false);
    }
  }

  return (
    <Panel
      label="Bring your own data"
      title="bring your own data"
      /*
       * Absent while there is nothing of yours to count. The joining panel says
       * "nobody has joined yet" in the same slot, which is worth its words
       * because that panel is about whether a stranger arrived. This one is
       * about whether you have started, and a count of zero is what the empty
       * list below already says.
       */
      meta={view.mine.length > 0 ? `${view.mine.length} of yours` : undefined}
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
        {/* Three words, and they are the whole of what this panel costs a
            reader who does not open it. */}
        <summary className={styles.summary}>{open ? "hide this" : "add a task"}</summary>

        <div className={styles.body}>
          <p className={styles.intro}>
            Name a task, say which tables it reads and which it writes, and it joins the graph
            beside everything else. Your agent reports the work; obsel takes the fingerprint itself.
          </p>

          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              void register();
            }}
          >
            <Field
              label="task"
              value={draft.name}
              placeholder="clean_expenses"
              onChange={(name) => setDraft({ ...draft, name })}
            />
            <Field
              label="reads"
              value={draft.reads}
              placeholder="expenses_csv"
              onChange={(reads) => setDraft({ ...draft, reads })}
            />
            <Field
              label="writes"
              value={draft.writes}
              placeholder="clean_expenses"
              onChange={(writes) => setDraft({ ...draft, writes })}
            />
            <Field
              label="short name"
              value={draft.title}
              placeholder="Expense cleaner"
              onChange={(title) => setDraft({ ...draft, title })}
            />
            <p className={styles.hint}>Separate several tables with commas.</p>

            <div className={styles.actions}>
              <button
                type="submit"
                className={styles.submit}
                disabled={sending || untouched || problem !== null}
              >
                {sending ? "registering" : "register it"}
              </button>
            </div>
          </form>

          {/* The typed-in-progress problem, or obsel's own answer to the last
              attempt. Never both: a fresh keystroke is more current than a
              refusal from a second ago. */}
          {(problem !== null && !untouched) || said !== null ? (
            <p
              className={styles.said}
              data-tone={problem !== null && !untouched ? "refused" : (said?.tone ?? "landed")}
              role="status"
            >
              {problem !== null && !untouched ? problem : said?.text}
            </p>
          ) : null}

          {view.mine.length > 0 && <Yours view={view} />}

          <p className={styles.note}>
            A task appears here whether you added it above or an agent registered itself. obsel has
            no memory of which, because being on the board is the whole of what it knows.
          </p>
        </div>
      </details>
    </Panel>
  );
}

/** One labelled input. A wrapping label, so there is no id to keep unique. */
function Field({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (next: string) => void;
}) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

/**
 * Your tasks, and whether obsel has anything recorded for each.
 *
 * The tick is `aria-hidden` with the state in the row's own words, the same
 * decision the joining panel and the prerequisite checklist made: a screen
 * reader announcing "check mark" is not the same as announcing "reported".
 */
function Yours({ view }: { view: MineView }) {
  return (
    <ul className={styles.tasks} aria-label="Your own tables">
      {view.mine.map((task) => (
        <Your key={task.urn} task={task} />
      ))}
    </ul>
  );
}

/**
 * One of your tasks, with the bench folded behind it.
 *
 * Closed by default, and that is a budget decision as much as a layout one. A
 * board carrying several of your tasks would otherwise stack a grid of text
 * inputs per task, and the reader who came here to register a second one would
 * have to scroll past every bench to reach the form.
 *
 * Open state is per task and lives here rather than in `mine.ts`, because it is
 * a preference somebody expressed by clicking, not a fact about the swarm.
 * Everything derived from the board is recomputed every second in that module;
 * this is the one thing on the panel that is genuinely the reader's.
 */
function Your({ task }: { task: MineTask }) {
  const [open, setOpen] = useState(false);

  return (
    <li className={styles.task} data-reported={task.reported ? "true" : "false"}>
      <span className={styles.tick} aria-hidden="true">
        {task.reported ? "✓" : "○"}
      </span>
      <span className={styles.taskBody}>
        <span className={styles.taskName}>
          {task.title}
          {task.reported ? ": reported" : ": nothing reported yet"}
        </span>
        <span className={styles.taskFlow}>{flow(task.reads, task.writes)}</span>

        {task.outputs.length > 0 && (
          <>
            <button
              type="button"
              className={styles.reveal}
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              {/*
                Says what pressing it leads to, not what the panel is called.
                "Write its table yourself" is the offer: you are standing in for
                the agent, and the sentence has to make that plain before
                somebody types a table wondering what obsel will do with it.
              */}
              {open ? "hide the table" : "write its table yourself"}
            </button>
            {open &&
              task.outputs.map((output) => (
                <BenchPanel
                  key={output.urn}
                  taskUrn={task.urn}
                  tableName={output.name}
                  recorded={output.recorded}
                />
              ))}
          </>
        )}
      </span>
    </li>
  );
}

/**
 * `reads expenses_csv, writes clean_expenses`.
 *
 * The identifiers, not the humanised names `naming.ts` would give. This is the
 * one place on the board where that is right: these are the strings the reader
 * typed into the form, and the strings their agent passes to `report_complete`.
 * A row saying "reads expenses csv" would be unusable for the thing it is for.
 */
function flow(reads: readonly string[], writes: readonly string[]): string {
  const parts: string[] = [];
  if (reads.length > 0) parts.push(`reads ${reads.join(", ")}`);
  if (writes.length > 0) parts.push(`writes ${writes.join(", ")}`);
  return parts.length === 0 ? "declares no tables" : parts.join(", ");
}
