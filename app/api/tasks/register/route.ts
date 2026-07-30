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

  /*
   * A task may only declare volatile columns on tables it writes.
   *
   * Checked here rather than in the schema because it is a relationship between
   * two fields rather than a shape. Excluding a column of somebody else's table
   * is a claim this task has no standing to make, and it would take effect for
   * every reader of that table, since readers apply the producer's list.
   */
  const undeclared = Object.keys(parsed.volatile ?? {}).filter(
    (table) => !parsed.writes.includes(table),
  );
  if (undeclared.length > 0) {
    return NextResponse.json(
      {
        error:
          `volatile columns were declared for ${undeclared.join(", ")}, which this task does ` +
          "not write. A task can only say which of ITS OWN output columns are meaningless, " +
          "because every reader of that table hashes it using the producer's list.",
      },
      { status: 400 },
    );
  }

  try {
    const task = await registerTask(
      parsed.name,
      parsed.reads,
      parsed.writes,
      parsed.description,
      parsed.title,
      parsed.volatile,
      parsed.client,
    );
    return NextResponse.json(task);
  } catch (error) {
    const message = error instanceof Error ? error.message : "registration failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
