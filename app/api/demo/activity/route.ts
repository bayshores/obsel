import { readRoute } from "@/src/server/http/route";
import { activity } from "@/src/server/runner/launcher";
import { preflight } from "@/src/server/runner/preflight";
import { venvPython } from "@/src/server/runner/steps";
import type { DemoActivity } from "@/src/server/runner/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * What the demo runner is doing right now: the running step, how the last one
 * ended, its own printed output, and whether the machine's prerequisites hold.
 *
 * The dashboard polls this beside `/api/swarm`. Task state itself is never in
 * here — that lives in DataHub and comes back through the swarm read.
 */
export async function GET() {
  return readRoute("unknown error reading activity", async (): Promise<DemoActivity> => ({
    ...activity(),
    preflight: await preflight(),
    // The same interpreter the demo steps run under, by absolute path, so the
    // command on the board works pasted verbatim on this machine.
    joinCommand: `claude mcp add obsel -- ${venvPython(process.cwd())} -m agents.mcp_server`,
  }));
}
