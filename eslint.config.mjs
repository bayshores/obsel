import { readFileSync, readdirSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

/**
 * Every module that has declared itself server-only, read off the marker.
 *
 * Enumerated from disk rather than listed here, for the reason
 * `tests/dashboard-tokens.test.ts` gives about its own stylesheet walk: a list
 * written by hand covers whatever existed the day it was written, and the
 * failure is silent, because a module missing from it is simply not checked.
 *
 * Returned as `**`-prefixed patterns so a relative spelling is caught as well
 * as the `@/src/...` alias every file here actually uses.
 */
function serverOnlyModules(root) {
  const patterns = [];
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    if (!readFileSync(path, "utf8").startsWith('import "server-only";')) continue;
    const withoutExtension = relative(root, path).replace(/\.tsx?$/, "");
    patterns.push(`**/${withoutExtension.split(sep).join(posix.sep)}`);
  }
  return patterns.sort();
}

/**
 * `src/features/` is browser code and must never import a server-only module.
 *
 * The rule was prose in CLAUDE.md and enforced only by `pnpm build`, which
 * catches it late and only for code the build actually reaches. Type-only
 * imports stay allowed: they are erased before anything ships, and the feature
 * code reads the coordinator's types on every screen.
 *
 * `src/server/coordinator/erasure.ts` and its pure neighbours carry no marker on
 * purpose and stay importable. That is the distinction being enforced -- pure
 * deterministic logic is shared, anything that does I/O is not.
 */
const noServerImports = {
  files: ["src/features/**/*.{ts,tsx}"],
  rules: {
    "@typescript-eslint/no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: serverOnlyModules("src"),
            allowTypeImports: true,
            message:
              "This module is marked server-only and browser code must not import its values. " +
              "Import the type, or move the pure part into a module with no marker.",
          },
        ],
      },
    ],
  },
};

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  globalIgnores([
    // `.next/**` anchors at the repository root, so it does not cover a build
    // inside a nested checkout. `**/.next/**` does, and both are kept: the
    // anchored one states the ordinary case.
    ".next/**",
    "**/.next/**",
    "node_modules/**",
    "**/node_modules/**",
    "coverage/**",
    "agents/**",
    "examples/**",
    ".obsel/**",
    /*
     * Everything the local tooling keeps beside the repository, which `.gitignore`
     * already excludes.
     *
     * This is here because `pnpm verify` failed for a reason that had nothing to
     * do with obsel: a git worktree created under `.claude/worktrees/` had been
     * built, and eslint walked its `.next/` output and reported 504 errors in
     * generated JavaScript. Working in worktrees is ordinary now, so a lint run
     * that fails whenever one exists is a gate people learn to ignore.
     */
    ".claude/**",
    /*
     * Vendored agent skills, for the same reason: `npx skills add` writes other
     * projects' markdown here, and its embedded TypeScript examples are written
     * to read well rather than to pass this repository's rules. Linting them
     * reported 92 errors in documentation nobody here maintains.
     */
    ".agents/**",
    /*
     * The hosted verifier's build output. It embeds the vendored @noble and
     * buffer code, which is other people's JavaScript; `site/` itself, the
     * source, is linted like everything else.
     */
    "site/dist/**",
  ]),
  noServerImports,
]);
