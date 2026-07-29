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
 */
export async function POST(request: Request) {
  // Gated: this is the most destructive call obsel answers.
  const auth = authorizeMutation(request);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  try {
    return NextResponse.json({ ok: true, ...(await resetSwarm()) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "reset failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
