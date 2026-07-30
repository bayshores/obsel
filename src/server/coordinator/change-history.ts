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

import { readChangesFor } from "@/src/server/datahub/documents";
import { FLOW_ID } from "@/src/server/datahub/urns";
import type { ChangeBody, ChangeHistory } from "./change-ledger";

// Re-exported so a server caller can take the shapes from the module it already
// imports. The page takes them from `change-ledger.ts`, which carries no
// `server-only` guard.
export type { ChangeEntry, ChangeHistory } from "./change-ledger";

/**
 * Every change record on this board, oldest first.
 *
 * A record whose body will not parse is returned with `body: null` rather than
 * dropped. Dropping it would make the history claim fewer decisions happened
 * than obsel recorded, and a gap that reads as "nothing happened here" is the
 * failure mode this whole feature exists to remove. The page shows it as a
 * record it cannot read, which is the truthful rendering.
 */
export async function readChanges(): Promise<ChangeHistory> {
  const records = await readChangesFor(FLOW_ID);

  return {
    flowId: FLOW_ID,
    entries: records.map((record, index) => ({
      sequence: index + 1,
      urn: `urn:li:document:obsel.change.${record.id}`,
      body: parseBody(record.body),
    })),
  };
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
