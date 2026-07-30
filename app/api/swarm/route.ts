import { readSwarm } from "@/src/server/coordinator/engine";
import { readRoute } from "@/src/server/http/route";

// The dashboard polls this once a second, so it must always reflect DataHub as it is
// right now rather than anything cached.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  // Shape owned by engine.readSwarm rather than assembled here, so the route
  // and the engine cannot drift apart on what the dashboard receives.
  return readRoute("unknown error reading DataHub", () => readSwarm());
}
