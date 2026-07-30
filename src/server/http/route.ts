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
 * differ in the wording of their failures. Which routes are gated and which are
 * deliberately not is `auth.ts`'s decision and is unchanged here: a route that
 * does not call `mutationRoute` does not acquire a gate by using this module.
 */

import { NextResponse } from "next/server";
import type { ZodType } from "zod";

import { authorizeMutation } from "./auth";

/**
 * One request body against one schema, or the 400 to return instead.
 *
 * Separate from `mutationRoute` because `register` and `report` are ungated and
 * do their own work between parsing and running, and a body they refused should
 * still read identically to one any other route refused.
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
  const auth = authorizeMutation(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const parsed = await parseBody(request, schema);
  if (!parsed.ok) return parsed.response;

  return readRoute(whenItFails, () => handler(parsed.body));
}
