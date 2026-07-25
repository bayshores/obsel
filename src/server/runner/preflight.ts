import "server-only";

/**
 * The demo's prerequisites, each genuinely checked and each carrying the
 * exact command that fixes it.
 *
 * These exist so the cockpit can guide instead of erroring: "the agents'
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
import type { Preflight, PreflightCheck } from "./types";

/**
 * How long a verdict is trusted before it is observed again. Long enough that
 * a 2 s activity poll does not spawn `codex login status` fifty times a
 * minute, short enough that fixing a prerequisite shows up promptly.
 */
const CACHE_MS = 10_000;

const CODEX_TIMEOUT_MS = 5_000;
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

async function cached(key: string, check: () => Promise<PreflightCheck>): Promise<PreflightCheck> {
  const held = cache().get(key);
  if (held && Date.now() - held.at < CACHE_MS) return held.value;
  const value = await check();
  cache().set(key, { at: Date.now(), value });
  return value;
}

/**
 * Two questions, because they fail separately and only the second one decides
 * whether obsel can do anything.
 *
 * This asked `GET /config` and nothing else until 2026-07-24, when the board sat
 * on "The board lost its connection" with all four prerequisites ticked green.
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
    detail: `DataHub answered at ${gmsUrl()}, and obsel could read the swarm from it.`,
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

function checkCodex(): Promise<PreflightCheck> {
  return new Promise((resolve) => {
    execFile("codex", ["login", "status"], { timeout: CODEX_TIMEOUT_MS }, (error) => {
      if (error === null) {
        resolve({ ok: true, detail: "The Codex CLI is signed in.", fix: null });
        return;
      }
      // ENOENT is "not installed", any exit code is "not signed in" — two
      // different problems with two different fixes.
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      resolve(
        missing
          ? {
              ok: false,
              detail:
                "The Codex CLI is not installed. Each demo agent is a real Codex session, and there is no way to run them with an API key instead.",
              fix: null,
            }
          : {
              ok: false,
              detail: "Each demo agent is a real Codex session, so no agent can run until it is.",
              fix: "codex login",
            },
      );
    });
  });
}

/** Every check, concurrently where independent. Never throws — a failed check is a value. */
export async function preflight(): Promise<Preflight> {
  // Keyed by the address, not by the bare word: the verdict is about one GMS,
  // and a cache key that does not name it hands the answer for the old address
  // to the new one.
  const [datahub, codex] = await Promise.all([
    cached(`datahub:${gmsUrl()}`, checkDataHub),
    cached("codex", checkCodex),
  ]);
  const vocabulary = await cached(`vocabulary:${datahub.ok}`, () => checkVocabulary(datahub.ok));
  return { datahub, vocabulary, venv: checkVenv(), codex };
}
