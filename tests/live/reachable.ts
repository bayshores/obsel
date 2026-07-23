/**
 * Preconditions for the integration suite, checked loudly.
 *
 * **These never skip.** A suite that quietly passes when DataHub is down is worse than
 * no suite: it reports green for a path nothing exercised, which is the same shape of
 * failure obsel exists to catch — an absence read as an all-clear. So a missing
 * prerequisite throws, with the command that fixes it.
 */

import { execFileSync } from "node:child_process";

import { STALE_TAG_URN } from "@/src/server/datahub/urns";

export const GMS = process.env.DATAHUB_GMS_URL ?? "http://localhost:8080";

/** GMS answering, or a named failure with the fix. */
export async function requireDataHub(): Promise<void> {
  let version: string;
  try {
    const response = await fetch(`${GMS}/config`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`GMS answered ${response.status}`);
    const body = (await response.json()) as { versions?: unknown };
    version = JSON.stringify(body.versions ?? "unknown");
  } catch (cause) {
    throw new Error(
      `the integration suite needs DataHub running, and ${GMS}/config did not answer ` +
        `(${cause instanceof Error ? cause.message : String(cause)}).\n` +
        `  Fix: datahub docker quickstart\n` +
        `  Port 8080 is GMS. Port 9002 is the frontend proxy and will not answer this.\n` +
        `  These tests are not skipped when DataHub is absent, because a green run for a ` +
        `path nothing exercised is the exact failure obsel exists to catch.`,
    );
  }
  if (process.env.OBSEL_LIVE_QUIET !== "1") {
    console.log(`  DataHub reachable at ${GMS}, versions ${version}`);
  }
}

/**
 * The stale tag registered, which obsel cannot create at runtime.
 *
 * Read with the genuine-404 predicate rather than `GET /entities/<urn>`, which
 * fabricates a well-formed response for any syntactically valid URN and would report
 * every tag as present.
 */
export async function requireStaleTag(): Promise<void> {
  const response = await fetch(
    `${GMS}/openapi/v3/entity/tag/${encodeURIComponent(STALE_TAG_URN)}`,
    { signal: AbortSignal.timeout(5_000) },
  );
  if (response.status === 404) {
    throw new Error(
      `${STALE_TAG_URN} is not registered in this DataHub, and obsel cannot create a tag ` +
        `at runtime: open-source Core's MCP surface has add_tags and no create_tag.\n` +
        `  Fix: agents/.venv/bin/python -m agents.run setup`,
    );
  }
  if (!response.ok) throw new Error(`reading ${STALE_TAG_URN} answered ${response.status}`);
}

/** `uvx` on PATH, without which the MCP server cannot start. */
export function requireUvx(): void {
  try {
    execFileSync("uvx", ["--version"], { stdio: "pipe" });
  } catch (cause) {
    throw new Error(
      `\`uvx\` is not on PATH, so the DataHub MCP server cannot be started and obsel ` +
        `cannot mark anything stale (${cause instanceof Error ? cause.message : String(cause)}).\n` +
        `  Fix: install uv, e.g. curl -LsSf https://astral.sh/uv/install.sh | sh`,
    );
  }
}

/**
 * The `codex` CLI installed and signed in, without which no agent can do its job.
 *
 * Checked through `codex_runner.codex_version` rather than a bare `which`, because that
 * function is itself the preflight the demo runs and its failure message is the one an
 * operator is meant to see. Signed-out is not detected here: `codex --version` answers
 * without an account, and the only thing that proves a session works is starting one,
 * which the suite then does.
 */
export function requireCodex(): string {
  try {
    return execFileSync(
      "python3",
      ["-c", "from agents import codex_runner; print(codex_runner.codex_version())"],
      { stdio: "pipe", encoding: "utf8", cwd: new URL("../../", import.meta.url).pathname },
    ).trim();
  } catch (cause) {
    throw new Error(
      `the \`codex\` CLI is not usable, so the agent path cannot be exercised ` +
        `(${cause instanceof Error ? cause.message : String(cause)}).\n` +
        `  Fix: install the Codex CLI and sign in, then re-run.\n` +
        `  This is not skipped when Codex is absent. The demo's agents ARE Codex sessions, ` +
        `so a green run without one would report on a path nothing exercised.`,
    );
  }
}
