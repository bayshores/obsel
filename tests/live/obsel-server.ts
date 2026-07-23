/**
 * A real obsel server, started for the integration suite on a port of its own.
 *
 * `agents/worker.py` does not talk to DataHub. It talks to **obsel's HTTP API**, and
 * that is the thing under test: `announce_start`, `abandon_run`, `obsel_task` and
 * `report_completion` are the worker's whole relationship with the coordinator.
 *
 * Which forces this. A server reads `OBSEL_FLOW_ID` once, at its own startup, so the
 * `pnpm dev` instance an operator has open is pinned to the demo's flow for its lifetime.
 * Pointing the worker at that instance means one of two bad things: registering the test
 * subject into the demo's flow, which pollutes the board a judge sees, or watching the
 * worker fail to find a task that genuinely exists — which is what happened first, since
 * `startTask` resolves a URN directly while `obsel_task` reads the flow's snapshot, so
 * the announcement succeeded and the read that followed it could not see the result.
 *
 * Starting an obsel of its own resolves it with nothing stood in for: a real Next server,
 * real routes, real coordinator, real DataHub, pointed at the integration flow.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export interface ObselServer {
  url: string;
  stop(): Promise<void>;
}

/**
 * Start obsel on `port` with `OBSEL_FLOW_ID` set, and resolve once it answers.
 *
 * `next start`, not `next dev`, and that is forced rather than chosen. **Next 16 refuses
 * a second `next dev` in the same directory**: it detects the operator's instance and
 * exits, printing "Another next dev server is already running" with the PID to kill. So a
 * dev server here would work only on a machine where nobody had obsel open, which is
 * every machine except a judge's.
 *
 * `start` serves what `pnpm build` produced, which raises a staleness hazard worth naming:
 * a suite testing an older build than its source would be worse than no suite. `pnpm
 * test:live` therefore runs `pnpm build` first, so what is served is what is checked out.
 */
export async function startObsel(port: number, flowId: string): Promise<ObselServer> {
  const url = `http://127.0.0.1:${port}`;
  const cwd = new URL("../../", import.meta.url).pathname;

  const child: ChildProcess = spawn("pnpm", ["exec", "next", "start", "--port", String(port)], {
    cwd,
    env: { ...process.env, OBSEL_FLOW_ID: flowId, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so the whole tree can be signalled on the way out. `next`
    // forks a worker, and killing only the parent leaves the port held and the next run
    // unable to bind.
    detached: true,
  });

  // Kept so a startup failure can say what the server printed rather than only that it
  // timed out. Bounded, because `next dev` is chatty and none of it matters after boot.
  const output: string[] = [];
  const collect = (chunk: Buffer): void => {
    if (output.length < 200) output.push(chunk.toString());
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      setTimeout(() => resolve(), 5_000);
    });
  };

  const deadline = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(
        `obsel exited ${child.exitCode} while starting on ${port}. If this says another dev ` +
          `server is already running, that is Next 16 refusing a second \`next dev\` in one ` +
          `directory, and this helper uses \`next start\` precisely to avoid it:\n` +
          output.join(""),
      );
    }
    try {
      // `/api/swarm` rather than `/`: it proves the coordinator can reach DataHub, which
      // is the part the worker depends on. A 200 on the page would only prove Next is up.
      const response = await fetch(`${url}/api/swarm`, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) break;
    } catch {
      // Still compiling, or not listening yet.
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(
        `obsel did not answer ${url}/api/swarm within 120s. A missing build is the usual ` +
          `cause; \`pnpm test:live\` runs \`pnpm build\` first for exactly that reason.\n` +
          output.join("").slice(-4000),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return { url, stop };
}
