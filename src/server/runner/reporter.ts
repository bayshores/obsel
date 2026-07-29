import "server-only";

/**
 * Hands a table somebody typed at the table form to `agents/report.py`, and waits.
 *
 * Unlike `launchStep` beside it this is spawn-and-wait rather than
 * spawn-and-poll, and the difference is what the two are for. A demo step runs
 * real agent sessions for minutes, so the board watches it through
 * `GET /api/demo/activity`. A table form report is one hash and one POST, and the
 * person who pressed the button is looking at it, so the answer comes back on
 * the same request.
 *
 * **Why a process at all, when the browser could hash in TypeScript.** Because
 * then there would be two implementations of the fingerprint, and obsel decides
 * staleness by comparing fingerprints. `agents/mcp_core.py` opens by saying two
 * paths to one recorded fingerprint would be two answers to the question obsel
 * exists to answer. A TypeScript port would agree on the day it was written and
 * drift on some later one, and the failure would be silent: a table reported
 * from the table form and the same table reported by an agent would disagree, and
 * obsel would announce a change nobody made. About 200 ms of process start is
 * the price of there being one answer, and it is invisible behind a button.
 *
 * This executes a local process, exactly as `launcher.ts` does and for the same
 * reason: obsel's demo is a local tool on the machine that owns the DataHub
 * stack, and nothing in this repository exposes these routes beyond localhost.
 * Nothing from the request reaches a shell — the argv is fixed, the table goes
 * in over stdin, and `spawn` is given an argument list rather than a command
 * line.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { venvPython } from "./steps";

/** How long a table form report may take before the browser is told it is unknown. */
const REPORT_TIMEOUT_MS = 300_000;

/** What the table form asks for: one task, its tables, as typed. */
export interface ReportRequest {
  taskUrn: string;
  outputs: Record<string, { columns: string[]; rows: Record<string, unknown>[] }>;
}

export type ReportOutcome =
  | { ok: true; coordination: unknown; computedFingerprints: unknown }
  | { ok: false; error: string; fix?: string; status: number };

/**
 * The refusal a missing Python environment gets.
 *
 * Named rather than inlined because it is the one failure a reader can act on,
 * and the guide's prerequisite list already teaches this exact command. A table form
 * offered on a machine with no venv would otherwise fail with a spawn error the
 * reader has no way to interpret.
 */
function missingVenv(): ReportOutcome {
  return {
    ok: false,
    error: "obsel needs the demo agents' Python packages to hash a table, and they are not set up.",
    fix: "python3 -m venv agents/.venv && agents/.venv/bin/pip install -r agents/requirements.txt",
    status: 503,
  };
}

/**
 * Run one report to completion.
 *
 * `origin` is this server's own address as the request saw it, passed to the
 * child as `OBSEL_URL` for exactly the reason `launcher.ts` records: the agents
 * default to port 3000, so a child spawned by an obsel on another port would
 * report to whatever else was listening. Found the hard way on 2026-07-24.
 */
export async function runReport(request: ReportRequest, origin: string): Promise<ReportOutcome> {
  const repoRoot = process.cwd();
  const python = venvPython(repoRoot);
  if (!existsSync(python)) return missingVenv();

  return new Promise<ReportOutcome>((resolve) => {
    const child = spawn(python, ["-u", "-m", "agents.report"], {
      cwd: repoRoot,
      env: { ...process.env, PYTHONUNBUFFERED: "1", OBSEL_URL: origin },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    let settled = false;
    const settle = (outcome: ReportOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    /*
     * A timeout is an UNKNOWN outcome and is worded as one.
     *
     * `agents/worker.py` explains the 300 s ceiling it mirrors: obsel answers a
     * completion only once the whole traversal is written and confirmed, and a
     * loaded DataHub has genuinely outrun a shorter client while the server
     * finished the work. Telling the reader "it failed" would be telling them
     * the opposite of what is true, so this says obsel stopped waiting and
     * points at the board, which is the only account either of us can trust.
     */
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      settle({
        ok: false,
        error:
          "obsel stopped waiting for the report. It may still have landed — the graph says which.",
        status: 504,
      });
    }, REPORT_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });

    child.on("error", (cause) => {
      settle({
        ok: false,
        error: `obsel could not run the reporter: ${cause.message}`,
        status: 500,
      });
    });

    child.on("close", () => {
      // The child prints one JSON object either way, including for its own
      // refusals, so the exit code is not consulted: the object is the answer.
      // Only an unparseable stdout is a genuine surprise, and then stderr is
      // the only thing left that might say why.
      let parsed: unknown;
      try {
        parsed = JSON.parse(out.trim());
      } catch {
        const detail = err.trim() || out.trim() || "it printed nothing";
        settle({ ok: false, error: `The reporter did not answer in JSON: ${detail}`, status: 500 });
        return;
      }
      if (typeof parsed !== "object" || parsed === null || !("ok" in parsed)) {
        settle({ ok: false, error: "The reporter's answer had no result in it.", status: 500 });
        return;
      }
      const reply = parsed as { ok: unknown; error?: unknown };
      if (reply.ok !== true) {
        settle({
          ok: false,
          error: typeof reply.error === "string" ? reply.error : "The report was refused.",
          // 422: the table or the task was wrong, which is the caller's to fix.
          // Not 500 — obsel worked exactly as intended in refusing it.
          status: 422,
        });
        return;
      }
      const good = parsed as { coordination?: unknown; computedFingerprints?: unknown };
      settle({
        ok: true,
        coordination: good.coordination ?? null,
        computedFingerprints: good.computedFingerprints ?? null,
      });
    });

    child.stdin.end(JSON.stringify(request), "utf8");
  });
}
