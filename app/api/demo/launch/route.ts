import { NextResponse } from "next/server";
import { z } from "zod";

import { launchStep } from "@/src/server/runner/launcher";

export const dynamic = "force-dynamic";

// Exactly agents.run's commands. The enum is the allowlist: nothing from the
// request reaches the spawn except one of these six literals.
const Body = z.object({
  step: z.enum(["setup", "register", "run", "rerun-same", "change", "reset"]),
});

/**
 * Launch one demo step on this machine — the same command the README
 * documents, spawned verbatim. Answers immediately; progress is read from
 * `GET /api/demo/activity` and the swarm itself.
 */
export async function POST(request: Request) {
  let parsed;
  try {
    parsed = Body.parse(await request.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid body";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const outcome = launchStep(parsed.step);
  if ("status" in outcome) {
    return NextResponse.json(
      { error: outcome.error, fix: outcome.fix },
      { status: outcome.status },
    );
  }
  return NextResponse.json({ ok: true, running: outcome.running });
}
