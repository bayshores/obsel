import { NextResponse } from "next/server";
import { z } from "zod";

import { launchStep } from "@/src/server/runner/launcher";
import { parseBody, refuseUnauthorized } from "@/src/server/http/route";

export const dynamic = "force-dynamic";

// Exactly agents.run's commands. The enum is the allowlist: nothing from the
// request reaches the spawn except one of these literals.
const Body = z.object({
  step: z.enum([
    "setup",
    "register",
    "run",
    "rerun-same",
    "change",
    "repair",
    "reset",
    "scale-register",
    "scale-run",
    "scale-change",
    "scale-change-mid",
    "scale-repair",
  ]),
});

/**
 * Launch one demo step on this machine — the same command the README
 * documents, spawned verbatim. Answers immediately; progress is read from
 * `GET /api/demo/activity` and the swarm itself.
 *
 * Gated: the allowlist bounds which command runs, not who may run it, and the
 * commands behind it write to a real DataHub and spend real model time.
 */
export async function POST(request: Request) {
  const refusal = refuseUnauthorized(request);
  if (refusal) return refusal;

  const body = await parseBody(request, Body);
  if (!body.ok) return body.response;
  const parsed = body.body;

  // The server's own address, from the URL Next resolved for this request,
  // never from a header a client typed. The spawned step reports here rather
  // than to the agents' default port; `launcher.ts` records why that matters.
  const outcome = launchStep(parsed.step, new URL(request.url).origin);
  if ("status" in outcome) {
    return NextResponse.json(
      { error: outcome.error, fix: outcome.fix },
      { status: outcome.status },
    );
  }
  return NextResponse.json({ ok: true, running: outcome.running });
}
