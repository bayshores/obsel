/**
 * The table form: a table you edit by hand, and what obsel can honestly say about it
 * before you hand it over.
 *
 * Pure, like `guide.ts`, `joining.ts` and `your-data.ts` beside it. Nothing here
 * talks to the network and nothing here hashes anything — `table-form-panel.tsx`
 * POSTs to `/api/tasks/report`, which spawns `agents/report.py`, which is the
 * same `mcp_core.completion_body` path every agent's table goes down.
 * `src/server/runner/reporter.ts` records why the fingerprint has exactly one
 * implementation and why the browser is not allowed to be a second one.
 *
 * **What the table form is for.** Until it existed, the only way to watch obsel do
 * the thing obsel is for was to run four real agent sessions and wait a few
 * minutes, or to wire an agent in over MCP from a terminal. Somebody who has
 * neither could read the board but never make it move. The table form lets a person
 * stand in for the agent: you write the table, obsel hashes it, and whatever
 * was built on it is what gets flagged. Every call is the real one.
 *
 * **Why the columns are a control rather than a text field.** The chips are the
 * `columns` array that `schema_fingerprint` sorts and hashes. Dropping a chip
 * genuinely drops a column, so the reader is not pressing a button that
 * pretends a change happened; they are editing the thing the hash is computed
 * over. A "simulate a change" button would have been a stand-in for the one
 * event this whole repository is about, in the one place a newcomer is looking.
 */

import { agreeing } from "./naming";
import type { RunDetail } from "@/src/server/coordinator/types";

/**
 * One column, with an id that survives being renamed.
 *
 * The id is what row cells are keyed by, so typing a new name into a chip keeps
 * that column's values under it. Keying cells by the column NAME instead loses
 * every value in the column the moment somebody renames one — which is the
 * single most interesting thing the table form can do, and the first thing anybody
 * tries.
 */
export interface TableFormColumn {
  id: string;
  name: string;
  /**
   * Struck through rather than removed.
   *
   * A dropped column stays on screen dimmed and struck, and `payload` leaves it
   * out. Two reasons, and the second is the load-bearing one: a reader can undo
   * a drop they did not mean, and a reader can SEE what they took away at the
   * moment obsel tells them what it cost. A column that vanished on click would
   * make the flag that follows look like it came from nowhere.
   */
  dropped: boolean;
}

/** One row. Cells are keyed by column id, never by column name. */
export interface TableFormRow {
  id: string;
  cells: Record<string, string>;
}

export interface TableFormTable {
  columns: TableFormColumn[];
  rows: TableFormRow[];
}

/**
 * Ids that do not need a random source.
 *
 * A counter rather than `crypto.randomUUID()`, because these are keys for a list
 * of at most a handful of columns in one browser tab. They never leave the
 * page: `payload` sends names and values, never an id.
 */
let nextId = 0;
function freshId(prefix: string): string {
  nextId += 1;
  return `${prefix}${nextId}`;
}

export function benchColumn(name: string): TableFormColumn {
  return { id: freshId("c"), name, dropped: false };
}

export function benchRow(cells: Record<string, string> = {}): TableFormRow {
  return { id: freshId("r"), cells };
}

/**
 * What a task's table starts as when obsel has never seen one.
 *
 * Three named columns and three filled rows, and it is offered rather than
 * imposed: `table-form-panel.tsx` puts it behind a button labelled as an example.
 * The distinction matters. A table obsel silently invented and then hashed
 * would put a content fingerprint on the board that stands for nothing anybody
 * wrote, and the reader would have no way to know that is what they were
 * looking at.
 *
 * The shape is deliberately the smallest one that can demonstrate all three
 * things the fingerprint promises: rename a column and the schema half moves
 * while the content half does not; edit one value and the reverse; change
 * nothing and neither moves. Two columns could not show a rename that leaves
 * content alone as convincingly, and four is more typing for no more meaning.
 */
export function exampleTable(): TableFormTable {
  const id = benchColumn("expense_id");
  const amount = benchColumn("amount");
  const spent = benchColumn("spent_on");
  return {
    columns: [id, amount, spent],
    rows: [
      benchRow({ [id.id]: "1", [amount.id]: "42.50", [spent.id]: "2026-07-01" }),
      benchRow({ [id.id]: "2", [amount.id]: "17.00", [spent.id]: "2026-07-01" }),
      benchRow({ [id.id]: "3", [amount.id]: "88.25", [spent.id]: "2026-07-02" }),
    ],
  };
}

/** A table with one blank column and one blank row, for somebody typing their own. */
export function blankTable(): TableFormTable {
  const first = benchColumn("");
  return { columns: [first], rows: [benchRow({ [first.id]: "" })] };
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

export function withColumnAdded(table: TableFormTable): TableFormTable {
  return { ...table, columns: [...table.columns, benchColumn("")] };
}

export function withColumnRenamed(table: TableFormTable, id: string, name: string): TableFormTable {
  return {
    ...table,
    columns: table.columns.map((column) => (column.id === id ? { ...column, name } : column)),
  };
}

export function withColumnDropped(
  table: TableFormTable,
  id: string,
  dropped: boolean,
): TableFormTable {
  return {
    ...table,
    columns: table.columns.map((column) => (column.id === id ? { ...column, dropped } : column)),
  };
}

export function withCell(
  table: TableFormTable,
  rowId: string,
  columnId: string,
  value: string,
): TableFormTable {
  return {
    ...table,
    rows: table.rows.map((row) =>
      row.id === rowId ? { ...row, cells: { ...row.cells, [columnId]: value } } : row,
    ),
  };
}

export function withRowAdded(table: TableFormTable): TableFormTable {
  return { ...table, rows: [...table.rows, benchRow()] };
}

export function withRowRemoved(table: TableFormTable, id: string): TableFormTable {
  return { ...table, rows: table.rows.filter((row) => row.id !== id) };
}

/** The columns that will actually be sent, in the order they are shown. */
export function livingColumns(table: TableFormTable): TableFormColumn[] {
  return table.columns.filter((column) => !column.dropped);
}

// ---------------------------------------------------------------------------
// Handing it over
// ---------------------------------------------------------------------------

/** The table as `/api/tasks/report` takes it, and as an agent would send it. */
export interface TableFormPayload {
  columns: string[];
  rows: Record<string, unknown>[];
}

/**
 * A typed cell as the value an agent would have sent.
 *
 * Numbers are parsed out of the text, and this is not cosmetic. `worker.py`'s
 * `canonicalise_numbers` runs over every table before it is hashed, so that the
 * same value written `217` one run and `217.0` the next does not move the
 * content hash — a false alarm obsel measured and fixed. That machinery only
 * sees numbers. Sending every cell as a string would put the table form on the far
 * side of it, where `42.50` and `42.5` are two different tables, and the reader
 * would get a flag for reformatting a number.
 *
 * An empty cell is `null` rather than `""`, because it is the absence of a
 * value and `_serialise_row` in `agents/fingerprint.py` already reads a missing
 * key as null. Sending `""` would make a blank cell a value of its own.
 */
function cellValue(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  // `Number("")` is 0 and `Number(" ")` is 0, both already excluded above.
  // Infinity and NaN are not JSON values, so they stay text.
  const asNumber = Number(trimmed);
  return Number.isFinite(asNumber) && trimmed !== "" ? asNumber : text;
}

/**
 * The table, ready to hand over. Call only when `tableProblem` says null.
 *
 * Dropped columns are gone and their values go with them, which is what
 * dropping a column from a table means.
 */
export function payload(table: TableFormTable): TableFormPayload {
  const columns = livingColumns(table);
  return {
    columns: columns.map((column) => column.name.trim()),
    rows: table.rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const column of columns) out[column.name.trim()] = cellValue(row.cells[column.id] ?? "");
      return out;
    }),
  };
}

/**
 * Why this table cannot be handed over, or null when it can.
 *
 * One message naming the first thing to fix, the same shape and for the same
 * reason as `draftProblem` in `your-data.ts`: a table form this small needs the next
 * action, not a validation summary. The real guards are still downstream —
 * `_validate_table` in `agents/mcp_core.py` refuses the same tables at the
 * door every agent comes through — and what this buys is being told by the
 * table instead of by a 422.
 */
export function tableProblem(table: TableFormTable): string | null {
  const columns = livingColumns(table);
  if (columns.length === 0) {
    return "Keep at least one column. obsel hashes rows by column, so a table with none hashes nothing.";
  }
  const names = columns.map((column) => column.name.trim());
  if (names.some((name) => name === "")) return "Give every column a name.";
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) return `Two columns are both called ${name}. Give them different names.`;
    seen.add(name);
  }
  return null;
}

// ---------------------------------------------------------------------------
// What obsel already has
// ---------------------------------------------------------------------------

/**
 * The shape obsel recorded for this table last time, when it recorded one.
 *
 * From `run.outputs`, which is what the completing agent said came out. obsel
 * stores the fingerprint of the values and NOT the values, so this can say how
 * many rows and which columns and can never say what was in them. Every
 * sentence built on it below is careful to claim only the half that is known.
 */
export interface RecordedShape {
  columns: string[];
  rows: number;
}

export function recordedShape(run: RunDetail | null, datasetUrn: string): RecordedShape | null {
  const shape = run?.outputs?.[datasetUrn];
  if (shape === undefined) return null;
  return { columns: [...shape.columns], rows: shape.rows };
}

/**
 * What is about to differ, as far as the board can see from here.
 *
 * **Columns only, and the omission is the honest part.** obsel keeps two
 * hashes: one over the column names, one over the values. The names are on
 * screen, so a column added or dropped can be named before anything is sent.
 * The values are not — obsel holds a hash of them and a hash cannot be run
 * backwards — so the table form does not guess whether the content moved, and says
 * so rather than leaving the reader to assume silence means "nothing changed".
 */
export interface TableFormDiff {
  added: string[];
  removed: string[];
  rowsBefore: number;
  rowsAfter: number;
}

export function benchDiff(
  table: TableFormTable,
  recorded: RecordedShape | null,
): TableFormDiff | null {
  if (recorded === null) return null;
  const now = livingColumns(table).map((column) => column.name.trim());
  const before = new Set(recorded.columns);
  const after = new Set(now);
  return {
    added: now.filter((name) => !before.has(name)),
    removed: recorded.columns.filter((name) => !after.has(name)),
    rowsBefore: recorded.rows,
    rowsAfter: table.rows.length,
  };
}

/**
 * The one line under the table: what handing this over would do.
 *
 * Three shapes, because one sentence cannot say all three truthfully:
 *
 * - **Nothing recorded yet** — there is no comparison to describe. This is the
 *   first version, and saying anything about change would be inventing a
 *   baseline.
 * - **Columns moved** — they are named, because naming them is the whole
 *   difference between an actionable mark and an alarm.
 * - **Columns are the same** — the row count is stated if it moved, and then
 *   the sentence hands the question back rather than answering it: obsel
 *   compares the values, and the table form genuinely does not know the answer until
 *   obsel says.
 *
 * Says "lost" and "gained", never "renamed", the same rule `changeLine` in
 * `guide.ts` follows: a column leaving while another arrives is indistinguishable
 * from a drop plus an unrelated addition, and the reader can draw that
 * conclusion without obsel asserting it.
 */
export function benchLine(diff: TableFormDiff | null): string {
  if (diff === null) {
    return "obsel has nothing recorded for this table yet, so this is the first version of it.";
  }

  const noun = (names: readonly string[]): string =>
    `${agreeing(names.length, "the column", "the columns")} ${names.join(", ")}`;
  const lost = diff.removed.length > 0 ? `loses ${noun(diff.removed)}` : null;
  const gained = diff.added.length > 0 ? `gains ${noun(diff.added)}` : null;
  const both = [lost, gained].filter((part): part is string => part !== null).join(" and ");

  if (both !== "") {
    return `This table ${both}. Anything built on it goes out of date.`;
  }

  if (diff.rowsAfter !== diff.rowsBefore) {
    return `Same columns, ${diff.rowsAfter} ${agreeing(diff.rowsAfter, "row")} instead of ${diff.rowsBefore}. obsel compares the values and answers when you report.`;
  }
  return "Same columns, same number of rows. obsel compares the values and answers when you report.";
}

/**
 * obsel's own answer to a report, in one sentence built from its own counts.
 *
 * Reads `changedOutputs` and `affected` off the coordination reply rather than
 * re-deriving anything: those lists are the coordinator's decision, and a
 * second account of them computed in the browser could disagree with the board
 * one panel away.
 *
 * The quiet answer gets words as careful as the loud one. "Nothing went out of
 * date" is obsel's good outcome and the harder half of its claim — anybody can
 * flag everything downstream of a write, and refusing to flag a re-run that
 * produced the same table is the part that makes the flags worth reading.
 */
export function reportedLine(coordination: unknown): string {
  const reply = coordination as { changedOutputs?: unknown; affected?: unknown } | null;
  const changed = Array.isArray(reply?.changedOutputs) ? reply.changedOutputs.length : 0;
  const affected = Array.isArray(reply?.affected) ? reply.affected.length : 0;

  if (changed === 0) {
    return "Reported. The table came out the same, so nothing went out of date.";
  }
  if (affected === 0) {
    return "Reported. The table changed, and nothing finished was built on it yet.";
  }
  return `Reported. ${affected} ${agreeing(affected, "piece")} of finished work ${agreeing(affected, "is", "are")} now out of date.`;
}
