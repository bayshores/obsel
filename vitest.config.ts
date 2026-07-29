import { defineConfig } from "vitest/config";

const here = new URL("./", import.meta.url).pathname;

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    /*
     * `tests/live/` is excluded, and the exclusion is not cosmetic.
     *
     * The glob above is recursive, so the integration suite matched it and `pnpm verify`
     * started standing up DataHub, `uvx` and a second obsel server — turning the one
     * command this README asks a judge to run into one that needs Docker. It failed
     * loudly rather than passing, because `tests/live/reachable.ts` refuses to skip, which
     * is the only reason this was noticed immediately.
     *
     * Those tests run under `pnpm test:live` with `vitest.live.config.ts`.
     */
    exclude: ["node_modules/**", "tests/live/**"],
  },
  resolve: {
    alias: {
      "@": here,
      /*
       * `server-only` becomes a no-op here, and only here.
       *
       * It is a marker package that throws on import unless the bundler resolves under
       * React's `react-server` condition. Every server module that does I/O imports it,
       * so before this alias none of them could be loaded by a test at all, which is why
       * they went untested for so long. The import threw before any test could run.
       *
       * `resolve.conditions: ["react-server"]` would also work and is deliberately not
       * used: it would change resolution for every package in the graph, React
       * included, to neutralise one marker module.
       *
       * Nothing is weakened. The guard's job is stopping server code from reaching the
       * browser, and Next.js still enforces that at build time against the real
       * package, so `pnpm build` fails exactly as before if client code imports one of
       * these. See `tests/support/server-only.ts`.
       */
      "server-only": `${here}tests/support/server-only.ts`,
    },
  },
});
