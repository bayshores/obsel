import { z } from "zod";

import { issueChallenge } from "@/src/server/coordinator/erasure-engine";
import { mutationRoute } from "@/src/server/http/route";

export const dynamic = "force-dynamic";

const Body = z.object({
  request: z.string().min(1),
  asset: z.string().min(1),
});

/**
 * Issue the one-time value an attestor must bind into what it signs.
 *
 * This is what makes a signature evidence about now. Without it, an attestor
 * could sign "absent" the day its key was issued and produce that record
 * whenever it was asked, for as long as the key lived.
 */
export async function POST(request: Request) {
  return mutationRoute(request, Body, "could not issue a challenge", (body) =>
    issueChallenge(body),
  );
}
