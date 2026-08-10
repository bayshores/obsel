import { NextResponse } from "next/server";

import { registerTask } from "@/src/server/coordinator/engine";
import { RegisterBody } from "@/src/server/http/register-body";
import { parseBody, refuseUnauthorized } from "@/src/server/http/route";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const refusal = refuseUnauthorized(request);
  if (refusal) return refusal;

  const body = await parseBody(request, RegisterBody);
  if (!body.ok) return body.response;
  const parsed = body.body;

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
    const { task, alreadyRegistered } = await registerTask(
      parsed.name,
      parsed.reads,
      parsed.writes,
      parsed.description,
      parsed.title,
      parsed.volatile,
      parsed.client,
    );
    /*
     * The task record, with one field beside it saying whether anything was
     * written. Beside rather than inside: `alreadyRegistered` is about this
     * request, and `TaskRecord` is what the board holds about the task.
     *
     * Re-declaring a task that already stands exactly this way writes nothing —
     * see `registration.ts`. Without that, this route erased the fingerprints of
     * a task that had already finished, and its next completion had no baseline
     * left to compare against.
     */
    return NextResponse.json({ ...task, alreadyRegistered });
  } catch (error) {
    const message = error instanceof Error ? error.message : "registration failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
