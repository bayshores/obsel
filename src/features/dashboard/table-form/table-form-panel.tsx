"use client";

/**
 * The table form on screen: your table, your hands, obsel's real answer.
 *
 * One of these appears under each of your own tasks in `your-data-panel.tsx`. It
 * POSTs to `/api/tasks/report`, which spawns `agents/report.py`, which hashes
 * through the same `mcp_core.completion_body` every agent's table goes through
 * and then calls obsel's own completion route. Nothing here is simulated and
 * nothing here is hashed: `src/server/runner/reporter.ts` records why the
 * fingerprint has exactly one implementation and why the browser is not it.
 *
 * **The draft lives in React state and nowhere else.** obsel keeps the hash of
 * a reported table and not its values, on purpose, so it cannot hand the table
 * back — and a table form that quietly re-seeded blank rows on reload would report a
 * content change the reader never made, which is the exact false alarm this
 * repository is built to never raise. When the values are gone the panel says
 * they are gone, rather than guessing at them.
 */

import { useState } from "react";

import {
  benchColumn,
  benchDiff,
  benchLine,
  benchRow,
  blankTable,
  exampleTable,
  livingColumns,
  payload,
  reportedLine,
  tableProblem,
  withCell,
  withColumnAdded,
  withColumnDropped,
  withColumnRenamed,
  withRowAdded,
  withRowRemoved,
} from "./table-form";
import type { TableFormTable, RecordedShape } from "./table-form";
import { agreeing } from "../naming";
import { TOKEN_HINT, authHeader } from "../token/use-token";

import styles from "./table-form.module.css";

/** What obsel said about the last report, and how it should read. */
interface Said {
  tone: "refused" | "landed" | "flagged";
  text: string;
  /** A command that fixes a broken machine, when obsel handed one over. */
  fix?: string;
}

export function TableFormPanel({
  taskUrn,
  tableName,
  recorded,
}: {
  taskUrn: string;
  /**
   * The SHORT name, which is the key `/api/tasks/report` takes — the same key
   * `report_complete` takes at the MCP door, because it is what the person
   * typed. The dataset URN is not needed here: `your-data.ts` has already looked the
   * recorded shape up by it, and `resolve_outputs` in `agents/mcp_core.py` maps
   * this name back to the URN off obsel's own record of what the task declared,
   * which is the only place that mapping can be decided.
   */
  tableName: string;
  /** What obsel recorded for this table last time, or null if it has none. */
  recorded: RecordedShape | null;
}) {
  /*
   * Seeded once, from what obsel holds.
   *
   * A lazy initialiser, so this runs on mount and never again: re-seeding from
   * `recorded` on a later render would throw away what the reader had typed
   * one second after they reported, when the poll brought the new shape back.
   */
  const [table, setTable] = useState<TableFormTable>(() => seed(recorded));
  const [sending, setSending] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);

  const problem = tableProblem(table);
  const columns = livingColumns(table);
  const diff = benchDiff(table, recorded);

  async function report(): Promise<void> {
    if (problem !== null) {
      setSaid({ tone: "refused", text: problem });
      return;
    }
    setSending(true);
    setSaid(null);
    try {
      const response = await fetch("/api/tasks/report", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify({ taskUrn, outputs: { [tableName]: payload(table) } }),
        // The mutation ceiling `agents/worker.py` explains, not a read timeout:
        // obsel answers a completion only once the whole traversal is written
        // and confirmed by DataHub, and a loaded stack has genuinely outrun a
        // shorter client while the server was still finishing the work.
        signal: AbortSignal.timeout(300_000),
      });
      const body: unknown = await response.json().catch(() => null);
      const read = (key: string): string | undefined => {
        if (typeof body !== "object" || body === null || !(key in body)) return undefined;
        const value = (body as Record<string, unknown>)[key];
        return typeof value === "string" ? value : undefined;
      };

      if (!response.ok) {
        const refusal = read("error") ?? `obsel answered ${response.status}`;
        setSaid({
          tone: "refused",
          // obsel's own sentence says a token is required; the hint says where
          // the board keeps one, which obsel has no way to know. It is not a
          // `fix`: that field renders as a command to run in a terminal.
          text: response.status === 401 ? `${refusal}. ${TOKEN_HINT}` : refusal,
          fix: read("fix"),
        });
        return;
      }

      const coordination =
        typeof body === "object" && body !== null && "coordination" in body
          ? (body as { coordination: unknown }).coordination
          : null;
      const affected = Array.isArray((coordination as { affected?: unknown })?.affected)
        ? ((coordination as { affected: unknown[] }).affected.length as number)
        : 0;
      /*
       * Nothing is cleared and nothing is added to a local list. The board polls
       * once a second and the graph repaints because DataHub holds the new
       * state, which is the same discipline `your-data-panel.tsx` and
       * `guide-panel.tsx` keep with their own writes: an optimistic repaint is a
       * claim obsel has not verified, and DataHub's graph store lags its aspect
       * store by about a second (`docs/environment-findings.md` §11).
       *
       * The table itself deliberately survives the report. It is now the
       * baseline obsel holds, and the next thing the reader does is change one
       * cell and press the button again — which is the whole demonstration.
       */
      setSaid({ tone: affected > 0 ? "flagged" : "landed", text: reportedLine(coordination) });
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
    <div className={styles.tableForm}>
      <div className={styles.head}>
        <span className={styles.table}>{tableName}</span>
        <span className={styles.held}>{heldLine(recorded)}</span>
      </div>

      <div className={styles.scroller}>
        <table className={styles.grid}>
          {/* Clipped away rather than absent. It is the accessible name for a
              grid whose column headers are text inputs, and the visible heading
              two lines above is not associated with the table in any way a
              screen reader can follow. `table-form.module.css` explains the idiom. */}
          <caption className={styles.caption}>
            The table {tableName}, as you are about to report it
          </caption>
          <thead>
            <tr>
              {table.columns.map((column) => (
                <th key={column.id} scope="col">
                  <span className={styles.chip} data-dropped={column.dropped ? "true" : "false"}>
                    <input
                      type="text"
                      className={styles.chipName}
                      value={column.name}
                      placeholder="name"
                      spellCheck={false}
                      autoComplete="off"
                      aria-label={`column ${column.name || "with no name yet"}`}
                      disabled={column.dropped}
                      onChange={(event) =>
                        setTable(withColumnRenamed(table, column.id, event.target.value))
                      }
                    />
                    <button
                      type="button"
                      className={styles.chipDrop}
                      // The label says which way the click goes, because the
                      // glyph alone cannot: a struck-through column and a live
                      // one carry the same control in opposite directions.
                      aria-label={
                        column.dropped
                          ? `put the column ${column.name} back`
                          : `drop the column ${column.name}`
                      }
                      title={column.dropped ? "put it back" : "drop this column"}
                      onClick={() => setTable(withColumnDropped(table, column.id, !column.dropped))}
                    >
                      {column.dropped ? "+" : "✕"}
                    </button>
                  </span>
                </th>
              ))}
              <th scope="col">
                <button
                  type="button"
                  className={styles.chipDrop}
                  aria-label="add a column"
                  title="add a column"
                  onClick={() => setTable(withColumnAdded(table))}
                >
                  + col
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, index) => (
              <tr key={row.id}>
                {table.columns.map((column) => (
                  <td key={column.id} data-dropped={column.dropped ? "true" : "false"}>
                    <input
                      type="text"
                      className={styles.cellInput}
                      value={row.cells[column.id] ?? ""}
                      spellCheck={false}
                      autoComplete="off"
                      aria-label={`${column.name || "unnamed column"}, row ${index + 1}`}
                      disabled={column.dropped}
                      onChange={(event) =>
                        setTable(withCell(table, row.id, column.id, event.target.value))
                      }
                    />
                  </td>
                ))}
                <td>
                  <button
                    type="button"
                    className={styles.rowDrop}
                    aria-label={`remove row ${index + 1}`}
                    title="remove this row"
                    // A table with no rows at all is a real answer and obsel
                    // accepts it, but it is never what somebody at the table form
                    // meant by clicking the last remove button.
                    disabled={table.rows.length === 1}
                    onClick={() => setTable(withRowRemoved(table, row.id))}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={styles.controls}>
        <button
          type="button"
          className={styles.report}
          disabled={sending || problem !== null}
          onClick={() => void report()}
        >
          {sending ? "reporting" : "report it"}
        </button>
        <button
          type="button"
          className={styles.minor}
          onClick={() => setTable(withRowAdded(table))}
        >
          + row
        </button>
        {/* Offered rather than imposed, and labelled as an example. `table-form.ts`
            records why: a table obsel invented and then hashed would put a
            content fingerprint on the board standing for nothing anybody
            wrote. */}
        <button
          type="button"
          className={styles.minor}
          onClick={() => {
            setTable(exampleTable());
            setSaid(null);
          }}
        >
          use an example table
        </button>
      </div>

      {/* What handing it over would do, as far as the board can see from here.
          Suppressed while there is something to fix, because the fix is the
          more current sentence. */}
      <p className={styles.line}>
        {problem !== null
          ? problem
          : `${columns.length} ${agreeing(columns.length, "column")}, ${table.rows.length} ${agreeing(table.rows.length, "row")}. ${benchLine(diff)}`}
      </p>

      {said !== null && (
        <p className={styles.said} data-tone={said.tone} role="status">
          {said.text}
          {said.fix !== undefined && (
            <>
              {" "}
              Run this in a terminal: <code className={styles.fix}>{said.fix}</code>
            </>
          )}
        </p>
      )}
    </div>
  );
}

/**
 * The table the table form opens with.
 *
 * obsel's recorded columns when it has them, so somebody coming back to change
 * one thing starts from the shape obsel is actually comparing against. The rows
 * come up blank because obsel does not have them — it holds a hash of the
 * values, and a hash does not run backwards — and `heldLine` says so out loud
 * beside the grid rather than letting blank cells read as an empty table.
 *
 * A blank single-column table otherwise, not the example. The example is a
 * button, because obsel inventing three rows and then hashing them would put a
 * fingerprint on the board that stands for nothing anybody wrote.
 */
function seed(recorded: RecordedShape | null): TableFormTable {
  if (recorded === null || recorded.columns.length === 0) return blankTable();
  const columns = recorded.columns.map(benchColumn);
  const cells: Record<string, string> = {};
  for (const column of columns) cells[column.id] = "";
  return { columns, rows: [benchRow(cells)] };
}

/**
 * What obsel already holds, or that it holds nothing.
 *
 * States the row count and the column count and stops. It deliberately does not
 * say "3 rows" beside three blank rows on screen without explaining the gap,
 * because that reads as obsel having lost them: the values genuinely are not
 * obsel's to give back, and that is a property of storing a fingerprint rather
 * than a copy of somebody's data.
 */
function heldLine(recorded: RecordedShape | null): string {
  if (recorded === null) return "obsel holds nothing for this table yet";
  return `obsel holds ${recorded.columns.length} ${agreeing(recorded.columns.length, "column")} and the hash of ${recorded.rows} ${agreeing(recorded.rows, "row")}, never the values`;
}
