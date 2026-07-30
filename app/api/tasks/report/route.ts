import { NextResponse } from "next/server";
import { z } from "zod";

import { runReport } from "@/src/server/runner/reporter";
import { parseBody } from "@/src/server/http/route";

export const dynamic = "force-dynamic";

/**
 * One table, exactly as `agents/mcp_core.py` validates it at the MCP door.
 *
 * The shapes agree on purpose: a table typed at the table form and a table handed
 * over by an agent are the same thing to obsel, and `_validate_table` is the
 * real guard either way. What this buys is a 400 with a readable message
 * instead of a spawned process that refuses, which is faster and says the same.
 *
 * `rows` may be empty. That is a real answer — a task that genuinely produced
 * no rows produced no rows — and `mcp_core` accepts it, so this must too.
 */
const Table = z.object({
  columns: z.array(z.string().min(1)).min(1),
  rows: z.array(z.record(z.string(), z.unknown())),
});

const Body = z.object({
  taskUrn: z.string().min(1),
  // Keyed by SHORT table name. `resolve_outputs` refuses any table the task did
  // not declare it writes, which is the check that matters and is not repeated
  // here: obsel's record of the task is the only thing that can answer it.
  outputs: z.record(z.string().min(1), Table),
});

/**
 * Report a table on behalf of the person who typed it.
 *
 * This is the table form's one write, and it is the same write an agent makes: it
 * spawns `agents/report.py`, which hashes through `mcp_core.completion_body`
 * and POSTs `/api/tasks/complete`. The browser never computes a fingerprint —
 * `src/server/runner/reporter.ts` records why there is exactly one
 * implementation of it and why this costs a process.
 *
 * **There is deliberately no counterpart that clears anything.** Reporting work
 * is the only thing offered here, and what obsel concludes from the report is
 * obsel's. A route that took a task and marked it fresh would be a route for
 * silencing the one thing obsel is for.
 */
export async function POST(request: Request) {
  const body = await parseBody(request, Body);
  if (!body.ok) return body.response;
  const parsed = body.body;

  // This server's own address, from the URL Next resolved rather than a header
  // a client typed. The child reports back here; `reporter.ts` says why.
  const outcome = await runReport(parsed, new URL(request.url).origin);
  if (!outcome.ok) {
    return NextResponse.json(
      { error: outcome.error, ...(outcome.fix ? { fix: outcome.fix } : {}) },
      { status: outcome.status },
    );
  }
  return NextResponse.json({
    ok: true,
    coordination: outcome.coordination,
    computedFingerprints: outcome.computedFingerprints,
  });
}
