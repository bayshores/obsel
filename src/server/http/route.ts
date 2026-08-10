import "server-only";

/**
 * What every route under `app/api/` does with a request, and with a failure.
 *
 * A mutating route gates, then parses, then runs; a read route only runs. The
 * gate is first so an unauthorised caller never reaches `request.json()`, and
 * the 400 is separate from the 500 so a caller can tell a body obsel refused
 * from work obsel attempted and could not finish.
 *
 * Ten routes had these written out by hand and the copies had already begun to
 * differ in the wording of their failures. Every mutating route is gated, but a
 * route does not acquire the gate by importing this module: it either composes
 * `mutationRoute` or calls `refuseUnauthorized` itself. `auth.ts` is where the
 * decision lives and why.
 */

import { NextResponse } from "next/server";
import type { ZodType } from "zod";

import { authorizeMutation } from "./auth";

/**
 * The refusal a caller without a valid token gets, or `null` to carry on.
 *
 * For the routes that cannot compose `mutationRoute`: `register` and `report`
 * do their own work between parsing and running, `demo/launch` answers in a
 * shape of its own, and the evidence bundle is a gated GET. Each one gates
 * through here so the four refusals read identically and none of them can
 * drift.
 */
export function refuseUnauthorized(request: Request): NextResponse | null {
  const auth = authorizeMutation(request);
  return auth.ok ? null : NextResponse.json({ error: auth.error }, { status: auth.status });
}

/**
 * One request body against one schema, or the 400 to return instead.
 *
 * Separate from `mutationRoute` because `register` and `report` do their own
 * work between parsing and running, and a body they refused should still read
 * identically to one any other route refused.
 */
export async function parseBody<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<{ ok: true; body: T } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, body: schema.parse(await request.json()) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid body";
    return { ok: false, response: NextResponse.json({ error: message }, { status: 400 }) };
  }
}

/**
 * Run a route's work, or answer 500 with what went wrong.
 *
 * @param whenItFails what the 500 says when the thrown value carries no message.
 *
 * A 500 carrying the real message, never an empty success. An empty board, an
 * empty history and an empty affected list all read as "everything is fine",
 * which is the one thing obsel must not imply when it could not see the graph.
 *
 * Work returning a `NextResponse` is returned as it stands, which is how
 * `erasure/proof` answers 422 for an attestation obsel read and would not
 * accept -- refused on its merits, not a body obsel could not parse.
 */
export async function readRoute(
  whenItFails: string,
  work: () => Promise<unknown>,
): Promise<NextResponse> {
  try {
    const result = await work();
    return result instanceof NextResponse ? result : NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : whenItFails;
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Gate, parse, then `readRoute`. */
export async function mutationRoute<T>(
  request: Request,
  schema: ZodType<T>,
  whenItFails: string,
  handler: (body: T) => Promise<unknown>,
): Promise<NextResponse> {
  const refusal = refuseUnauthorized(request);
  if (refusal) return refusal;

  const parsed = await parseBody(request, schema);
  if (!parsed.ok) return parsed.response;

  return readRoute(whenItFails, () => handler(parsed.body));
}
