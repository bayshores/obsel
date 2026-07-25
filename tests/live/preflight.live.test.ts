/**
 * The prerequisite checklist, against real DataHub addresses that fail in real ways.
 *
 * This file exists because of an incident on 2026-07-24. The board sat on "The board
 * lost its connection", refusing to show numbers, while its own checklist showed four
 * green ticks including DataHub. The search container had exited four hours earlier.
 *
 * The check asked `GET /config` and nothing else. That reply is served from the GMS
 * process, so it kept answering 200 with the graph store gone, and the checklist said
 * the one thing that must never be said wrongly: everything here is fine. A reader
 * following it has nowhere left to look except inside obsel, which is the one place
 * the fault was not.
 *
 * The check now also makes the traversal call `readSnapshot` opens with, so what
 * blinds the board fails the checklist first.
 *
 * **Two real addresses, both of which the old check called healthy:**
 *
 * - `http://localhost:9002`, the DataHub frontend, is the trap the client has warned
 *   about in prose since the first week. It is worse than "will not answer": it
 *   answers `/config` with 200, and it answers `/relationships` with **200 and the web
 *   app's HTML**, because an unknown path under a single-page app returns the page.
 *   So a status-code check passes twice over and obsel still cannot read one edge.
 *   Only looking at the body catches it, which `relationships()` already does.
 * - A port nothing is listening on, which is the shape of "DataHub is not running".
 *
 * Neither is stood in for. 9002 is the real frontend from the same quickstart, and the
 * dead port is genuinely dead. The third failure, the search container stopped, is not
 * automated here: reproducing it means stopping a container the rest of this suite is
 * using, for the ~40 s it takes to come back. It was reproduced by hand instead, and
 * `docs/verification.md` records that run with its date and the exact commands.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { requireDataHub, GMS } from "./reachable";

const { preflight } = await import("@/src/server/runner/preflight");

/** The quickstart's web app. Real server, and the one operators point at by mistake. */
const FRONTEND = "http://localhost:9002";

/** Nothing listens here. Chosen high and odd; asserted dead before it is relied on. */
const DEAD = "http://localhost:59117";

const REAL = process.env.DATAHUB_GMS_URL;

async function datahubCheckAt(url: string) {
  process.env.DATAHUB_GMS_URL = url;
  const { datahub } = await preflight();
  return datahub;
}

afterEach(() => {
  if (REAL === undefined) delete process.env.DATAHUB_GMS_URL;
  else process.env.DATAHUB_GMS_URL = REAL;
});

describe("the DataHub prerequisite is decided by the call the board depends on", () => {
  beforeAll(async () => {
    await requireDataHub();

    // The frontend has to be up for its test to mean anything. Not skipped when it is
    // absent, for the reason in `reachable.ts`: a green run over a path nothing
    // exercised is the failure this whole repository is about.
    const frontend = await fetch(`${FRONTEND}/config`, { signal: AbortSignal.timeout(5_000) })
      .then((response) => response.status)
      .catch(() => null);
    if (frontend !== 200) {
      throw new Error(
        `this file needs the DataHub frontend answering at ${FRONTEND}, and it gave ` +
          `${frontend ?? "no reply"}.\n  Fix: datahub docker quickstart`,
      );
    }

    // And the dead port has to be genuinely dead, or the test proves nothing.
    const dead = await fetch(`${DEAD}/config`, { signal: AbortSignal.timeout(2_000) })
      .then((response) => response.status)
      .catch(() => null);
    if (dead !== null) {
      throw new Error(`${DEAD} answered ${dead}; this test needs a port nothing is on`);
    }
  });

  it("passes against the real GMS, having actually read the swarm", async () => {
    const check = await datahubCheckAt(GMS);
    expect(check.ok).toBe(true);
    expect(check.fix).toBeNull();
    expect(check.detail).toContain("could read the swarm");
    /*
     * This test does not pin the traversal, and an earlier version of this comment
     * claimed it did. Removing the traversal probe and re-running left it green,
     * because the sentence it reads is written at the end of the function either
     * way. The test below is the one that fails when the probe goes: it is the only
     * one here whose address answers 200 to everything and is still unusable.
     */
  });

  it("fails against the frontend, which answers every status code the old check read", async () => {
    // First, the trap itself, measured rather than asserted from memory: both probes
    // a status-code check would make come back 200 from a server obsel cannot use.
    const config = await fetch(`${FRONTEND}/config`);
    const edges = await fetch(
      `${FRONTEND}/relationships?urn=${encodeURIComponent("urn:li:dataFlow:(obsel,x,prod)")}` +
        `&direction=INCOMING&types=IsPartOf&start=0&count=10`,
    );
    expect(config.status).toBe(200);
    expect(edges.status).toBe(200);
    expect((await edges.text()).trimStart().slice(0, 15).toLowerCase()).toContain("<!doctype html");

    const check = await datahubCheckAt(FRONTEND);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("could not answer what is connected to");
    expect(check.fix).toBe("datahub docker quickstart");
  });

  it("fails against a port nothing is listening on", async () => {
    const check = await datahubCheckAt(DEAD);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("Nothing answered");
    expect(check.fix).toBe("datahub docker quickstart");
  });

  it("does not hand one address's verdict to another", async () => {
    // The verdicts above are cached for ten seconds, and they arrived within one
    // second of each other. They differ because the cache key names the address.
    const good = await datahubCheckAt(GMS);
    const bad = await datahubCheckAt(DEAD);
    expect(good.ok).toBe(true);
    expect(bad.ok).toBe(false);
  });
});
