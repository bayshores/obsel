import { NextResponse } from "next/server";

import { resetSwarm } from "@/src/server/coordinator/engine";
import { authorizeMutation } from "@/src/server/http/auth";

export const dynamic = "force-dynamic";

/**
 * Put the swarm back to its pre-run state, for a second demo take.
 *
 * Clears obsel's properties and the DataHub stale tag, which live on different
 * aspects — see `resetSwarm`. It deliberately does not delete the tasks: their
 * lineage edges are what the demo re-runs against.
 *
 * Gated: this takes every flag off the board at once. It is the demo's second
 * take, not a verdict about the work, but nothing reachable without a token
 * should be able to leave a page saying everything is fine.
 */
export async function POST(request: Request) {
  // `refuseUnauthorized` is not used here because this route's failures carry
  // `ok`, which the caller reads, and the shared refusal is a bare `{ error }`.
  const auth = authorizeMutation(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  // The one route whose failure body is not a bare `{ error }`: the page reads
  // `ok` off it. Left as it is, because narrowing it is an API change.
  try {
    return NextResponse.json({ ok: true, ...(await resetSwarm()) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "reset failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
