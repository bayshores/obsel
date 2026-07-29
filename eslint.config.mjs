import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

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
  ]),
]);
