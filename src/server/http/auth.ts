import "server-only";

/**
 * Who is allowed to change something through obsel's HTTP surface.
 *
 * Gated: the three routes only a separate agent process calls — `start`,
 * `complete`, `abandon` — the three erasure mutations, and `datasets/observe`,
 * which is a write about a table by something outside the swarm. `complete` is why
 * this exists on the task side: a forged completion whose fingerprints match
 * the recorded baseline reads as an identical redo, and `restoredBy` derives
 * clears from those, so without the gate the no-clear rule held only against
 * honest callers.
 *
 * **Ungated, deliberately: the routes the board itself calls** — `register`,
 * `report`, and the two demo routes. A token cannot protect those. The browser
 * has no environment to read one from, so either a human pastes it before any
 * button works, or the server hands it to the page and anyone who can load the
 * page can read it. The second is theatre, and the first costs every operator a
 * manual step to guard routes that create a node, hash a table somebody typed,
 * or run a demo step from a twelve-literal allowlist. None of those can clear a
 * flag, which is the failure that matters. This is a real limit and it belongs
 * written down rather than implied: obsel bound to a reachable interface trusts
 * its own network for those four routes.
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
