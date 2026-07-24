import { NextResponse } from "next/server";
import { z } from "zod";

import { coordinateCompletion } from "@/src/server/coordinator/engine";

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
 * Optional, and nothing obsel decides on — it is what the cockpit shows so a
 * person can see what an agent actually did instead of a pulsing dot. An agent
 * that omits it still gets an identical staleness answer; the run simply reads
 * as "not reported" on screen rather than as a zero.
 *
 * `ms` is the agent's measurement of its own run, taken in one process. obsel
 * does not recompute it from timestamps, which would cross two clocks.
 */
const Run = z.object({
  runner: z.string().min(1),
  ms: z.number().nonnegative(),
  outputs: z.record(z.string(), OutputShape),
});

/**
 * What one input table looked like when this task read it. Optional and
 * additive: a report without it gets exactly the old behaviour. Each one is
 * compared against what the dataset's producer recorded writing — a mismatch
 * means the table changed and nothing reported the change, which no producer
 * fingerprint can ever catch, because the producer never sent one.
 */
const Observation = Fingerprint.extend({
  columns: z.array(z.string()).optional(),
});

const Body = z.object({
  taskUrn: z.string().min(1),
  fingerprints: z.record(z.string(), Fingerprint),
  finishedAt: z.string().min(1),
  run: Run.optional(),
  inputs: z.record(z.string(), Observation).optional(),
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
