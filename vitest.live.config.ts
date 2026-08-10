import { defineConfig } from "vitest/config";

const here = new URL("./", import.meta.url).pathname;

/**
 * The integration suite: obsel against a real DataHub and a real MCP server.
 *
 * Nothing here is stood in for. `pnpm test` covers the pure logic — functions taking
 * data and returning data, which need no stand-in and have none. Everything that
 * crosses a process boundary is covered here instead, against the actual thing, because
 * a stand-in can only encode what its author believes. That is not hypothetical: an
 * earlier fake GMS attributed its propagation delay to a finding that says something
 * else, and its tests agreed with the mistake.
 *
 * Requires, and fails loudly rather than skipping if missing:
 *
 * - DataHub up (`datahub docker quickstart`), GMS answering on 8080.
 * - `uvx` on PATH, for `mcp-server-datahub==0.6.0`.
 * - `urn:li:tag:obsel-stale` registered (`agents.run setup`), since obsel cannot mint
 *   vocabulary at runtime.
 *
 * **`OBSEL_FLOW_ID` is set here, in the config, and that placement is load bearing.**
 *
 * The first attempt set it at the top of a test file, above the imports:
 *
 * ```ts
 * process.env.OBSEL_FLOW_ID = "obsel_it_engine";   // does NOT work
 * import { … } from "./reachable";                  // hoisted above the line above
 * ```
 *
 * ESM hoists static imports, so `reachable.ts` — and through it `urns.ts`, whose
 * `FLOW_URN` is a module-load constant — was evaluated *before* the assignment ran. The
 * suite therefore registered into the demo's own `orders_pipeline` and ran `resetSwarm`
 * against it, which is exactly the destruction the override exists to prevent. It was
 * caught by the assertion in `engine.live.test.ts` that the flow is not the demo's,
 * which is why that assertion is first in the file.
 *
 * Set here it is in the environment before any test module is loaded, so there is no
 * ordering to get wrong. Every live file therefore shares this one flow, which is fine:
 * `fileParallelism` is off, so they never run at the same time.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/live/**/*.live.test.ts"],
    /*
     * Prints, after the summary, which agent CLI this run did not exercise.
     *
     * `runners.live.test.ts` skips a runner that is not installed, which is the one
     * skip in this suite and the one place the "never skip, fail loudly" rule above
     * is not kept. The trade is deliberate: requiring both CLIs would stop a machine
     * with one from running the suite at all. What must not happen is a green summary
     * being read as evidence about both, so the gap is printed below the counts,
     * where a skipped `describe` line scrolled off the top of a ten-file run would
     * not be seen.
     */
    globalSetup: ["tests/live/runner-coverage.ts"],
    env: {
      OBSEL_FLOW_ID: "obsel_integration_tests",
    },
    // One file at a time. They share one DataHub, and `uvx mcp-server-datahub` is a
    // subprocess per worker, so parallel files would fight over both.
    fileParallelism: false,
    sequence: { concurrent: false },
    // A real cascade writes several aspects and polls each until DataHub confirms it,
    // and the first `uvx` run may resolve and download the server.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
  resolve: {
    alias: {
      "@": here,
      // See tests/support/server-only.ts. Not a stand-in for behavior: it is the
      // marker package's own no-op, which is what Next resolves it to on the server.
      "server-only": `${here}tests/support/server-only.ts`,
    },
  },
});
