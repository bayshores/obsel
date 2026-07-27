import { NextResponse } from "next/server";

import { registerTask } from "@/src/server/coordinator/engine";
import { RegisterBody } from "@/src/server/http/register-body";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let parsed;
  try {
    parsed = RegisterBody.parse(await request.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid body";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const task = await registerTask(
      parsed.name,
      parsed.reads,
      parsed.writes,
      parsed.description,
      parsed.title,
    );
    return NextResponse.json(task);
  } catch (error) {
    const message = error instanceof Error ? error.message : "registration failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
