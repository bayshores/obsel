/**
 * What a re-registration of an existing task is allowed to do to the record
 * already on file.
 *
 * Pure, and deliberately not behind the `server-only` guard `client.ts` carries,
 * for the same reason `task-record.ts` is not: a decision living behind that
 * marker is a decision no test can check. `client.ts` is the only caller.
 *
 * The two questions here are asked in this order:
 *
 * 1. Is this the same declaration that is already on file? Then nothing is
 *    written at all. This is the rule the MCP door already keeps
 *    (`agents/mcp_server.py`, which answers `alreadyRegistered` without posting)
 *    and the HTTP door did not, so a curl caller or the page's own form could
 *    walk around it.
 * 2. If the declaration genuinely differs, what does the new aspect carry over
 *    from the old one? Everything, minus the fields the declaration itself
 *    restates.
 *
 * Both exist for one reason. A DataJob's `dataJobInfo` is written through the
 * OpenAPI v3 upsert, which replaces the whole aspect, so a registration that
 * rebuilt `customProperties` from the declaration alone erased the recorded
 * fingerprints, `finishedAt`, the previous fingerprints, the reader-observed
 * ones and any stale mark. The next completion then found no baseline for its
 * own output, `compareFingerprints` read that as a first run, and a real change
 * was reported as no change at all — nothing downstream marked, nothing said.
 * That is the false-clean direction, and re-declaring a task you already own is
 * an ordinary thing for an agent to do.
 */

import type { TaskRecord } from "@/src/server/coordinator/types";
import { PROP } from "./properties";

/**
 * What a registration did, alongside the record it is about.
 *
 * `alreadyRegistered` is the marker the MCP door has always returned, now said
 * by the door underneath it so both doors say it for the same reason. It means
 * nothing was written, so nothing that was on file was touched.
 */
export interface RegistrationOutcome {
  task: TaskRecord;
  alreadyRegistered: boolean;
}

/**
 * What a registration says about a task, in the terms DataHub stores.
 *
 * `volatile` is the canonical JSON string `client.ts` already builds for the
 * immutability check rather than the record, so the two comparisons cannot
 * disagree about what "the same list" means.
 */
export interface Declaration {
  reads: string[];
  writes: string[];
  volatile: string;
  title: string | null;
  description: string | null;
}

/**
 * Set comparison, matching `lineage_matches` in `agents/mcp_core.py`.
 *
 * The order an agent lists its tables in is not part of what it declared, and
 * neither is naming one twice.
 */
function sameTables(left: string[], right: string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/** Whether a task on file already declares exactly this. */
export function sameDeclaration(existing: Declaration, declared: Declaration): boolean {
  return (
    sameTables(existing.reads, declared.reads) &&
    sameTables(existing.writes, declared.writes) &&
    existing.volatile === declared.volatile &&
    existing.title === declared.title &&
    existing.description === declared.description
  );
}

/**
 * The `customProperties` a re-registration writes: what was there, then what the
 * declaration restates.
 *
 * Read-modify-write, the same idiom as `updateTaskProperties`, and here for the
 * same reason: the upsert replaces the aspect, so anything not carried is gone.
 * Carrying everything rather than a named list of evidence fields is deliberate.
 * A list has to be kept in step with `properties.ts`, and the field that gets
 * forgotten is lost silently — `obsel.fingerprints` going missing reads as a
 * first run, which reads as nothing changed.
 *
 * Two keys are held back from the declaration when the record already has them:
 *
 * - `status`, because a re-declaration is not a report that the work was undone.
 *   It also carries the stale mark: `parseStale` discards a mark on a task whose
 *   status is `registered`, so resetting the status would drop the mark while
 *   leaving its properties behind.
 * - `client.registered`, which `properties.ts` states is written once, since it
 *   records who put the task on the board.
 */
export function registrationProperties(
  existing: Record<string, string> | undefined,
  declared: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = { ...existing, ...declared };
  for (const key of [PROP.status, PROP.clientRegistered]) {
    const held = existing?.[key];
    if (held !== undefined) merged[key] = held;
  }
  return merged;
}
