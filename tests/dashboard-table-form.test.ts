/**
 * The table form's pure half: what leaves the browser, and what it says it will do.
 *
 * Nothing here reaches the network or a hash. The fingerprint has exactly one
 * implementation, in `agents/fingerprint.py`, and the table form's job is to hand it
 * a table — so these tests are about the table that leaves and the sentence
 * shown beside it, and `tests/live/` is where a real report through a real
 * DataHub is proved.
 */

import { describe, expect, it } from "vitest";

import {
  benchColumn,
  benchDiff,
  benchLine,
  benchRow,
  blankTable,
  exampleTable,
  livingColumns,
  payload,
  recordedShape,
  reportedLine,
  tableProblem,
  withCell,
  withColumnAdded,
  withColumnDropped,
  withColumnRenamed,
  withRowAdded,
  withRowRemoved,
} from "@/src/features/dashboard/table-form/table-form";
import type { TableFormTable } from "@/src/features/dashboard/table-form/table-form";

/** A table built the way the panel builds one, so ids are real ids. */
function tableOf(names: string[], rows: string[][]): TableFormTable {
  const columns = names.map(benchColumn);
  return {
    columns,
    rows: rows.map((values) => {
      const cells: Record<string, string> = {};
      columns.forEach((column, index) => {
        cells[column.id] = values[index] ?? "";
      });
      return benchRow(cells);
    }),
  };
}

describe("what leaves the browser", () => {
  it("sends the column names and the values under them", () => {
    const table = tableOf(["a", "b"], [["1", "x"]]);
    expect(payload(table)).toEqual({ columns: ["a", "b"], rows: [{ a: 1, b: "x" }] });
  });

  it("keeps a column's values when the column is renamed", () => {
    /*
     * The single most interesting thing the table form can do and the first thing
     * anybody tries: rename a column and watch the schema hash move while the
     * content hash does not. That only holds if the values come with it, which
     * is why cells are keyed by column id and never by column name.
     */
    const table = tableOf(["amount"], [["42.50"]]);
    const renamed = withColumnRenamed(table, table.columns[0].id, "amount_usd");
    expect(payload(renamed)).toEqual({ columns: ["amount_usd"], rows: [{ amount_usd: 42.5 }] });
  });

  it("leaves a dropped column and its values out", () => {
    const table = tableOf(["a", "b"], [["1", "x"]]);
    const dropped = withColumnDropped(table, table.columns[1].id, true);
    expect(payload(dropped)).toEqual({ columns: ["a"], rows: [{ a: 1 }] });
  });

  it("puts a dropped column back with its values intact", () => {
    // The undo half. A drop that lost the values would make putting the column
    // back a content change nobody made.
    const table = tableOf(["a", "b"], [["1", "x"]]);
    const id = table.columns[1].id;
    const back = withColumnDropped(withColumnDropped(table, id, true), id, false);
    expect(payload(back)).toEqual({ columns: ["a", "b"], rows: [{ a: 1, b: "x" }] });
  });

  it("sends a number as a number so reformatting it is not a change", () => {
    /*
     * `canonicalise_numbers` in `agents/worker.py` exists because the same value
     * written 217 one run and 217.0 the next moved the content hash and obsel
     * reported a change nobody made. It only sees numbers. A table form that sent
     * every cell as text would sit on the far side of that fix, and typing a
     * trailing zero would flag the whole downstream.
     */
    expect(payload(tableOf(["n"], [["217.0"]])).rows[0].n).toBe(217);
    expect(payload(tableOf(["n"], [["217"]])).rows[0].n).toBe(217);
  });

  it("sends a non-numeric cell as the text that was typed", () => {
    expect(payload(tableOf(["d"], [["2026-07-01"]])).rows[0].d).toBe("2026-07-01");
  });

  it("sends an empty cell as nothing rather than as an empty string", () => {
    // `_serialise_row` in `agents/fingerprint.py` already reads a missing key as
    // null, so this agrees with it. "" would be a value of its own.
    expect(payload(tableOf(["a"], [[""]])).rows[0].a).toBeNull();
  });

  it("sends no rows when there are none, which is a real answer", () => {
    expect(payload({ columns: [benchColumn("a")], rows: [] })).toEqual({
      columns: ["a"],
      rows: [],
    });
  });
});

describe("what the tableForm refuses to send", () => {
  it("refuses a table with every column dropped", () => {
    const table = tableOf(["a"], [["1"]]);
    const dropped = withColumnDropped(table, table.columns[0].id, true);
    expect(tableProblem(dropped)).toContain("at least one column");
  });

  it("refuses a column with no name", () => {
    expect(tableProblem(blankTable())).toBe("Give every column a name.");
  });

  it("refuses two columns with the same name", () => {
    // `schema_fingerprint` hashes the sorted names, so a duplicate is a table
    // whose shape cannot be stated. The row values would collide too.
    expect(tableProblem(tableOf(["a", "a"], [["1", "2"]]))).toContain("both called a");
  });

  it("ignores a dropped column's name when judging the rest", () => {
    // A dropped column is not going to be sent, so an empty or duplicated name
    // on one must not block a table that is otherwise fine.
    const table = tableOf(["a", ""], [["1", ""]]);
    expect(tableProblem(table)).not.toBeNull();
    expect(tableProblem(withColumnDropped(table, table.columns[1].id, true))).toBeNull();
  });

  it("accepts the example table as it stands", () => {
    expect(tableProblem(exampleTable())).toBeNull();
    expect(livingColumns(exampleTable())).toHaveLength(3);
  });
});

describe("editing", () => {
  it("adds a column with no name, so the reader has to say what it is", () => {
    const added = withColumnAdded(tableOf(["a"], [["1"]]));
    expect(added.columns).toHaveLength(2);
    expect(added.columns[1].name).toBe("");
  });

  it("adds and removes rows without touching the columns", () => {
    const table = tableOf(["a"], [["1"]]);
    const grown = withRowAdded(table);
    expect(grown.rows).toHaveLength(2);
    expect(withRowRemoved(grown, grown.rows[0].id).rows).toHaveLength(1);
    expect(withRowRemoved(grown, grown.rows[0].id).columns).toEqual(table.columns);
  });

  it("writes a cell without disturbing its neighbours", () => {
    const table = tableOf(["a", "b"], [["1", "x"]]);
    const edited = withCell(table, table.rows[0].id, table.columns[0].id, "2");
    expect(payload(edited).rows[0]).toEqual({ a: 2, b: "x" });
  });
});

describe("what obsel already holds", () => {
  const dataset = "urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.clean_expenses,PROD)";

  it("reads the shape off the run detail", () => {
    const run = {
      runner: null,
      ms: null,
      outputs: { [dataset]: { rows: 3, columns: ["a", "b"] } },
    };
    expect(recordedShape(run, dataset)).toEqual({ rows: 3, columns: ["a", "b"] });
  });

  it("holds nothing for a table the last run did not report", () => {
    expect(recordedShape(null, dataset)).toBeNull();
    expect(recordedShape({ runner: null, ms: null, outputs: {} }, dataset)).toBeNull();
  });
});

describe("the line under the table", () => {
  it("says this is the first version when obsel holds nothing", () => {
    expect(benchLine(benchDiff(exampleTable(), null))).toContain("first version");
  });

  it("names a column that is leaving and one that is arriving", () => {
    const table = tableOf(["expense_id", "amount_usd"], [["1", "42.50"]]);
    const line = benchLine(benchDiff(table, { columns: ["expense_id", "amount"], rows: 1 }));
    expect(line).toBe(
      "This table loses the column amount and gains the column amount_usd. Anything built on it goes out of date.",
    );
  });

  it("says lost and gained rather than renamed", () => {
    /*
     * The same rule `changeLine` in `guide.ts` follows. A column leaving while
     * another arrives is indistinguishable from a drop plus an unrelated
     * addition, and the reader can draw that conclusion without obsel making
     * the claim.
     */
    const table = tableOf(["b"], [["1"]]);
    expect(benchLine(benchDiff(table, { columns: ["a"], rows: 1 }))).not.toContain("renamed");
  });

  it("declines to guess whether the values moved", () => {
    // obsel holds a hash of the values, and a hash does not run backwards. The
    // honest sentence hands the question to obsel rather than answering it, and
    // must not read as "nothing changed".
    const table = tableOf(["a"], [["999"]]);
    const line = benchLine(benchDiff(table, { columns: ["a"], rows: 1 }));
    expect(line).toBe(
      "Same columns, same number of rows. obsel compares the values and answers when you report.",
    );
  });

  it("states the row count when only that moved", () => {
    const table = tableOf(["a"], [["1"], ["2"]]);
    expect(benchLine(benchDiff(table, { columns: ["a"], rows: 1 }))).toContain(
      "Same columns, 2 rows instead of 1",
    );
  });

  it("agrees its noun with the number of columns that moved", () => {
    const table = tableOf(["a"], [["1"]]);
    const line = benchLine(benchDiff(table, { columns: ["a", "b", "c"], rows: 1 }));
    expect(line).toContain("loses the columns b, c");
  });
});

describe("obsel's answer, read back", () => {
  it("says nothing went out of date when nothing changed", () => {
    /*
     * The quiet answer, worded as carefully as the loud one. Anybody can flag
     * everything downstream of a write; refusing to flag a re-run that produced
     * the same table is the half that makes the flags worth reading.
     */
    expect(reportedLine({ changedOutputs: [], affected: [] })).toBe(
      "Reported. The table came out the same, so nothing went out of date.",
    );
  });

  it("separates a change that reached nothing from one that reached work", () => {
    expect(reportedLine({ changedOutputs: ["x"], affected: [] })).toContain(
      "nothing finished was built on it yet",
    );
    expect(reportedLine({ changedOutputs: ["x"], affected: ["a", "b"] })).toBe(
      "Reported. 2 pieces of finished work are now out of date.",
    );
  });

  it("agrees the noun and the verb with one affected task", () => {
    expect(reportedLine({ changedOutputs: ["x"], affected: ["a"] })).toBe(
      "Reported. 1 piece of finished work is now out of date.",
    );
  });

  it("treats a reply with no lists as nothing having changed rather than guessing", () => {
    // A reply that lost its keys must not be narrated as a cascade. The board
    // one panel away is what the reader should trust, and it re-reads DataHub.
    expect(reportedLine(null)).toContain("nothing went out of date");
  });
});
