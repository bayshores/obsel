import { z } from "zod";

import { openErasureRequest } from "@/src/server/coordinator/erasure-engine";
import { mutationRoute } from "@/src/server/http/route";

export const dynamic = "force-dynamic";

const Body = z.object({
  /** Optional: obsel mints one when the caller has no case reference of its own. */
  request: z.string().min(1).optional(),
  /**
   * The subject key values. Every attestation must have searched for all of
   * them, so a request that under-states the identifier set produces answers
   * that are structurally valid and narrower than the question being asked.
   */
  identifiers: z.array(z.string().min(1)).min(1),
  /** Assets known to hold the subject directly. The walk starts here. */
  seeds: z.array(z.string().min(1)).min(1),
  hops: z.number().int().min(1).max(6).optional(),
});

/**
 * Open an erasure request and report what it reaches.
 *
 * Everything found starts UNPROVEN, which is the point rather than a
 * placeholder: the list of assets nobody has spoken for is the thing a data
 * protection officer has never been handed.
 */
export async function POST(request: Request) {
  return mutationRoute(request, Body, "could not open the request", (body) =>
    openErasureRequest(body),
  );
}
