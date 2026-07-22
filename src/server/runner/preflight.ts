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

import { gmsUrl, tagExists } from "@/src/server/datahub/client";
import { STALE_TAG_URN } from "@/src/server/datahub/urns";
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
        detail: `DataHub answered ${response.status} at ${url}`,
        fix: "datahub docker quickstart",
      };
    }
    return { ok: true, detail: `DataHub answered at ${gmsUrl()}`, fix: null };
  } catch {
    return {
      ok: false,
      detail: `nothing answered at ${url} — DataHub is not running, or Docker is not`,
      fix: "datahub docker quickstart",
    };
  }
}

async function checkVocabulary(datahubOk: boolean): Promise<PreflightCheck> {
  if (!datahubOk) {
    // No fix command of its own: DataHub has to answer before this can even
    // be asked, and a second command here would send people in two directions.
    return { ok: false, detail: "cannot be checked until DataHub answers", fix: null };
  }
  try {
    const present = await tagExists(STALE_TAG_URN);
    return present
      ? { ok: true, detail: `${STALE_TAG_URN} is registered`, fix: null }
      : {
          ok: false,
          detail: `${STALE_TAG_URN} does not exist yet — obsel cannot create it at runtime, so staleness would be detected and silently not recorded`,
          fix: "agents/.venv/bin/python -m agents.run setup",
        };
  } catch (cause) {
    return {
      ok: false,
      detail: `asking DataHub for the tag failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      fix: null,
    };
  }
}

function checkVenv(): PreflightCheck {
  const python = venvPython(process.cwd());
  return existsSync(python)
    ? { ok: true, detail: "agents/.venv exists", fix: null }
    : {
        ok: false,
        detail: "the agents' Python environment (agents/.venv) does not exist yet",
        fix: "python3 -m venv agents/.venv && agents/.venv/bin/python -m pip install -r agents/requirements.txt",
      };
}

function checkCodex(): Promise<PreflightCheck> {
  return new Promise((resolve) => {
    execFile("codex", ["login", "status"], { timeout: CODEX_TIMEOUT_MS }, (error) => {
      if (error === null) {
        resolve({ ok: true, detail: "the Codex CLI is signed in", fix: null });
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
                "the Codex CLI is not installed — each demo agent is a real Codex session, there is no API-key path",
              fix: null,
            }
          : { ok: false, detail: "the Codex CLI is not signed in", fix: "codex login" },
      );
    });
  });
}

/** Every check, concurrently where independent. Never throws — a failed check is a value. */
export async function preflight(): Promise<Preflight> {
  const [datahub, codex] = await Promise.all([
    cached("datahub", checkDataHub),
    cached("codex", checkCodex),
  ]);
  const vocabulary = await cached(`vocabulary:${datahub.ok}`, () => checkVocabulary(datahub.ok));
  return { datahub, vocabulary, venv: checkVenv(), codex };
}
