import { NextResponse } from "next/server";
import { z } from "zod";

import { coordinateCompletion } from "@/src/server/coordinator/engine";

export const dynamic = "force-dynamic";

const Fingerprint = z.object({
  schema: z.string().min(1),
  content: z.string().min(1),
});

const Body = z.object({
  taskUrn: z.string().min(1),
  fingerprints: z.record(z.string(), Fingerprint),
  finishedAt: z.string().min(1),
});

/**
 * An agent reporting that it finished IS the trigger for everything obsel does.
 * There is no polling loop and no event subscription: the agent has to tell someone
 * it is done anyway, so that report is the cheapest possible place to hang the check.
 */
export async function POST(request: Request) {
  let parsed;
  try {
    parsed = Body.parse(await request.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid body";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    return NextResponse.json(await coordinateCompletion(parsed));
  } catch (error) {
    const message = error instanceof Error ? error.message : "coordination failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
