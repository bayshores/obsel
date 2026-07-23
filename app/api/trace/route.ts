import { NextResponse } from "next/server";

import { read } from "@/src/server/coordinator/trace";
import type { TraceEvent } from "@/src/server/coordinator/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * The steps the coordinator has taken recently, in plain language.
 *
 * Reads an in-memory buffer and touches nothing else — no DataHub call, no
 * disk — so it stays answerable while a slow GMS has every other read blocked,
 * which is exactly when someone most wants to know what obsel is doing.
 *
 * Narration, not state: nothing in obsel reads this back, and it is not
 * evidence of anything. The evidence is the marks in DataHub.
 */
export async function GET() {
  const events: TraceEvent[] = read();
  return NextResponse.json({ events });
}
