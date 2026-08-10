/**
 * A failed read must never be answered as a genuine absence.
 *
 * `GET /api/erasure/[id]` and its `evidence` route answer 404 for a request
 * that was never opened and 500 for a read obsel could not finish. Both errors
 * come out of the same call, so how they are told apart decides whether an
 * auditor is told "this request does not exist" when the truth is "obsel could
 * not reach DataHub".
 *
 * Both cases below are produced by a real HTTP server on a real port, because
 * the failure being guarded against is a status that a real GMS returns during
 * a restart, and the error text under test is built by `readLedgerRecord` from
 * the response it actually received. Neither case reaches DataHub: the second
 * server answers 503 to everything, which is the hostile input.
 */

import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { erasureStatus } from "@/src/server/coordinator/erasure-engine";
import { erasureReadStatus } from "@/src/server/coordinator/erasure-missing";

let running: Server | null = null;
const originalUrl = process.env.DATAHUB_GMS_URL;

/** A real server on a real port answering one status to every request. */
async function serveStatus(status: number): Promise<void> {
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: `answering ${status}` }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  running = server;
  const { port } = server.address() as AddressInfo;
  process.env.DATAHUB_GMS_URL = `http://127.0.0.1:${port}`;
}

/** The error `erasureStatus` threw, or a failure if it somehow answered. */
async function failureFrom(requestId: string): Promise<unknown> {
  try {
    await erasureStatus(requestId);
  } catch (error) {
    return error;
  }
  throw new Error(`erasureStatus(${requestId}) answered instead of failing`);
}

afterEach(async () => {
  if (running) await new Promise<void>((resolve) => running!.close(() => resolve()));
  running = null;
  if (originalUrl === undefined) delete process.env.DATAHUB_GMS_URL;
  else process.env.DATAHUB_GMS_URL = originalUrl;
});

describe("classifying a failed read of one erasure request", () => {
  it("answers 404 for a request the ledger genuinely does not hold", async () => {
    await serveStatus(404);

    expect(erasureReadStatus(await failureFrom("dsr-never-opened"))).toBe(404);
  });

  it("answers 500 when the ledger is unreadable under an id that reads like an absence", async () => {
    await serveStatus(503);

    /*
     * The request id is caller-chosen and lands verbatim in the ledger URN,
     * which `readLedgerRecord` interpolates into its own failure message. This
     * id makes that message contain the words a text test would look for.
     */
    const error = await failureFrom("no erasure request in the ledger x");
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("no erasure request in the ledger x");
    expect(erasureReadStatus(error)).toBe(500);
  });
});
