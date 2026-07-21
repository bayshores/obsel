import { NextResponse } from "next/server";

import { readSwarm } from "@/src/server/coordinator/engine";

// The dashboard polls this once a second, so it must always reflect DataHub as it is
// right now rather than anything cached.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    // Shape owned by engine.readSwarm rather than assembled here, so the route
    // and the engine cannot drift apart on what the dashboard receives.
    return NextResponse.json(await readSwarm());
  } catch (error) {
    // Deliberately a 500 with the real message rather than an empty swarm. An empty
    // board is indistinguishable from "everything is fine", which is the one thing
    // obsel must never imply when it cannot actually see the graph.
    const message = error instanceof Error ? error.message : "unknown error reading DataHub";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
