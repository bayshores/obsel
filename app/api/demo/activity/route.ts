import { NextResponse } from "next/server";

import { activity } from "@/src/server/runner/launcher";
import { preflight } from "@/src/server/runner/preflight";
import type { DemoActivity } from "@/src/server/runner/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * What the demo runner is doing right now: the running step, how the last one
 * ended, its own printed output, and whether the machine's prerequisites hold.
 *
 * The cockpit polls this beside `/api/swarm`. Task state itself is never in
 * here — that lives in DataHub and comes back through the swarm read.
 */
export async function GET() {
  try {
    const body: DemoActivity = { ...activity(), preflight: await preflight() };
    return NextResponse.json(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error reading activity";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
