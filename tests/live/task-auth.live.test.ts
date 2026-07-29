/**
 * The task routes refuse an unauthenticated caller, proven against real servers.
 *
 * Two obsel instances, both real `next start` processes: one configured with a
 * token, answering 401 to a missing or wrong one, and one started with
 * `OBSEL_API_TOKEN` explicitly empty, answering 503 to everything. The hostile
 * inputs are real requests over real HTTP, per the no-stand-ins rule.
 *
 * Why this suite exists at all: an un-gated `/api/tasks/complete` was a side
 * door around the no-clear rule. A forged completion whose fingerprints match
 * the recorded baseline reads as an identical redo, and `restoredBy` derives
 * clears from those, so the gate on these routes is part of what makes "no
 * route clears a flag" true rather than hygiene around it.
 *
 * The last test is the counterpart: the board's own routes must stay reachable
 * without a token, or the demo path a judge follows would need one pasted in
 * before any button worked.
 *
 * The bodies below are deliberately trivial or invalid; every request must be
 * refused by the gate BEFORE the body is read. A 400 from any of them would
 * mean the server parsed a body an unauthenticated party sent.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireDataHub } from "./reachable";
import { API_TOKEN, startObsel, type ObselServer } from "./obsel-server";

const PORT = 3118;
const OPEN_PORT = 3119;
const FLOW_ID = "obsel_integration_tests";

let server: ObselServer;
let tokenless: ObselServer;

/**
 * The task routes only a separate agent process calls, so a route that forgets
 * the gate fails here by name rather than shipping open.
 *
 * `register`, `report` and the two demo routes are absent because they are
 * ungated by decision, not by oversight: the board calls them from a browser
 * that has nowhere to keep a token, and none of them can clear a flag.
 * `auth.ts` carries the full reasoning.
 */
const MUTATIONS = ["/api/tasks/start", "/api/tasks/complete", "/api/tasks/abandon"];

async function post(
  base: string,
  path: string,
  token: string | null,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(120_000),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  await requireDataHub();
  server = await startObsel(PORT, FLOW_ID);
  // `OBSEL_API_TOKEN: ""` is load-bearing: `next start` reads the repository's
  // `.env.local` itself, so on a machine where `start.sh` has generated a token
  // an *unset* variable would quietly become a configured server. An explicit
  // empty value wins over the file and is genuinely a server with no token.
  tokenless = await startObsel(OPEN_PORT, FLOW_ID, { OBSEL_API_TOKEN: "" });
  return async () => {
    await server.stop();
    await tokenless.stop();
  };
}, 300_000);

afterAll(async () => {
  await server?.stop();
  await tokenless?.stop();
});

describe("a server with a token refuses everyone who lacks it", () => {
  for (const path of MUTATIONS) {
    it(`${path} answers 401 with no Authorization header`, async () => {
      const { status } = await post(server.url, path, null);
      expect(status).toBe(401);
    });

    it(`${path} answers 401 with the wrong token`, async () => {
      const { status } = await post(server.url, path, `${API_TOKEN}-wrong`);
      expect(status).toBe(401);
    });
  }

  it("names what is required, not what was supplied", async () => {
    const { body } = await post(server.url, "/api/tasks/complete", null);
    expect(String(body.error)).toContain("Bearer");
  });
});

describe("a server with no token refuses everyone, including the right guess", () => {
  it("answers 503 and names the variable to set", async () => {
    const { status, body } = await post(tokenless.url, "/api/tasks/complete", API_TOKEN);
    expect(status).toBe(503);
    expect(String(body.error)).toContain("OBSEL_API_TOKEN");
  });
});

describe("the routes the board calls stay open", () => {
  /*
   * Asserted as "not an auth refusal" rather than as a success. Each of these
   * rejects the empty body this helper sends, which is the point: reaching the
   * body parser at all proves the request was never turned away for lacking a
   * token. A 401 or 503 here would mean the judge's demo path needs one pasted
   * in before anything works.
   */
  for (const path of ["/api/tasks/register", "/api/tasks/report", "/api/demo/launch"]) {
    it(`${path} answers without a token`, async () => {
      const { status } = await post(server.url, path, null);
      expect(status).toBe(400);
    });
  }

  it("/api/demo/reset answers without a token", async () => {
    // No body to reject, so this one genuinely resets the integration flow.
    const { status } = await post(server.url, "/api/demo/reset", null);
    expect(status).toBe(200);
  });
});
