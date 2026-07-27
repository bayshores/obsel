/**
 * Your own tasks: what obsel has of them, and what a draft is still missing.
 *
 * Pure, like `joining.ts` and `guide.ts` beside it, and for the same reason.
 * There is no stored list of "the tasks I added through the form": a task is
 * yours because it is on the board and it is not obsel's own demonstration,
 * which is a fact re-derived from the swarm every second. So a task registered
 * from a terminal, from an MCP agent, or from this form all appear here
 * identically, and closing the browser forgets nothing.
 *
 * **The classifier is `isVisitor` from `joining.ts`, reused rather than
 * rewritten.** Its comment records why obsel's own work has to be the closed
 * set: the HTTP API takes short names and `datasetUrn` qualifies them under
 * `obsel_demo`, so a table you register lands in obsel's own namespace and a
 * namespace test would read your work as obsel's. Two copies of that rule would
 * be two answers to "whose task is this", and the panel would disagree with the
 * one above it about whether anybody had joined.
 *
 * Nothing here talks to the network. The panel POSTs to `/api/tasks/register`,
 * which is the same route the MCP door's `register_task` calls, and that route
 * remains the only thing that decides whether a registration is acceptable.
 * What this module does is refuse to send a draft that obsel would certainly
 * reject, so the reader is told by the form rather than by a 400.
 */

import { isVisitor } from "./joining";
import { shortName, taskTitle } from "./naming";
import type { TaskRecord } from "@/src/server/coordinator/types";

/**
 * What the register route accepts for a `title`, mirrored from the zod schema
 * in `app/api/tasks/register/route.ts`. The graph reserves box width from this,
 * which is why it is tight rather than merely bounded.
 */
export const TITLE_MAX = 60;

/**
 * The shape a table name has to have, checked here because a bad one does not
 * fail loudly anywhere else.
 *
 * `datasetUrn` in `src/server/datahub/urns.ts` interpolates this straight into
 * `urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.<name>,PROD)`, and both
 * `shortName` here and its Python twin recover the name by splitting on commas
 * and dots. A name containing either produces a URN that parses back as
 * something else entirely, and nothing in the stack rejects it: the entity is
 * created, the board shows a table with a truncated name, and lineage points at
 * a URN nobody can look up.
 *
 * The route does not enforce this today, so this is a convenience and not a
 * boundary. It is deliberately narrower than what DataHub would tolerate,
 * because every table obsel has ever handled is spelled this way.
 */
const TABLE_NAME = /^[a-z0-9][a-z0-9_]*$/;

/** A row of the form, exactly as typed. Strings, because inputs hold strings. */
export interface MineDraft {
  name: string;
  reads: string;
  writes: string;
  title: string;
}

export const EMPTY_DRAFT: MineDraft = { name: "", reads: "", writes: "", title: "" };

/** The body `/api/tasks/register` takes, once a draft has been read. */
export interface MineRegistration {
  name: string;
  reads: string[];
  writes: string[];
  title?: string;
}

/**
 * `"raw_orders, clean_orders"` to `["raw_orders", "clean_orders"]`.
 *
 * Commas and newlines both separate, because a reader pasting a column list out
 * of a spreadsheet gets newlines and should not have to care. Blanks are
 * dropped, so a trailing comma is not an error, and duplicates are collapsed:
 * declaring the same table twice is a typo in every case, and it would otherwise
 * become two identical lineage edges.
 */
export function parseNames(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[,\n]/)) {
    const trimmed = part.trim();
    if (trimmed !== "") seen.add(trimmed);
  }
  return [...seen];
}

/**
 * Why this draft cannot be sent, or null when it can.
 *
 * One message rather than a list, and it names the first thing to fix. A form
 * this small does not need a validation summary; it needs the next action.
 */
export function draftProblem(draft: MineDraft, existing: readonly TaskRecord[]): string | null {
  const name = draft.name.trim();
  if (name === "") return "Give the task a name, the way you would name a script.";
  if (!TABLE_NAME.test(name)) {
    return "A name can hold lowercase letters, digits and underscores, and starts with a letter or digit.";
  }
  if (existing.some((task) => task.name === name)) {
    return `There is already a task called ${name} on this board.`;
  }

  const writes = parseNames(draft.writes);
  /*
   * A task with no output cannot go stale and cannot make anything else stale,
   * so obsel would accept it and then have nothing to say about it forever.
   * The MCP tool refuses this too; the HTTP route does not.
   */
  if (writes.length === 0)
    return "Name the table this task writes. Without one obsel has nothing to watch.";

  const reads = parseNames(draft.reads);
  for (const table of [...reads, ...writes]) {
    if (!TABLE_NAME.test(table)) {
      return `${table} will not work as a table name. Lowercase letters, digits and underscores.`;
    }
  }
  /*
   * A task reading what it writes is a self-edge. `staleness.ts` carries a
   * visited set and terminates on a cycle, so this is not a hang: it is a task
   * that is its own upstream, which can never be told anything useful.
   */
  const both = writes.filter((table) => reads.includes(table));
  if (both.length > 0) return `${both[0]} cannot be both read and written by the same task.`;

  if (draft.title.trim().length > TITLE_MAX) {
    return `Keep the short name under ${TITLE_MAX} characters; the graph reserves box width for it.`;
  }
  return null;
}

/** The draft as the register route wants it. Call only when there is no problem. */
export function registration(draft: MineDraft): MineRegistration {
  const title = draft.title.trim();
  return {
    name: draft.name.trim(),
    reads: parseNames(draft.reads),
    writes: parseNames(draft.writes),
    ...(title === "" ? {} : { title }),
  };
}

/** One of your tasks, as the panel needs it. */
export interface MineTask {
  urn: string;
  /** The identifier, which is what `agents.run report --task` takes. */
  name: string;
  /** The human name, from what was registered or humanised from the identifier. */
  title: string;
  /** Short names, because a URN is not what a reader typed or would type. */
  reads: string[];
  writes: string[];
  /** obsel has a fingerprint for at least one output of this task. */
  reported: boolean;
}

export interface MineView {
  mine: MineTask[];
  /** Painted rather than folded. See the comment on the return value below. */
  expanded: boolean;
}

export interface MineInput {
  /**
   * Did the last swarm read succeed. Same flag `joining.ts` takes, for the same
   * reason: a failed read leaves `tasks` empty, which is indistinguishable from
   * a board nobody has registered anything on. Offering the form as though the
   * board were empty, under a headline saying obsel cannot see anything, would
   * invite a registration that is about to fail.
   */
  trusted: boolean;
  tasks: TaskRecord[];
}

export function mine(input: MineInput): MineView {
  const yours = input.trusted ? input.tasks.filter(isVisitor) : [];

  return {
    mine: yours.map((task) => ({
      urn: task.urn,
      name: task.name,
      title: taskTitle(task),
      reads: task.reads.map(shortName),
      writes: task.writes.map(shortName),
      /*
       * A recorded fingerprint, not `finishedAt`. A task can carry a finish
       * time from a run that reported no outputs at all, and this flag is asked
       * one question by the panel: has obsel got something to compare against
       * next time.
       */
      reported: Object.keys(task.fingerprints).length > 0,
    })),
    /*
     * Open only on a board with nothing whatsoever on it.
     *
     * That is the one reader who has nowhere else to go, and it is also the
     * only state where the extra prose is free. Every other state is folded,
     * including a board holding obsel's own demonstration, which is the state
     * the word ceiling in `e2e/cockpit.spec.ts` measures and the state the
     * board is in on camera. `joining.ts` explains the budget at more length.
     *
     * The heading and the count stay painted either way. The fold is about how
     * much prose is on screen, never about whether the door can be found.
     */
    expanded: input.trusted && input.tasks.length === 0,
  };
}
