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

import { recordedShape } from "../table-form/table-form";
import type { RecordedShape } from "../table-form/table-form";
import { isVisitor } from "../joining/joining";
import { shortName, taskTitle } from "../naming";
import type { TaskRecord } from "@/src/server/coordinator/types";

/**
 * What the register route accepts for a `title`, mirrored from the zod schema
 * in `app/api/tasks/register/route.ts`. The graph reserves box width from this,
 * which is why it is tight rather than merely bounded.
 */
const TITLE_MAX = 60;

/**
 * One segment of a name: what a task is called, and what each dotted part of a
 * table name has to be.
 *
 * **Duplicated from `NAME_PATTERN` in `src/server/datahub/urns.ts`, on purpose,
 * and `tests/dashboard-your-data.test.ts` asserts the two are identical.** This module
 * renders in the browser and obsel's architecture forbids browser code importing
 * server modules, which is a rule about dependency direction rather than about
 * how expensive the import would be. `naming.ts` duplicates `shortName` from
 * `staleness.ts` for the same reason, and `joining.ts` duplicates the taxi
 * namespace out of `agents/scale.py`; in both cases a test holds them together.
 *
 * The route is the boundary, not this. `datasetNameProblem` and `taskNameProblem`
 * in `urns.ts` refuse the same names, and `agents/mcp_core.py` refuses them at
 * the MCP door, so a name that gets past the form still meets the real guard.
 * What this buys is being told by the field instead of by a 400.
 */
const NAME_SEGMENT = /^[a-z0-9][a-z0-9_]*$/;

/**
 * Whether a table name is usable: one segment, or two separated by a dot.
 *
 * The namespace half matters and was missed on the first pass. `datasetUrn`
 * qualifies an unnamespaced name under `obsel_demo`, and obsel's own scale swarm
 * registers `obsel_taxi.clean_trips` already qualified, so the route accepts one
 * namespace segment. A form that refused a dot outright would refuse a name obsel
 * itself uses, and a client stricter than the server is a client that blocks
 * legitimate work while looking like a validation bug.
 */
function tableNameOk(name: string): boolean {
  const segments = name.split(".");
  return segments.length <= 2 && segments.every((segment) => NAME_SEGMENT.test(segment));
}

/** A row of the form, exactly as typed. Strings, because inputs hold strings. */
export interface YourDataDraft {
  name: string;
  reads: string;
  writes: string;
  title: string;
}

export const EMPTY_DRAFT: YourDataDraft = { name: "", reads: "", writes: "", title: "" };

/** The body `/api/tasks/register` takes, once a draft has been read. */
export interface YourDataRegistration {
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
export function draftProblem(draft: YourDataDraft, existing: readonly TaskRecord[]): string | null {
  const name = draft.name.trim();
  if (name === "") return "Give the task a name, the way you would name a script.";
  // A task name carries no namespace: `taskNameProblem` in `urns.ts` tests the
  // single segment, because this is interpolated into a DataJob URN rather than a
  // dataset one and there is nothing to qualify it under.
  if (!NAME_SEGMENT.test(name)) {
    return "A name can hold lowercase letters, digits and underscores, and starts with a letter or digit.";
  }
  if (existing.some((task) => task.name === name)) {
    return `There is already a task called ${name} in this pipeline.`;
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
    if (!tableNameOk(table)) {
      return `${table} will not work as a table name. Lowercase letters, digits and underscores, with at most one dotted namespace.`;
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
export function registration(draft: YourDataDraft): YourDataRegistration {
  const title = draft.title.trim();
  return {
    name: draft.name.trim(),
    reads: parseNames(draft.reads),
    writes: parseNames(draft.writes),
    ...(title === "" ? {} : { title }),
  };
}

/**
 * One table this task writes, as the table form needs it.
 *
 * The short name and the URN both, because they answer different questions and
 * neither derives the other here. `/api/tasks/report` is keyed by short name,
 * exactly as `report_complete` is at the MCP door, because that is what the
 * person typed. The URN is what obsel files a fingerprint under, so it is the
 * key `recorded` had to be looked up by.
 */
export interface YourDataOutput {
  name: string;
  urn: string;
  /** The shape obsel recorded last time, or null when it holds none. */
  recorded: RecordedShape | null;
}

/** One of your tasks, as the panel needs it. */
export interface YourDataTask {
  urn: string;
  /** The identifier, which is what an agent passes as its task name. */
  name: string;
  /** The human name, from what was registered or humanised from the identifier. */
  title: string;
  /** Short names, because a URN is not what a reader typed or would type. */
  reads: string[];
  writes: string[];
  /** The tables this task writes, each with what obsel holds for it. */
  outputs: YourDataOutput[];
  /** obsel has a fingerprint for at least one output of this task. */
  reported: boolean;
}

export interface YourDataView {
  yourData: YourDataTask[];
  /** Painted rather than folded. See the comment on the return value below. */
  expanded: boolean;
}

export interface YourDataInput {
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

export function yourData(input: YourDataInput): YourDataView {
  const yours = input.trusted ? input.tasks.filter(isVisitor) : [];

  return {
    yourData: yours.map((task) => ({
      urn: task.urn,
      name: task.name,
      title: taskTitle(task),
      reads: task.reads.map(shortName),
      writes: task.writes.map(shortName),
      outputs: task.writes.map((urn) => ({
        name: shortName(urn),
        urn,
        recorded: recordedShape(task.run, urn),
      })),
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
     * the board is in on camera. `joining.ts` explains the reasoning at more
     * length.
     *
     * The heading and the count stay painted either way. The fold is about how
     * much prose is on screen, never about whether the door can be found.
     */
    expanded: input.trusted && input.tasks.length === 0,
  };
}
