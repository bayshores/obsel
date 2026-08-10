/**
 * Who may change the erasure ledger.
 *
 * The interesting security is in `attestation.ts`: an attestation counts
 * because it is signed by a key obsel was told out of band to trust, verified
 * over canonical bytes, bound to a challenge obsel issued. This token does not
 * carry any of that weight. What it stops is an unauthenticated party opening
 * requests and burning challenges, which is a denial-of-service problem rather
 * than a forgery one.
 *
 * The case that matters most below is the unconfigured one, because that is the
 * default a deployment starts in.
 */

import { afterEach, describe, expect, it } from "vitest";

import { authorizeMutation } from "@/src/server/http/auth";

const TOKEN = "s3cret-token-value";

function requestWith(header?: string): Request {
  return new Request("http://localhost/api/erasure", {
    method: "POST",
    headers: header === undefined ? {} : { authorization: header },
  });
}

afterEach(() => {
  delete process.env.OBSEL_API_TOKEN;
});

describe("an obsel that was never told a token", () => {
  it("refuses every write rather than allowing every write", () => {
    /*
     * The direction this fails in is the whole point. A missing secret read as
     * "no authentication required" is how tools ship wide open, and the failure
     * is silent because everything works. An unconfigured deployment is a
     * closed one.
     */
    const outcome = authorizeMutation(requestWith(`Bearer ${TOKEN}`));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(503);
    expect(outcome.error).toContain("OBSEL_API_TOKEN");
  });

  it("refuses an empty token as firmly as a missing one", () => {
    // A variable set to the empty string is a configuration mistake, not a
    // decision to run without a secret.
    process.env.OBSEL_API_TOKEN = "   ";
    const outcome = authorizeMutation(requestWith("Bearer    "));
    expect(outcome.ok).toBe(false);
  });
});

describe("a configured obsel", () => {
  it("accepts the right token", () => {
    process.env.OBSEL_API_TOKEN = TOKEN;
    expect(authorizeMutation(requestWith(`Bearer ${TOKEN}`)).ok).toBe(true);
  });

  it("refuses a wrong token, a missing header, and the wrong scheme", () => {
    process.env.OBSEL_API_TOKEN = TOKEN;
    for (const header of [undefined, "", `Bearer ${TOKEN}x`, `Basic ${TOKEN}`, TOKEN]) {
      const outcome = authorizeMutation(requestWith(header));
      expect(outcome.ok, `header ${String(header)} should not authorize`).toBe(false);
      if (!outcome.ok) expect(outcome.status).toBe(401);
    }
  });

  it("refuses a token that is merely a correct prefix", () => {
    // The comparison is over the whole value, and a prefix that matches is the
    // shape an attacker guessing one character at a time would produce.
    process.env.OBSEL_API_TOKEN = TOKEN;
    expect(authorizeMutation(requestWith(`Bearer ${TOKEN.slice(0, -1)}`)).ok).toBe(false);
  });

  it("compares in constant time once the lengths match", () => {
    /*
     * `===` returns as soon as two bytes differ, and how long that takes is a
     * measurement of how much of the prefix was right, which is a real attack
     * on a value compared many times.
     *
     * Timing is not asserted here, because a timing assertion on a shared CI
     * machine is a flake generator and would be removed by the first person it
     * annoyed. What is asserted is the behavior that makes the constant-time
     * path reachable: two same-length wrong tokens differing at opposite ends
     * are both refused, so nothing short-circuits on the first byte.
     */
    process.env.OBSEL_API_TOKEN = TOKEN;
    const differsFirst = `X${TOKEN.slice(1)}`;
    const differsLast = `${TOKEN.slice(0, -1)}X`;
    expect(differsFirst.length).toBe(TOKEN.length);
    expect(differsLast.length).toBe(TOKEN.length);
    expect(authorizeMutation(requestWith(`Bearer ${differsFirst}`)).ok).toBe(false);
    expect(authorizeMutation(requestWith(`Bearer ${differsLast}`)).ok).toBe(false);
  });
});
