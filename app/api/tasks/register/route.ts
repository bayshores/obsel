import { NextResponse } from "next/server";
import { z } from "zod";

import { registerTask } from "@/src/server/coordinator/engine";

export const dynamic = "force-dynamic";

// Short table names, not URNs. The server builds URNs so that the naming convention
// lives in exactly one place and an agent cannot invent a malformed one.
const Body = z.object({
  name: z.string().min(1),
  reads: z.array(z.string().min(1)),
  writes: z.array(z.string().min(1)),
  // The task's standing job in one sentence, stored as the DataJob's own
  // description. Bounded: this renders in the ledger and in DataHub's UI.
  description: z.string().min(1).max(300).optional(),
});

export async function POST(request: Request) {
  let parsed;
  try {
    parsed = Body.parse(await request.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid body";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const task = await registerTask(parsed.name, parsed.reads, parsed.writes, parsed.description);
    return NextResponse.json(task);
  } catch (error) {
    const message = error instanceof Error ? error.message : "registration failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
