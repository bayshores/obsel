import "server-only";

/**
 * The three steps every mutating route takes, in the one order they are safe in.
 *
 * Gate, then parse, then run. The gate is first so an unauthorised caller never
 * reaches `request.json()`, and the 400 is separate from the 500 so a caller can
 * tell a body obsel refused from work obsel attempted and could not finish.
 *
 * Seven routes had this written out, thirteen lines each, and the copies had
 * already begun to differ in the wording of their failures. Which routes are
 * gated and which are deliberately not is `auth.ts`'s decision and is unchanged
 * here: a route that does not call this does not get a gate by using it.
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
 * @param whenItFails what the 500 says when the thrown value carries no message.
 *
 * A handler returning a `NextResponse` is returned as it stands, which is how
 * `erasure/proof` answers 422 for an attestation obsel read and would not
 * accept — refused on its merits, not a body obsel could not parse.
 */
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

  try {
    const result = await handler(parsed.body);
    return result instanceof NextResponse ? result : NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : whenItFails;
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
