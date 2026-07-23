import { defineConfig } from "vitest/config";

const here = new URL("./", import.meta.url).pathname;

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
  resolve: {
    alias: {
      "@": here,
      /*
       * `server-only` becomes a no-op here, and only here.
       *
       * It is a marker package that throws on import unless the bundler resolves under
       * React's `react-server` condition. `engine.ts`, `client.ts` and `mcp.ts` all
       * import it, so before this alias none of the three could be loaded by a test at
       * all — which is the mechanical reason `hackathon.md` lists them as the
       * repository's most honest weakness. The import threw before any test could run.
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
