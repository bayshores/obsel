import { NextResponse } from "next/server";
import { z } from "zod";

import { openErasureRequest } from "@/src/server/coordinator/erasure-engine";
import { authorizeMutation } from "@/src/server/http/auth";

export const dynamic = "force-dynamic";

const Body = z.object({
  /** Optional: obsel mints one when the caller has no case reference of its own. */
  request: z.string().min(1).optional(),
  /**
   * The subject key values. Every attestation must have searched for all of
   * them, so a request that under-states the identifier set produces answers
   * that are structurally valid and narrower than the question being asked.
   */
  identifiers: z.array(z.string().min(1)).min(1),
  /** Assets known to hold the subject directly. The walk starts here. */
  seeds: z.array(z.string().min(1)).min(1),
  hops: z.number().int().min(1).max(6).optional(),
});

/**
 * Open an erasure request and report what it reaches.
 *
 * Everything found starts UNPROVEN, which is the point rather than a
 * placeholder: the list of assets nobody has spoken for is the thing a data
 * protection officer has never been handed.
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
    return NextResponse.json(await openErasureRequest(parsed));
  } catch (error) {
    const message = error instanceof Error ? error.message : "could not open the request";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
