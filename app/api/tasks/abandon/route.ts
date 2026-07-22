import { NextResponse } from "next/server";
import { z } from "zod";

import { abandonTask } from "@/src/server/coordinator/engine";

export const dynamic = "force-dynamic";

const Body = z.object({ taskUrn: z.string().min(1) });

/**
 * An agent announced that it started and then died.
 *
 * Agents announce before they do their work, so the cockpit can show work in
 * flight while it is actually in flight. That is only safe if a run that dies
 * gives the announcement back: obsel excludes `running` work from the cascade,
 * so a task abandoned at `running` would be skipped by every future traversal
 * while the board still showed a healthy swarm.
 *
 * Idempotent, and quiet about a task that was never running — the caller is a
 * failure path, and a second error there would bury the first.
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
    return NextResponse.json(await abandonTask(parsed.taskUrn));
  } catch (error) {
    const message = error instanceof Error ? error.message : "could not abandon task";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
