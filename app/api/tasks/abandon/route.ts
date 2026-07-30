import { z } from "zod";

import { abandonTask } from "@/src/server/coordinator/engine";
import { mutationRoute } from "@/src/server/http/mutation";

export const dynamic = "force-dynamic";

const Body = z.object({ taskUrn: z.string().min(1) });

/**
 * An agent announced that it started and then died.
 *
 * Agents announce before they do their work, so the dashboard can show work in
 * flight while it is actually in flight. That is only safe if a run that dies
 * gives the announcement back: obsel excludes `running` work from the cascade,
 * so a task abandoned at `running` would be skipped by every future traversal
 * while the board still showed a healthy swarm.
 *
 * Idempotent, and quiet about a task that was never running — the caller is a
 * failure path, and a second error there would bury the first.
 */
/*
 * Gated even though this is a failure-path convenience: un-gated, it lets any
 * caller flip a running task's status, and a task quietly demoted out of
 * `running` is skipped by every future cascade — hidden, not just mislabeled.
 */
export async function POST(request: Request) {
  return mutationRoute(request, Body, "could not abandon task", (body) =>
    abandonTask(body.taskUrn),
  );
}
