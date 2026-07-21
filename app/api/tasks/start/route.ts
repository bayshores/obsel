import { NextResponse } from "next/server";
import { z } from "zod";

import { startTask } from "@/src/server/coordinator/engine";

export const dynamic = "force-dynamic";

const Body = z.object({ taskUrn: z.string().min(1) });

export async function POST(request: Request) {
  let parsed;
  try {
    parsed = Body.parse(await request.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid body";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    return NextResponse.json(await startTask(parsed.taskUrn));
  } catch (error) {
    const message = error instanceof Error ? error.message : "could not start task";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
