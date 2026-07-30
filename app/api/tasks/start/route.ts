import { NextResponse } from "next/server";
import { z } from "zod";

import { startTask } from "@/src/server/coordinator/engine";
import { authorizeMutation } from "@/src/server/http/auth";
import { ClientBody } from "@/src/server/http/client-body";

export const dynamic = "force-dynamic";

// `client` is what an MCP client named itself at connection, sent only by the
// MCP door. Optional, so every existing caller is unaffected. See client-body.ts.
const Body = z.object({ taskUrn: z.string().min(1), client: ClientBody.optional() });

export async function POST(request: Request) {
  const auth = authorizeMutation(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let parsed;
  try {
    parsed = Body.parse(await request.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid body";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    return NextResponse.json(await startTask(parsed.taskUrn, parsed.client));
  } catch (error) {
    const message = error instanceof Error ? error.message : "could not start task";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
