import { NextResponse } from "next/server";
import { z } from "zod";

import { submitAttestation } from "@/src/server/coordinator/erasure-engine";
import { mutationRoute } from "@/src/server/http/route";

export const dynamic = "force-dynamic";

const Envelope = z.object({
  payloadType: z.string().min(1),
  payload: z.string().min(1),
  signatures: z.array(z.object({ keyid: z.string().min(1), sig: z.string().min(1) })),
});

const Body = z.object({
  request: z.string().min(1),
  envelope: Envelope,
});

/**
 * Submit a signed attestation.
 *
 * Named `proof` in the route path for the reader's benefit and nowhere in what
 * it returns: this accepts EVIDENCE, and obsel verifies its structure,
 * freshness, signature and version binding. It never verifies the underlying
 * data, because it has no warehouse credentials and never reads warehouse
 * data. An attestor is trusted; what obsel adds is that the trust is
 * attributable, scoped and revocable.
 *
 * A refused submission is a 422 with every failure listed, so an attestor
 * fixing one is told everything wrong at once. Nothing is written on a refusal,
 * deliberately: a ledger of failed attempts is an invitation to grind at the
 * signature check until something lands.
 */
export async function POST(request: Request) {
  return mutationRoute(request, Body, "could not record the attestation", async (body) => {
    const result = await submitAttestation(body.envelope, body.request);
    return result.accepted
      ? result
      : NextResponse.json({ accepted: false, failures: result.failures }, { status: 422 });
  });
}
