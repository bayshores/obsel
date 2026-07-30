import { z } from "zod";

import { coordinateObservation } from "@/src/server/coordinator/engine";
import { mutationRoute } from "@/src/server/http/mutation";
import { datasetNameProblem, datasetUrn } from "@/src/server/datahub/urns";

export const dynamic = "force-dynamic";

/**
 * What a table holds right now, reported by something that is not an agent.
 *
 * obsel's reader-side cross-check catches a write nobody reported only when an
 * instrumented task next reads that table, so between the silent write and that
 * read obsel is blind. This is the door for closing that window: a
 * change-data-capture bridge, a cron job, or a person running a script can hand
 * obsel the current fingerprint of a table and obsel will compare it against
 * what the producer recorded writing.
 *
 * **This is not a subscription and not a poll.** obsel still watches nothing; it
 * acts when something reports to it, exactly as it always has. The reference
 * bridge is `agents/observe.py`.
 *
 * Two limits, both inherent and neither hidden:
 *
 * - It is fingerprint-based, so a rewrite producing identical bytes is invisible
 *   here. That is the first correctness rule, not an oversight, and it must not
 *   drift toward the erasure kernel's opposite rule.
 * - A table nothing in the swarm has recorded writing gets `no-record` and
 *   nothing is written. obsel has no claim for the observation to contradict.
 */
const Body = z.object({
  // A short table name, like every other door. The server builds the URN so the
  // naming convention lives in one place; a caller that could pass a URN could
  // name a dataset obsel never registered.
  dataset: z.string().superRefine((value, ctx) => {
    const problem = datasetNameProblem(value);
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
  }),
  fingerprint: z.object({
    schema: z.string().min(1),
    content: z.string().min(1),
  }),
  // What the observer saw, so a mark can name the columns that moved rather
  // than showing two hashes. Display material, like everywhere else.
  columns: z.array(z.string()).optional(),
});

export async function POST(request: Request) {
  return mutationRoute(request, Body, "could not record the observation", (body) =>
    coordinateObservation(datasetUrn(body.dataset), {
      schema: body.fingerprint.schema,
      content: body.fingerprint.content,
      ...(body.columns ? { columns: body.columns } : {}),
    }),
  );
}
