import "server-only";

/**
 * Who is allowed to change something through obsel's HTTP surface.
 *
 * Every mutating route is gated: the task routes, the demo routes, and the
 * erasure routes. Reads stay open — they change nothing, and the page polls
 * them. The task routes are not an afterthought here: an un-gated completion
 * report whose fingerprints match the recorded baseline reads as an identical
 * redo, and `restoredBy` derives clears from those, so without this gate the
 * no-clear rule held only against honest callers.
 *
 * **This is a bearer token, and on the erasure side it is not the interesting
 * half of the security.** An attestation is worth something because it is
 * signed by a key obsel was told out of band to trust, verified over canonical
 * bytes, bound to a challenge obsel issued. None of that depends on this token.
 * What the token does there is stop an unauthenticated party from opening
 * requests and burning challenges, which is a denial-of-service problem rather
 * than a forgery one. Saying so plainly matters: a reader who mistakes the
 * token for the trust root would draw the wrong conclusion about what obsel
 * proves.
 *
 * Absent `OBSEL_API_TOKEN`, mutating routes refuse everything rather than
 * allowing everything. An unconfigured deployment is a closed one. The opposite
 * default is how tools ship wide open, and the failure is silent because
 * everything works. `scripts/start.sh` generates a token into `.env.local`
 * when none is set, so the zero-config demo path stays a configured one.
 */

export type AuthOutcome = { ok: true } | { ok: false; status: number; error: string };

export function authorizeMutation(request: Request): AuthOutcome {
  const expected = process.env.OBSEL_API_TOKEN?.trim();
  if (!expected) {
    return {
      ok: false,
      status: 503,
      error:
        "this obsel has no OBSEL_API_TOKEN configured, so it accepts no writes to the erasure " +
        "ledger. Set one and restart. Refusing is deliberate: an unconfigured deployment is a " +
        "closed one, not an open one.",
    };
  }

  const header = request.headers.get("authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!supplied || !timingSafeEqual(supplied, expected)) {
    return { ok: false, status: 401, error: "a valid Bearer token is required" };
  }
  return { ok: true };
}

/**
 * Constant-time comparison.
 *
 * `===` on secrets returns as soon as two bytes differ, and the time it takes
 * is a measurement of how much of the prefix was right. That is a real attack
 * on a token compared many times, which is exactly what an API token is. Length
 * is compared first and deliberately leaks, because the length of a token is
 * not the secret and hiding it would cost a branch that is harder to keep
 * honest.
 */
function timingSafeEqual(supplied: string, expected: string): boolean {
  if (supplied.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < supplied.length; index += 1) {
    difference |= supplied.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}
