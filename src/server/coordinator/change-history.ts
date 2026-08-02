import "server-only";

/**
 * Reading the board's change history back out of the ledger.
 *
 * The IO half of `change-ledger.ts`, kept apart from it so the body builder stays
 * pure and testable — the same split as `erasure.ts` against `erasure-engine.ts`.
 *
 * Nothing in obsel's reasoning calls this. It exists for the page, and that is
 * the property that keeps a durable history from becoming a mechanism: a record
 * that was never written, or written wrongly, costs a reader a row and cannot
 * change what obsel decides about anything.
 */

import { changeHeadFor, readChangesFor } from "@/src/server/datahub/documents";
import { FLOW_ID } from "@/src/server/datahub/urns";
import type { ChangeBody, ChangeHistory } from "./change-ledger";

// Re-exported so a server caller can take the shapes from the module it already
// imports. The page takes them from `change-ledger.ts`, which carries no
// `server-only` guard.
export type { ChangeEntry, ChangeHistory } from "./change-ledger";

/**
 * The most recent change records on this board, oldest first.
 *
 * A record whose body will not parse is returned with `body: null` rather than
 * dropped. Dropping it would make the history claim fewer decisions happened
 * than obsel recorded, and a gap that reads as "nothing happened here" is the
 * failure mode this whole feature exists to remove. The page shows it as a
 * record it cannot read, which is the truthful rendering.
 *
 * **The window ends at the head, not at the start, and that is a fix rather
 * than a preference.** This read used to take the first `WINDOW` records from
 * sequence 1. Under that, a board crossing the window stopped showing anything
 * new: the page kept rendering the same oldest records and every later decision
 * obsel made was invisible, with nothing on screen saying so. It was found on
 * 2026-08-02 when the live suite's own flow reached 223 records and four ledger
 * tests began failing, which is the only reason anyone noticed. A history
 * surface that silently stops reporting is the exact failure the ledger exists
 * to remove, so it reads the newest end.
 *
 * `sequence` is the record's real position in the ledger, taken from its id
 * rather than from its index here. A window that renumbered from 1 would tell a
 * reader this was the board's first decision when it was its two hundredth.
 */
const WINDOW = 200;

export async function readChanges(): Promise<ChangeHistory> {
  const head = await changeHeadFor(FLOW_ID);
  const from = Math.max(1, head - WINDOW + 1);
  const records = await readChangesFor(FLOW_ID, { from, limit: WINDOW });

  return {
    flowId: FLOW_ID,
    entries: records.map((record, index) => ({
      sequence: sequenceOf(record.id) ?? from + index,
      urn: `urn:li:document:obsel.change.${record.id}`,
      body: parseBody(record.body),
    })),
  };
}

/**
 * The sequence a record's id ends with, or null if it does not end with one.
 *
 * The id is `<flow slug>.<sequence>` and the slug can itself contain digits and
 * underscores, so this takes the last dot-separated part and nothing else.
 */
function sequenceOf(id: string): number | null {
  const last = id.split(".").pop() ?? "";
  if (!/^\d+$/.test(last)) return null;
  return Number(last);
}

function parseBody(raw: string): ChangeBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const body = parsed as Partial<ChangeBody>;
  // Shape-checked on the fields the page reads without asking first. Anything
  // less and one malformed record renders as a row of undefineds.
  if (body.event !== "marked" && body.event !== "cleared") return null;
  if (typeof body.at !== "string" || !Array.isArray(body.affected)) return null;
  return body as ChangeBody;
}
