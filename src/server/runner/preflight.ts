import "server-only";

/**
 * The demo's prerequisites, each genuinely checked and each carrying the
 * exact command that fixes it.
 *
 * These exist so the dashboard can guide instead of erroring: "the agents'
 * Python environment does not exist — run these two commands" is guidance,
 * ENOENT three layers deep is not. Every check observes the real thing (a
 * request answered, a file present, an exit code) — none of them consults
 * configuration and calls it truth.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

import { gmsUrl, relationships, tagExists } from "@/src/server/datahub/client";
import { FLOW_URN, MEMBERSHIP_EDGE, STALE_TAG_URN } from "@/src/server/datahub/urns";
import { venvPython } from "./steps";
import type { Preflight, PreflightCheck, RunnerCheck, RunnerName } from "./types";

/**
 * How long a verdict is trusted before it is observed again. Long enough that
 * a 2 s activity poll does not spawn `codex login status` fifty times a
 * minute, short enough that fixing a prerequisite shows up promptly.
 *
 * The runner check can spawn twice when neither CLI is installed, which is the
 * case that most needs the cache.
 */
const CACHE_MS = 10_000;

const RUNNER_TIMEOUT_MS = 5_000;
const UVX_TIMEOUT_MS = 5_000;
const DATAHUB_TIMEOUT_MS = 3_000;

interface Cached {
  at: number;
  value: PreflightCheck;
}

// Survives dev-server module reloads, same reasoning as the launcher's state.
const globalRef = globalThis as typeof globalThis & {
  __obselPreflight?: Map<string, Cached>;
};

function cache(): Map<string, Cached> {
  globalRef.__obselPreflight ??= new Map();
  return globalRef.__obselPreflight;
}

/*
 * Generic over the check's own type, so the runner check keeps its `name` field
 * on the way back out. One cache key always produces one shape, which is what
 * makes the assertion inside safe; a caller cannot reach a key it did not write.
 */
async function cached<T extends PreflightCheck>(key: string, check: () => Promise<T>): Promise<T> {
  const held = cache().get(key);
  if (held && Date.now() - held.at < CACHE_MS) return held.value as T;
  const value = await check();
  cache().set(key, { at: Date.now(), value });
  return value;
}

/**
 * Two questions, because they fail separately and only the second one decides
 * whether obsel can do anything.
 *
 * This asked `GET /config` and nothing else until 2026-07-24, when the board sat
 * on "This page lost its connection" with all four prerequisites ticked green.
 * DataHub's search container had exited four hours earlier. GMS stayed up and
 * kept answering `/config`, because that reply is served from the process rather
 * than from any index, so the checklist reported a healthy DataHub while every
 * read the board makes was coming back 500.
 *
 * That is the worst shape a check can have. A missing check leaves the reader
 * looking; a green check that is wrong sends them looking inside obsel, which is
 * the one place the fault was not.
 *
 * So the second probe is the exact call `readSnapshot` opens with. It reads the
 * graph store, which is the half that went down, and it is the half obsel cannot
 * work without: every traversal is `GET /relationships`. Whatever blinds the
 * board now fails this check first.
 */
async function checkDataHub(): Promise<PreflightCheck> {
  const url = `${gmsUrl()}/config`;
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(DATAHUB_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        ok: false,
        detail: `DataHub answered ${response.status} at ${url}, which is not a working reply`,
        fix: "datahub docker quickstart",
      };
    }
  } catch {
    return {
      ok: false,
      detail: `Nothing answered at ${url}. DataHub is not running, or Docker is not.`,
      fix: "datahub docker quickstart",
    };
  }

  try {
    await relationships(FLOW_URN, "INCOMING", MEMBERSHIP_EDGE);
  } catch (error) {
    const status = error instanceof Error && "status" in error ? error.status : null;
    return {
      ok: false,
      detail:
        `DataHub is running at ${gmsUrl()}, but it could not answer what is connected to ` +
        `what${typeof status === "number" ? ` (${status})` : ""}. That question is served by ` +
        `DataHub's search index, which can stop while the rest of it keeps running.`,
      fix: "datahub docker quickstart",
    };
  }

  return {
    ok: true,
    detail: `DataHub answered at ${gmsUrl()}, and obsel could read the agents from it.`,
    fix: null,
  };
}

async function checkVocabulary(datahubOk: boolean): Promise<PreflightCheck> {
  if (!datahubOk) {
    // No fix command of its own: DataHub has to answer before this can even
    // be asked, and a second command here would send people in two directions.
    return { ok: false, detail: "Cannot be checked until DataHub answers.", fix: null };
  }
  try {
    const present = await tagExists(STALE_TAG_URN);
    return present
      ? { ok: true, detail: "The obsel-stale tag is in DataHub.", fix: null }
      : {
          ok: false,
          detail:
            "The obsel-stale tag is not in DataHub yet. obsel cannot create it while running, so it would find out-of-date work and have nowhere to record it.",
          fix: "agents/.venv/bin/python -m agents.run setup",
        };
  } catch (cause) {
    return {
      ok: false,
      detail: `Asking DataHub for the tag failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      fix: null,
    };
  }
}

function checkVenv(): PreflightCheck {
  const python = venvPython(process.cwd());
  return existsSync(python)
    ? { ok: true, detail: "The demo agents have their Python packages.", fix: null }
    : {
        ok: false,
        detail:
          "They are separate from the Node packages, and `pnpm install` does not create them.",
        fix: "python3 -m venv agents/.venv && agents/.venv/bin/python -m pip install -r agents/requirements.txt",
      };
}

/**
 * The tool obsel's own tag write runs through.
 *
 * `mcp.ts` spawns DataHub's MCP server as bare `uvx`, resolved through PATH at
 * spawn time, so this asks the same question that spawn will: does the name
 * resolve here. Its absence is the quietest failure in the checklist — the
 * staleness engine still decides correctly and every downstream task is still
 * found, and the tag that records any of it is the part that fails.
 */
function checkUvx(): Promise<PreflightCheck> {
  return new Promise((resolve) => {
    execFile("uvx", ["--version"], { timeout: UVX_TIMEOUT_MS }, (error) => {
      if (error === null) {
        resolve({ ok: true, detail: "uv is installed.", fix: null });
        return;
      }
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      resolve({
        ok: false,
        detail: missing
          ? "obsel writes its tag through DataHub's own MCP server, which is started with uvx. Without it obsel finds out-of-date work and cannot record it."
          : `uvx is installed but did not answer: ${error.message}`,
        fix: "brew install uv",
      });
    });
  });
}

/**
 * Which coding CLI runs the demo agents, and whether it is ready.
 *
 * This is the TypeScript half of the rule in `agents/runner_select.py`, and the
 * two have to agree: a checklist that ticked green for Codex while the worker
 * ran Claude Code would be a passing check above a failing run. `OBSEL_RUNNER`
 * is read from the same environment the launcher hands the worker, so there is
 * one answer per machine rather than one per process.
 *
 * One row on the checklist, never two. The runner not selected is never
 * invoked, so reporting it missing is a failure the demo would never hit.
 */
/*
 * Two names per runner, not one. `cli` is the thing an operator installs and is
 * the subject of a sentence; `product` is what goes in "a real ___ session".
 * They differ for Codex -- "The Codex CLI is not installed" against "a real
 * Codex session" -- and one shared string produces "a real The Codex CLI
 * session", which is how this was first written.
 */
const RUNNER_AUTH: Record<
  RunnerName,
  { argv: string[]; cli: string; product: string; signIn: string }
> = {
  codex: {
    argv: ["login", "status"],
    cli: "The Codex CLI",
    product: "Codex",
    signIn: "codex login",
  },
  claude: {
    argv: ["auth", "status"],
    cli: "Claude Code",
    product: "Claude Code",
    signIn: "claude auth login",
  },
};

/** Ask one CLI whether it is there and signed in. `installed` separates the two failures. */
function probeRunner(name: RunnerName): Promise<{ check: RunnerCheck; installed: boolean }> {
  const { argv, cli, product, signIn } = RUNNER_AUTH[name];
  return new Promise((resolve) => {
    execFile(name, argv, { timeout: RUNNER_TIMEOUT_MS }, (error) => {
      if (error === null) {
        resolve({
          check: { ok: true, detail: `${cli} is signed in.`, fix: null, name },
          installed: true,
        });
        return;
      }
      // ENOENT is "not installed", any exit code is "not signed in" — two
      // different problems with two different fixes.
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      resolve({
        check: missing
          ? {
              ok: false,
              detail: `${cli} is not installed. Each demo agent is a real ${product} session, and there is no way to run them with an API key instead.`,
              fix: null,
              name,
            }
          : {
              ok: false,
              detail: `Each demo agent is a real ${product} session, so no agent can run until it is.`,
              fix: signIn,
              name,
            },
        installed: !missing,
      });
    });
  });
}

async function checkRunner(): Promise<RunnerCheck> {
  const chosen = (process.env.OBSEL_RUNNER ?? "").trim();

  if (chosen !== "") {
    if (chosen !== "codex" && chosen !== "claude") {
      // Reported rather than ignored. A typo that fell back would run a product
      // the operator did not name, and the board would say it went fine.
      return {
        ok: false,
        detail: `OBSEL_RUNNER is set to "${chosen}", which is not a runner obsel knows. Valid values are codex and claude.`,
        fix: null,
        name: null,
      };
    }
    // An explicit choice is never second-guessed, so a missing CLI reports the
    // one that was asked for rather than quietly switching.
    return (await probeRunner(chosen)).check;
  }

  const codex = await probeRunner("codex");
  if (codex.installed) return codex.check;
  const claude = await probeRunner("claude");
  if (claude.installed) return claude.check;

  return {
    ok: false,
    detail:
      "Neither the Codex CLI nor Claude Code is installed, and the demo agents are real sessions of one of them. Installing either is enough. Everything else on this page works without one.",
    fix: null,
    name: null,
  };
}

/** Every check, concurrently where independent. Never throws — a failed check is a value. */
export async function preflight(): Promise<Preflight> {
  // Keyed by the address, not by the bare word: the verdict is about one GMS,
  // and a cache key that does not name it hands the answer for the old address
  // to the new one.
  const [datahub, runner, uvx] = await Promise.all([
    cached(`datahub:${gmsUrl()}`, checkDataHub),
    // Keyed by the choice, not the bare word, for the same reason as the GMS
    // address above: changing OBSEL_RUNNER asks a different question, and a key
    // that does not name it would hand back the old runner's verdict.
    cached(`runner:${process.env.OBSEL_RUNNER ?? ""}`, checkRunner),
    cached("uvx", checkUvx),
  ]);
  const vocabulary = await cached(`vocabulary:${datahub.ok}`, () => checkVocabulary(datahub.ok));
  return { datahub, vocabulary, venv: checkVenv(), uvx, runner };
}
