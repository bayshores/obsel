/**
 * A no-op stand-in for the `server-only` package, used by `vitest.config.ts`.
 *
 * `server-only` is a marker: importing it throws unless the bundler resolves under
 * React's `react-server` condition, which is how Next.js guarantees a module never
 * reaches the browser. `src/server/coordinator/engine.ts`,
 * `src/server/datahub/client.ts` and `mcp.ts` all import it, and vitest does not set
 * that condition, so **none of those three modules could be imported by a test at
 * all**. That is the mechanical reason `hackathon.md` has listed them as the
 * repository's most honest weakness since the first commit: not that testing them was
 * judged unimportant, but that the import threw before any test could run.
 *
 * This is the same thing the real package resolves to under `react-server` — its own
 * `empty.js`. Aliasing directly to that file is not possible, because
 * `server-only`'s `exports` map declares only `"."`, so the subpath is unreachable.
 *
 * **What this does not weaken.** The guard exists to stop server code reaching the
 * browser, and that is enforced by Next.js at build time, where the real package is
 * still resolved: `pnpm build` fails exactly as before if a client component imports
 * one of these modules. This alias applies to vitest and nowhere else, so the
 * protection is unchanged and the modules become reachable by a test.
 */

export {};
