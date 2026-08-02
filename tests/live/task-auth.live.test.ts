/**
 * Every mutating route refuses an unauthenticated caller, proven against real
 * servers.
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
 * **`report` is in this list because leaving it out did not hold.** It was
 * ungated until 2026-08-02, on the argument that the board calls it from a
 * browser with nowhere to keep a token and that it cannot clear a flag anyway.
 * The second half was false: it spawns `agents/report.py` with the server's
 * environment, and the child completes the task with the server's own token. An
 * unauthenticated caller could replay a flagged task's recorded rows and watch
 * the completion clear the flag. This suite is where that must fail if anyone
 * re-opens the route.
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
 * Every route that changes something, so a route that forgets the gate fails
 * here by name rather than shipping open.
 *
 * `demo/reset` is safe to send unauthenticated requests to precisely because it
 * must refuse them: a run where it answers anything but a refusal has also
 * cleared the integration flow's board, which is the failure this asserts
 * against. The erasure mutations have their own suite.
 */
const MUTATIONS = [
  "/api/tasks/start",
  "/api/tasks/complete",
  "/api/tasks/abandon",
  "/api/tasks/register",
  "/api/tasks/report",
  "/api/demo/launch",
  "/api/demo/reset",
];

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

describe("the routes the board calls are gated too", () => {
  /*
   * The gate runs before the body parser, so an unauthenticated request to a
   * route that would refuse this empty body must still answer 401 rather than
   * 400. A 400 here would mean the server read a body a stranger sent.
   */
  for (const path of ["/api/tasks/register", "/api/tasks/report", "/api/demo/launch"]) {
    it(`${path} is refused before its body is read`, async () => {
      const { status } = await post(server.url, path, null);
      expect(status).toBe(401);
    });
  }

  it("/api/demo/reset refuses without clearing anything, and keeps its own shape", async () => {
    const { status, body } = await post(server.url, "/api/demo/reset", null);
    expect(status).toBe(401);
    // The one route whose failures carry `ok`; `agents/run_demo.py` reads it.
    expect(body.ok).toBe(false);
  });

  it("/api/demo/reset works for a caller who has the token", async () => {
    // This one genuinely resets the integration flow, which is why it is last.
    const { status, body } = await post(server.url, "/api/demo/reset", API_TOKEN);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });
});
