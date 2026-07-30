import { z } from "zod";

import { startTask } from "@/src/server/coordinator/engine";
import { mutationRoute } from "@/src/server/http/route";
import { ClientBody } from "@/src/server/http/client-body";

export const dynamic = "force-dynamic";

// `client` is what an MCP client named itself at connection, sent only by the
// MCP door. Optional, so every existing caller is unaffected. See client-body.ts.
const Body = z.object({ taskUrn: z.string().min(1), client: ClientBody.optional() });

export async function POST(request: Request) {
  return mutationRoute(request, Body, "could not start task", (body) =>
    startTask(body.taskUrn, body.client),
  );
}
