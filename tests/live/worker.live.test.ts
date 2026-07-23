/**
 * `agents/worker.py`'s in-flight guard, against a real obsel and a real DataHub.
 *
 * The rest of `worker.py` is covered by its own self-check (`pnpm test:python`), which
 * runs real files in real temporary directories and needs nothing standing up. What it
 * cannot cover is the half that exists to survive a **remote** state going wrong: the
 * marker file plus obsel's own `running` status, and the rule that the marker decides
 * only whether to ASK while obsel decides what is true.
 *
 * That rule is the interesting one, because the failure it prevents is silent. obsel
 * refuses a second `start` for a task it already holds at `running`, which is correct —
 * two agents writing one output is a real error. But a worker that announced a start and
 * then died leaves the task at `running` forever, and only *finished* work can go stale,
 * so a wedged task is invisible to every later traversal while the board still looks
 * healthy.
 *
 * Driven by invoking the real functions in a subprocess through `python3 -c`. Nothing is
 * stood in for on either side: real HTTP, real DataHub writes, real marker files under a
 * temporary root.
 *
 * **It starts an obsel of its own**, on port 3099 and pointed at the integration flow.
 * A server reads `OBSEL_FLOW_ID` once at startup, so the `pnpm dev` instance an operator
 * has open is pinned to the demo's flow. Using that one would mean either registering
 * this subject into the demo's flow, which pollutes the board a judge sees, or the
 * worker failing to find a task that genuinely exists. Both happened before this existed.
 * See `tests/live/obsel-server.ts`.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startObsel } from "./obsel-server";
import type { ObselServer } from "./obsel-server";
import { requireDataHub, requireStaleTag, requireUvx } from "./reachable";

const { registerTask } = await import("@/src/server/coordinator/engine");
const { readTask } = await import("@/src/server/datahub/client");
const { closeMcpClient } = await import("@/src/server/datahub/mcp");
const { taskUrn } = await import("@/src/server/datahub/urns");

const REPO = new URL("../../", import.meta.url).pathname;
const FLOW_ID = "obsel_integration_tests";
/** Not 3000: the operator's own `pnpm dev` lives there, on the demo's flow. */
const PORT = 3099;

/** A task of this file's own, so nothing here can wedge a task another suite uses. */
const SUBJECT = "worker_inflight_subject";

let root: string;
let obselServer: ObselServer;

/**
 * Call into the real `agents.worker`, with `root` pointed at a temporary directory.
 *
 * Every function under test already takes `root`, so the marker files land somewhere
 * harmless while the HTTP calls go to the real obsel.
 */
function python(body: string): string {
  const script = [
    "import json, sys",
    "from pathlib import Path",
    "from agents import worker",
    `root = Path(${JSON.stringify(root)})`,
    `urn = ${JSON.stringify(taskUrn(SUBJECT))}`,
    `obsel = ${JSON.stringify(obselServer.url)}`,
    `name = ${JSON.stringify(SUBJECT)}`,
    body,
  ].join("\n");
  return execFileSync("python3", ["-c", script], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, OBSEL_URL: obselServer.url },
  }).trim();
}

/** Whether obsel's own view of the task is `running`, read out of DataHub. */
async function statusOf(): Promise<string | undefined> {
  return (await readTask(taskUrn(SUBJECT)))?.status;
}

beforeAll(async () => {
  await requireDataHub();
  await requireStaleTag();
  requireUvx();

  await registerTask(
    SUBJECT,
    ["raw_orders"],
    ["worker_inflight_output"],
    undefined,
    "In-flight subject",
  );
  root = mkdtempSync(join(tmpdir(), "obsel-worker-"));
  // Registered before the server starts, so its first snapshot already holds the task.
  obselServer = await startObsel(PORT, FLOW_ID);

  return async () => {
    rmSync(root, { recursive: true, force: true });
    await obselServer.stop();
    await closeMcpClient();
  };
});

afterAll(() => {
  /*
   * Leave the task not-running, so a later run of this file starts from a known state
   * rather than inheriting a wedge from this one. Failure is swallowed: this is cleanup,
   * and a cleanup error reported as a test failure hides whichever assertion actually
   * broke.
   */
  try {
    python("worker.abandon_run(urn, obsel)");
  } catch {
    // Nothing to do about it here, and nothing worth failing the suite over.
  }
});

/*
 * Every test starts from "not running, no marker".
 *
 * Without this they leaked into each other, and the leak was instructive rather than
 * incidental: the test that clears the marker deliberately leaves obsel AT running, since
 * the marker and obsel's status are independent and that independence is the point of the
 * file. The next test then announced into a task obsel already held at running and got the
 * refusal it should have got. Both halves are real state, so both halves have to be reset.
 */
beforeEach(() => {
  python("worker._leave_running(name, root)");
  try {
    python("worker.abandon_run(urn, obsel)");
  } catch {
    // Already not running. `abandon_run` is not idempotent at the HTTP layer, and this
    // is setup rather than an assertion.
  }
});

describe("the in-flight marker records that this worker announced a start", () => {
  it("announces, writes the marker, and moves obsel to running", async () => {
    const result = python("print(worker._enter_running(name, urn, obsel, root))");
    expect(result).toBe("announced");
    expect(existsSync(join(root, ".obsel", "state", "inflight", `${SUBJECT}.json`))).toBe(true);
    // The status obsel actually holds, read back out of DataHub rather than inferred
    // from the announcement returning.
    expect(await statusOf()).toBe("running");
  });

  it("resumes instead of re-announcing when obsel really does hold it at running", async () => {
    // The retry path: a worker that died after announcing must skip the announcement
    // rather than fail on it, because obsel refuses a second `start` and is right to.
    expect(python("print(worker._enter_running(name, urn, obsel, root))")).toBe("announced");

    const result = python("print(worker._enter_running(name, urn, obsel, root))");

    expect(result).toBe("resumed");
    expect(await statusOf()).toBe("running");
  });

  it("clears the marker without touching obsel's status", async () => {
    // Two independent facts, and this only owns one of them. `_leave_running` is called
    // once a completion has been reported, so obsel's status is the coordinator's to
    // change, not the marker's.
    python("worker._enter_running(name, urn, obsel, root)");
    const marker = join(root, ".obsel", "state", "inflight", `${SUBJECT}.json`);
    expect(existsSync(marker)).toBe(true);

    python("worker._leave_running(name, root)");

    expect(existsSync(marker)).toBe(false);
    expect(await statusOf()).toBe("running");
  });
});

describe("the marker decides only whether to ask; obsel decides what is true", () => {
  it("re-announces when the marker survives but obsel does not hold it at running", async () => {
    /*
     * The rule this file exists for. A local file outlives the state it describes:
     * obsel may have been reset, or the swarm re-registered. Trusting the marker to
     * describe obsel would be the exact defect obsel exists to catch — describing a
     * remote system from something local that was never checked — and the consequence
     * here is concrete: the worker would report a completion for a run obsel never saw
     * begin.
     *
     * Set up for real. The marker is written by a genuine announce, then obsel is moved
     * off `running` by a genuine abandon, leaving the marker stale on disk.
     */
    expect(python("print(worker._enter_running(name, urn, obsel, root))")).toBe("announced");
    python("worker.abandon_run(urn, obsel)");
    expect(await statusOf()).not.toBe("running");
    // The marker is still there, and still says this worker owns a running task.
    expect(existsSync(join(root, ".obsel", "state", "inflight", `${SUBJECT}.json`))).toBe(true);

    const result = python("print(worker._enter_running(name, urn, obsel, root))");

    expect(result).toBe("announced");
    expect(await statusOf()).toBe("running");
  });

  it("hands a failed run's announcement back, so nothing is left wedged at running", async () => {
    /*
     * The other half. A task left at `running` is skipped by the cascade, so it is
     * invisible to every later traversal while the board still shows it as work in
     * flight. `_abandon_running` is what keeps a crashed agent from leaving one.
     */
    python("worker._enter_running(name, urn, obsel, root)");
    expect(await statusOf()).toBe("running");

    python("worker._abandon_running(name, urn, obsel, root)");

    expect(await statusOf()).not.toBe("running");
    // And the marker went with it, so the next attempt is an ordinary run.
    expect(existsSync(join(root, ".obsel", "state", "inflight", `${SUBJECT}.json`))).toBe(false);
  });

  it("keeps the marker when the hand-back itself fails, rather than losing the resume", async () => {
    /*
     * `_abandon_running` swallows its own failure on purpose: it runs inside an
     * `except` block, and obsel being unreachable there would replace the thing that
     * actually broke — "Codex is not signed in" — with a connection error about
     * cleanup. What it must NOT do is remove the marker anyway, because the marker is
     * what makes the next attempt a resume rather than a silently wedged task.
     *
     * The unreachable obsel is real, not simulated: a port nothing is listening on.
     */
    python("worker._enter_running(name, urn, obsel, root)");
    const marker = join(root, ".obsel", "state", "inflight", `${SUBJECT}.json`);
    expect(existsSync(marker)).toBe(true);

    python('worker._abandon_running(name, urn, "http://127.0.0.1:1", root)');

    expect(existsSync(marker)).toBe(true);
    // obsel still holds it at running, which is the truth the marker now describes.
    expect(await statusOf()).toBe("running");
  });
});
