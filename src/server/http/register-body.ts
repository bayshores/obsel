/**
 * What `POST /api/tasks/register` will accept.
 *
 * It lives beside the route rather than inside it so it can be checked directly:
 * a route module exports only its handlers, and the shape of what obsel refuses is
 * worth a test that does not stand up Next.
 *
 * The route's comment has always said the server builds the URNs "so that the
 * naming convention lives in exactly one place and an agent cannot invent a
 * malformed one". Half of that was true — the server did build them — but the
 * names it built them out of were checked only for being non-empty, so a comma or
 * a second dot produced a URN no reader could recover the name from. The other
 * half of the intent is `taskNameProblem` and `datasetNameProblem` in
 * `src/server/datahub/urns.ts`, applied here and mirrored by `register_task` in
 * `agents/mcp_server.py` so both doors into obsel agree.
 */

import { z } from "zod";

import { datasetNameProblem, taskNameProblem } from "@/src/server/datahub/urns";

/** A short table name, or one carrying a single namespace segment. */
const DatasetName = z.string().superRefine((value, ctx) => {
  const problem = datasetNameProblem(value);
  if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
});

export const RegisterBody = z.object({
  name: z.string().superRefine((value, ctx) => {
    const problem = taskNameProblem(value);
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
  }),
  reads: z.array(DatasetName),
  writes: z.array(DatasetName),
  // The task's standing job in one sentence, stored as the DataJob's own
  // description. Bounded: this renders in the ledger and in DataHub's UI.
  description: z.string().min(1).max(300).optional(),
  // The short human name the board leads with. Tightly bounded because it is
  // also what the graph reserves box width for. Free prose, deliberately: it is
  // never interpolated into a URN, so nothing here has to parse it back out.
  title: z.string().min(1).max(60).optional(),
});
