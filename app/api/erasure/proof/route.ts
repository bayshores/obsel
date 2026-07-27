import { NextResponse } from "next/server";
import { z } from "zod";

import { submitAttestation } from "@/src/server/coordinator/erasure-engine";
import { authorizeMutation } from "@/src/server/http/auth";

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
  const auth = authorizeMutation(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let parsed;
  try {
    parsed = Body.parse(await request.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid body";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const result = await submitAttestation(parsed.envelope, parsed.request);
    if (!result.accepted) {
      return NextResponse.json({ accepted: false, failures: result.failures }, { status: 422 });
    }
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "could not record the attestation";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
