import { NextResponse } from "next/server";
import { z } from "zod";

import { coordinateCompletion } from "@/src/server/coordinator/engine";
import { UnevidencedCompletion } from "@/src/server/coordinator/completion-evidence";
import { mutationRoute } from "@/src/server/http/route";
import { ClientBody } from "@/src/server/http/client-body";

export const dynamic = "force-dynamic";

const Fingerprint = z.object({
  schema: z.string().min(1),
  content: z.string().min(1),
});

const OutputShape = z.object({
  rows: z.number().int().nonnegative(),
  columns: z.array(z.string()),
  // Where the file lives, per the writing agent. Display only.
  path: z.string().optional(),
});

/**
 * Optional, and nothing obsel decides on — it is what the dashboard shows so a
 * person can see what an agent actually did instead of a pulsing dot. An agent
 * that omits it still gets an identical staleness answer; the run simply reads
 * as "not reported" on screen rather than as a zero.
 *
 * `ms` is the agent's measurement of its own run, taken in one process. obsel
 * does not recompute it from timestamps, which would cross two clocks.
 */
/**
 * `outputs` is required; `runner` and `ms` are not.
 *
 * All three were required, and that cost more than it looked. A caller with no
 * stopwatch — the dashboard table form, where a person types the table and there is no
 * run to time — had to omit the whole object, which threw away `outputs` too.
 * That is not display material: `columnChange` in `engine.ts` diffs these
 * column lists to say which columns moved, so dropping them turned "clean
 * expenses lost amount" into "the columns in clean expenses changed".
 *
 * Inventing a duration to keep the object whole was the other way out, and it
 * is the one obsel is not allowed to take: a number on the board that nobody
 * measured is the thing this repository refuses everywhere else.
 */
const Run = z.object({
  // `.default(null)`, so an absent key and an explicit null arrive at the
  // engine as the same thing: not told. Leaving them merely optional would hand
  // `undefined` down to code whose whole job is distinguishing a value from the
  // absence of one, with two spellings for the absence.
  runner: z.string().min(1).nullable().default(null),
  ms: z.number().nonnegative().nullable().default(null),
  outputs: z.record(z.string(), OutputShape),
});

/**
 * What one input table looked like when this task read it. Optional and
 * additive: a report without it gets exactly the old behavior. Each one is
 * compared against what the dataset's producer recorded writing — a mismatch
 * means the table changed and nothing reported the change, which no producer
 * fingerprint can ever catch, because the producer never sent one.
 */
const Observation = Fingerprint.extend({
  columns: z.array(z.string()).optional(),
});

const Body = z.object({
  taskUrn: z.string().min(1),
  /*
   * Keyed by the full dataset URN, and `{}` parses. What the map may contain is
   * not a shape question: it is a relationship between this body and obsel's
   * record of the task, which only the snapshot holds. `evidenceProblem` in
   * `src/server/coordinator/completion-evidence.ts` is where an empty map and a
   * dataset this task does not write are refused, and the handler below turns
   * that refusal into a 400 rather than a 500.
   */
  fingerprints: z.record(z.string(), Fingerprint),
  finishedAt: z.string().min(1),
  run: Run.optional(),
  inputs: z.record(z.string(), Observation).optional(),
  /**
   * What the MCP client named itself at connection, sent only by the MCP door.
   *
   * Beside `run.runner` rather than inside it, because they are two different
   * facts: `runner` is what the agent says did the work, this is what spoke MCP
   * to obsel. They can legitimately disagree, so neither is ever derived from
   * the other. Display only. See `client-body.ts`.
   */
  client: ClientBody.optional(),
});

/**
 * An agent reporting that it finished is the main trigger for everything obsel does.
 * There is no polling loop and no event subscription: the agent has to tell someone
 * it is done anyway, so that report is the cheapest possible place to hang the check.
 */
/*
 * Gated like every mutating route, and on this one the gate is load-bearing
 * for the no-clear rule: a forged completion whose fingerprints match the
 * recorded baseline reads as an identical redo, and `restoredBy` would then
 * derive clears from it. Without the token, "no route clears a flag" held
 * only against callers polite enough not to lie.
 */
export async function POST(request: Request) {
  return mutationRoute(request, Body, "coordination failed", async (body) => {
    try {
      return await coordinateCompletion(body);
    } catch (error) {
      // 400, beside the schema's own refusals: obsel read this report and will
      // not act on it, and what has to change is in the caller's body. A 500
      // would send the caller to obsel's logs for a fault that is not obsel's.
      if (error instanceof UnevidencedCompletion) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }
  });
}
