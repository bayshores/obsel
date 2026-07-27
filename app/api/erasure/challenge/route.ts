import { NextResponse } from "next/server";
import { z } from "zod";

import { issueChallenge } from "@/src/server/coordinator/erasure-engine";
import { authorizeMutation } from "@/src/server/http/auth";

export const dynamic = "force-dynamic";

const Body = z.object({
  request: z.string().min(1),
  asset: z.string().min(1),
});

/**
 * Issue the one-time value an attestor must bind into what it signs.
 *
 * This is what makes a signature evidence about now. Without it, an attestor
 * could sign "absent" the day its key was issued and produce that record
 * whenever it was asked, for as long as the key lived.
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
    return NextResponse.json(await issueChallenge(parsed));
  } catch (error) {
    const message = error instanceof Error ? error.message : "could not issue a challenge";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
