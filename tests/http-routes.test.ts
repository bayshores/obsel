/**
 * The HTTP surface, read off the filesystem rather than guessed at.
 *
 * obsel's rules include several routes that must not exist: nothing marks an
 * asset covered, and nothing names a task whose flag should be cleared. Those
 * absences were asserted by sending requests to hand-guessed paths
 * (`tests/live/erasure.live.test.ts`, `tests/live/change-ledger.live.test.ts`),
 * which catches a route only if someone guessed its name in advance. A file
 * added at `app/api/erasure/[id]/close/route.ts` left every suite green.
 *
 * This reads the route tree instead and compares it to the list below, the way
 * `tests/live/obsel-mcp.live.test.ts` compares the MCP tool list to an exact
 * ten names. Adding, moving or removing a route fails here by name, and the
 * person who added it has to write the path down next to the sentence saying
 * what the surface is allowed to contain.
 *
 * It is a unit test on purpose: it reads source files, so it needs no server
 * and no DataHub, and it runs in `pnpm verify` where a live suite does not.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const APP = new URL("../app", import.meta.url).pathname;

/** The methods Next.js treats as route handlers when a `route.ts` exports them. */
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/**
 * Every route obsel serves, path to methods, sorted.
 *
 * Read it as the whole list. There is no `.../clear`, no `.../cover`, no
 * `.../close` and no `/api/changes/clear`, and that is the point of writing it
 * out: the rules those absences carry are in `CLAUDE.md` and in
 * `docs/erasure-coverage.md`, and a convenience route added later contradicts
 * them without contradicting any other test.
 */
const ROUTES: Record<string, string[]> = {
  "/api/changes": ["GET"],
  "/api/datasets/observe": ["POST"],
  "/api/demo/activity": ["GET"],
  "/api/demo/launch": ["POST"],
  "/api/demo/reset": ["POST"],
  "/api/erasure": ["POST"],
  "/api/erasure/[id]": ["GET"],
  "/api/erasure/[id]/evidence": ["GET"],
  "/api/erasure/challenge": ["POST"],
  "/api/erasure/proof": ["POST"],
  "/api/swarm": ["GET"],
  "/api/tasks/abandon": ["POST"],
  "/api/tasks/complete": ["POST"],
  "/api/tasks/register": ["POST"],
  "/api/tasks/report": ["POST"],
  "/api/tasks/start": ["POST"],
  "/api/trace": ["GET"],
};

/** Every `route.*` file under `app/`, as a URL path relative to the site root. */
function routeFiles(directory: string, prefix = ""): { path: string; file: string }[] {
  const found: { path: string; file: string }[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...routeFiles(full, `${prefix}/${entry.name}`));
      continue;
    }
    if (/^route\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) {
      found.push({ path: prefix === "" ? "/" : prefix, file: full });
    }
  }
  return found;
}

/**
 * The HTTP methods a route file exports.
 *
 * Every export form is looked at, not only the `export async function POST`
 * this repository happens to use today, because a route added in another form
 * would otherwise read as a file exporting nothing and slip past the check for
 * that. The zero-method assertion below is what makes a form this misses
 * visible rather than silent.
 */
function exportedMethods(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const exported = new Set<string>();
  for (const match of source.matchAll(
    /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    exported.add(match[1]);
  }
  // `export { handler as POST }` and `export { POST }`.
  for (const clause of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const item of clause[1].split(",")) {
      const name = item
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name !== undefined && name !== "") exported.add(name);
    }
  }
  return HTTP_METHODS.filter((method) => exported.has(method));
}

describe("the routes obsel serves", () => {
  const found = routeFiles(APP);

  it("is exactly the list written down here, path for path", () => {
    expect(found.map((route) => route.path).sort()).toEqual(Object.keys(ROUTES).sort());
  });

  it("answers exactly the methods written down beside each path", () => {
    const actual = Object.fromEntries(
      found.map((route) => [route.path, exportedMethods(route.file)]),
    );
    const expected = Object.fromEntries(
      Object.entries(ROUTES).map(([path, methods]) => [path, [...methods].sort()]),
    );
    expect(
      Object.fromEntries(Object.entries(actual).map(([path, methods]) => [path, methods.sort()])),
    ).toEqual(expected);
  });

  it("finds a handler in every route file, so an export form this misses is not read as absence", () => {
    for (const route of found) {
      expect(
        exportedMethods(route.file).length,
        `${route.file} exports no handler this test recognizes`,
      ).toBeGreaterThan(0);
    }
  });
});
