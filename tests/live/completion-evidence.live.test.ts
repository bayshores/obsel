/**
 * The completion door's two refusals, over real HTTP against a real DataHub.
 *
 * NOT YET RUN as of 2026-08-10. Written with the fix and added here for the
 * live suite's next execution; `docs/verification.md` lists it as unrun.
 * `tests/completion-evidence.test.ts` covers the rule itself as a pure
 * function. What only this can show is the two consequences the rule exists to
 * prevent, on a real board: that a flagged task's mark and its DataHub
 * `obsel-stale` tag are both still standing after a report with no fingerprint
 * is refused, and that obsel holds no baseline for a table the reporter never
 * declared it writes.
 *
 * The refusals are the same two `resolve_outputs` makes at obsel's MCP door
 * (`agents/mcp_core.py`). This suite goes in the front, because the MCP door is
 * not a gate on this one: `agents/worker.py` posts here directly.
 *
 * The hostile bodies are real requests carrying a real token, per the
 * no-stand-ins rule. They have to be authorized: an unauthorized request is
 * refused by the gate before the body is read, which would prove nothing about
 * what obsel does with the body.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { API_TOKEN, startObsel } from "./obsel-server";
import type { ObselServer } from "./obsel-server";
import { requireDataHub, requireStaleTag } from "./reachable";

const { coordinateCompletion, registerTask } = await import("@/src/server/coordinator/engine");
const { readTask } = await import("@/src/server/datahub/client");
const { closeMcpClient } = await import("@/src/server/datahub/mcp");
const { datasetUrn, taskUrn, FLOW_ID } = await import("@/src/server/datahub/urns");

/** Not 3095–3099, 3117–3121, or 3122, which `incidents` holds for its proxy. */
const PORT = 3123;

/** This suite's own namespace, so nothing here can touch the demo's tables. */
const NS = "obsel_evidence";

const SEED = `${NS}.seed_table`;
const OUT = `${NS}.writer_out`;
/** Declared by nobody in this suite. The undeclared fingerprint's subject. */
const FOREIGN = `${NS}.foreign_table`;

const SEED_TASK = "evidence_seed";
const WRITER = "evidence_writer";

let server: ObselServer;

async function postCompletion(body: unknown): Promise<{ status: number; error: string }> {
  const response = await fetch(`${server.url}/api/tasks/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_TOKEN}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const answered = (await response.json()) as Record<string, unknown>;
  return { status: response.status, error: String(answered.error ?? "") };
}

beforeAll(async () => {
  await requireDataHub();
  await requireStaleTag();

  await registerTask(SEED_TASK, [`${NS}.raw`], [SEED], "writes the seed", "Evidence seed");
  await registerTask(WRITER, [SEED], [OUT], "reads the seed", "Evidence writer");

  // Both finish honestly, then the seed moves. That leaves the writer flagged,
  // which is the state in which a fingerprint-free completion would clear a
  // mark nobody redid the work behind.
  await coordinateCompletion({
    taskUrn: taskUrn(SEED_TASK),
    fingerprints: { [datasetUrn(SEED)]: { schema: "s1", content: "c1" } },
    finishedAt: new Date().toISOString(),
  });
  await coordinateCompletion({
    taskUrn: taskUrn(WRITER),
    fingerprints: { [datasetUrn(OUT)]: { schema: "s2", content: "c2" } },
    finishedAt: new Date().toISOString(),
  });
  await coordinateCompletion({
    taskUrn: taskUrn(SEED_TASK),
    fingerprints: { [datasetUrn(SEED)]: { schema: "s1", content: "c1-changed" } },
    finishedAt: new Date().toISOString(),
  });

  server = await startObsel(PORT, FLOW_ID);
  return async () => {
    await server.stop();
    await closeMcpClient();
  };
}, 300_000);

afterAll(async () => {
  await server?.stop();
  await closeMcpClient();
});

describe("a completion with no fingerprint, from a task that declared a write", () => {
  it("is refused, and the flag and the DataHub tag are both still standing", async () => {
    const before = await readTask(taskUrn(WRITER));
    expect(before?.stale).not.toBeNull();
    expect(before?.staleTagged).toBe(true);

    const { status, error } = await postCompletion({
      taskUrn: taskUrn(WRITER),
      fingerprints: {},
      finishedAt: new Date().toISOString(),
    });

    expect(status).toBe(400);
    expect(error).toContain(datasetUrn(OUT));
    expect(error).toContain("no output fingerprint");

    // Read off the entity, not inferred from the refusal. The mark and the tag
    // live on two different aspects, and clearing either one is the wrong
    // answer this refusal exists to prevent.
    const after = await readTask(taskUrn(WRITER));
    expect(after?.status).toBe("stale");
    expect(after?.stale?.reason).toBe(before?.stale?.reason);
    expect(after?.staleTagged).toBe(true);
  }, 120_000);
});

describe("a completion carrying a fingerprint for a table the task does not write", () => {
  it("is refused, and obsel records no baseline for that table", async () => {
    const { status, error } = await postCompletion({
      taskUrn: taskUrn(WRITER),
      fingerprints: {
        [datasetUrn(OUT)]: { schema: "s2", content: "c2" },
        [datasetUrn(FOREIGN)]: { schema: "s9", content: "c9" },
      },
      finishedAt: new Date().toISOString(),
    });

    expect(status).toBe(400);
    expect(error).toContain(datasetUrn(FOREIGN));
    expect(error).toContain(datasetUrn(OUT));

    /*
     * The declared half is refused with the undeclared one. A route that
     * recorded what it could would leave obsel holding a baseline for the
     * foreign table under an author with no `Produces` edge to it, and the next
     * report moving that table would mark its readers and name this task.
     */
    const after = await readTask(taskUrn(WRITER));
    expect(Object.keys(after?.fingerprints ?? {})).toEqual([datasetUrn(OUT)]);
    expect(after?.status).toBe("stale");
  }, 120_000);
});

describe("the honest report the refusals must not touch", () => {
  it("is accepted, and clears the flag the redone work restores", async () => {
    const { status } = await postCompletion({
      taskUrn: taskUrn(WRITER),
      fingerprints: { [datasetUrn(OUT)]: { schema: "s2", content: "c2" } },
      finishedAt: new Date().toISOString(),
    });

    expect(status).toBe(200);
    const after = await readTask(taskUrn(WRITER));
    expect(after?.stale).toBeNull();
  }, 120_000);
});
