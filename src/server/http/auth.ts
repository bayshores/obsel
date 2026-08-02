import "server-only";

/**
 * Who is allowed to change something through obsel's HTTP surface.
 *
 * Every mutating route is gated: `start`, `complete`, `abandon`, `register`,
 * `report`, the two demo routes, `datasets/observe`, and the three erasure
 * mutations. `complete` is why this exists on the task side: a forged
 * completion whose fingerprints match the recorded baseline reads as an
 * identical redo, and `restoredBy` derives clears from those, so without the
 * gate the no-clear rule held only against honest callers.
 *
 * **Four of these were ungated until 2026-08-02, and the reasoning was wrong.**
 * The argument was that a token cannot protect the routes the board itself
 * calls, since the browser has no environment to read one from, and that none
 * of those four could clear a flag anyway. The second half was false.
 * `report` spawns `agents/report.py` with the server's environment, and the
 * child completes the task with the server's own `OBSEL_API_TOKEN`. So an
 * unauthenticated caller could replay a flagged task's recorded rows, have the
 * fingerprints match, and watch the completion read as an identical redo that
 * cleared the flag and the flags below it. The gate on `complete` held only
 * against callers who came through the front. Reviewed and reported by a reader
 * of this file, which is the argument for writing the reasoning down next to
 * the code: it was checkable, and it did not survive being checked.
 *
 * The cost the old note was avoiding is real and is now paid: the operator
 * pastes the token from `.env.local` into the board's token field once, and the
 * page sends it on the mutations it makes. The alternative, a server that hands
 * the page a token anyone loading the page can read, would be theatre.
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
        "this obsel has no OBSEL_API_TOKEN configured, so it accepts no agent completions and " +
        "no writes to the erasure ledger. Set one and restart; scripts/start.sh generates one " +
        "into .env.local. Refusing is deliberate: an unconfigured deployment is a closed one, " +
        "not an open one",
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
