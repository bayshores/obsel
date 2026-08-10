import { NextResponse } from "next/server";

import { erasureEvidence } from "@/src/server/coordinator/erasure-engine";
import { refuseUnauthorized } from "@/src/server/http/route";

export const dynamic = "force-dynamic";

/**
 * The evidence behind one request, as a single file somebody can check without
 * obsel: the signed envelopes, the registry, the challenges obsel issued, the
 * lineage the closure check was made against, and obsel's own answer beside them.
 *
 * `scripts/verify-erasure-evidence.mjs` is what reads it. That script imports the
 * same `attestation.ts` and `erasure.ts` this server runs, so there is one
 * implementation of verification rather than two that can drift — and it still
 * checks something this server does not: obsel stamps `signatureVerified` from
 * the ledger on every read and never redoes the arithmetic, so a re-verification
 * outside the process is the only thing that tests that boundary.
 *
 * **Read-only, and nothing here can change a state.** Same as the report route
 * beside it, and for the same reason: there is no route that marks an asset
 * covered.
 *
 * **Gated, unlike that report route, and the difference is the point.** The
 * report carries no identifiers because obsel builds it and can leave them out.
 * A bundle carries DSSE payloads, and a direct attestation's payload holds the
 * predicate its attestor executed, identifiers and all. Those bytes are what the
 * signature covers: redacting them would destroy the thing the recipient is
 * being asked to check. So obsel strips the one identifier list it owns — the
 * request's, replaced by digests, which is all the predicate check needs — and
 * treats what remains as evidence handed to a named recipient rather than as
 * something to publish. `authorizeMutation` is the gate because it is the only
 * one obsel has; that it is named for mutations is a fact about the helper, not
 * about this route.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const refusal = refuseUnauthorized(request);
  if (refusal) return refusal;

  const { id } = await context.params;
  try {
    return NextResponse.json(await erasureEvidence(id));
  } catch (error) {
    const message = error instanceof Error ? error.message : "could not read the request";
    const missing = message.includes("no erasure request");
    return NextResponse.json({ error: message }, { status: missing ? 404 : 500 });
  }
}
