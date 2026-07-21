import "server-only";

/**
 * Applying and clearing obsel's stale tag through the DataHub MCP Server.
 *
 * This is the hackathon's required-technology integration, and it is a real
 * dependency rather than a badge: the tag is what a person sees in DataHub's own
 * UI next to work that is no longer trustworthy.
 *
 * Three things here are not negotiable, each because the alternative fails
 * silently (see `docs/environment-findings.md` sections 2, 3 and 6.2):
 *
 * - **The version is pinned, to 0.6.0 by default.** `uvx mcp-server-datahub@latest`
 *   resolved to 0.4.0 on this machine, which registers zero mutation tools and
 *   ignores `TOOLS_IS_MUTATION_ENABLED` without warning. obsel would detect
 *   staleness perfectly and mark nothing while reporting success. The pin is
 *   overridable by env var, but always as `==<version>`, never `@latest`.
 * - **The tool list is checked, not assumed.** The registered set is
 *   environment-dependent, so a missing `add_tags` is raised at connect time
 *   rather than discovered when the first mark is dropped.
 * - **`urn:li:tag:obsel-stale` must already exist.** There is no `create_tag`
 *   on open-source Core, so obsel cannot mint vocabulary at runtime; the tag is
 *   registered during setup. Applying an unregistered tag URN is rejected by
 *   DataHub, and that rejection is surfaced here with the fix named.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { confirmWrite, readTagUrns } from "./client";
import { STALE_TAG_URN } from "./urns";

// `==` rather than `@` is what makes the override safe: an operator can move the
// pin, but cannot accidentally land on the read-only `@latest` described above.
const PINNED_SERVER = `mcp-server-datahub==${process.env.MCP_SERVER_DATAHUB_VERSION ?? "0.6.0"}`;
const REQUIRED_TOOLS = ["add_tags", "remove_tags"] as const;

/** Covers the first `uvx` run, which may resolve and download the package. */
const CONNECT_TIMEOUT_MS = 120_000;
const CALL_TIMEOUT_MS = 60_000;

class McpUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "McpUnavailableError";
  }
}

/**
 * One connection for the process.
 *
 * Spawning a Python process per mark would add seconds to a number obsel
 * reports as its detection latency, and would make the measurement a claim
 * about `uvx` startup rather than about the work.
 */
let connection: Promise<Client> | null = null;

async function connect(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "uvx",
    args: [PINNED_SERVER],
    env: {
      ...getDefaultEnvironment(),
      DATAHUB_GMS_URL: process.env.DATAHUB_GMS_URL ?? "http://localhost:8080",
      ...(process.env.DATAHUB_GMS_TOKEN
        ? { DATAHUB_GMS_TOKEN: process.env.DATAHUB_GMS_TOKEN }
        : {}),
      // Read once at startup during tool registration, so it has to be set here
      // rather than per call.
      TOOLS_IS_MUTATION_ENABLED: "true",
      TOOLS_IS_USER_ENABLED: "true",
    },
    stderr: "pipe",
  });

  const client = new Client({ name: "obsel", version: "0.1.0" });

  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  } catch (cause) {
    throw new McpUnavailableError(
      `could not start the DataHub MCP server (\`uvx ${PINNED_SERVER}\`). ` +
        `obsel cannot mark anything stale without it. Check that \`uvx\` is on PATH and that ` +
        `DataHub is reachable at ${process.env.DATAHUB_GMS_URL ?? "http://localhost:8080"}.`,
      { cause },
    );
  }

  const { tools } = await client.listTools({}, { timeout: CALL_TIMEOUT_MS });
  const available = new Set(tools.map((tool) => tool.name));
  const missing = REQUIRED_TOOLS.filter((name) => !available.has(name));
  if (missing.length > 0) {
    await client.close();
    throw new McpUnavailableError(
      `the DataHub MCP server registered ${tools.length} tools but none named ${missing.join(", ")}. ` +
        `This is what a read-only 0.4.0 looks like: pin ${PINNED_SERVER} and set ` +
        `TOOLS_IS_MUTATION_ENABLED=true before the server starts.`,
    );
  }

  return client;
}

async function mcpClient(): Promise<Client> {
  if (!connection) {
    connection = connect().catch((error: unknown) => {
      // Do not cache a failed connection: the next call should retry rather than
      // inherit an error from a DataHub that was briefly down.
      connection = null;
      throw error;
    });
  }
  return await connection;
}

interface ToolTextContent {
  type: string;
  text?: string;
}

/**
 * `callTool` returns a union that includes a legacy shape with no `content`, so
 * the field is narrowed rather than assumed. An error whose text got dropped is
 * still an error, but a silent one, which is the thing this file exists to avoid.
 */
function resultText(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return (content as ToolTextContent[])
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join(" ")
    .trim();
}

/**
 * `tag_urns` and `entity_urns` are plural arrays and the schema is strict
 * (`additionalProperties: false`) — a singular `urn` is rejected.
 */
async function callTagTool(tool: "add_tags" | "remove_tags", taskUrns: string[]): Promise<string> {
  if (taskUrns.length === 0) return "";
  const client = await mcpClient();

  const result = await client.callTool(
    { name: tool, arguments: { tag_urns: [STALE_TAG_URN], entity_urns: taskUrns } },
    undefined,
    { timeout: CALL_TIMEOUT_MS },
  );

  if (result.isError) {
    const detail = resultText(result) || "no detail returned";
    const hint = detail.includes("Urn does not exist")
      ? ` ${STALE_TAG_URN} has to be registered in DataHub during setup — obsel cannot create a tag at runtime.`
      : "";
    throw new McpUnavailableError(`${tool} failed for ${taskUrns.join(", ")}: ${detail}.${hint}`);
  }

  return resultText(result);
}

/**
 * Confirm every task ended up in the expected state, by reading the entity back.
 *
 * An MCP acknowledgement is not evidence the write settled. This project has the
 * receipt: `remove_tags` issued immediately after `add_tags` returned an error,
 * and the identical call seconds later succeeded (docs/environment-findings.md
 * §6.1). Every property write in `client.ts` is already confirmed by polling; the
 * tag is the one a person actually sees in DataHub's UI, so it gets the same
 * treatment rather than less.
 */
async function confirmTagState(taskUrns: string[], shouldBePresent: boolean): Promise<void> {
  await Promise.all(
    taskUrns.map((urn) =>
      confirmWrite(async () => {
        const present = (await readTagUrns(urn)).includes(STALE_TAG_URN);
        return present === shouldBePresent ? true : null;
      }).catch(() => {
        throw new McpUnavailableError(
          `${shouldBePresent ? "add_tags" : "remove_tags"} reported success for ${urn}, but ` +
            `${STALE_TAG_URN} was ${shouldBePresent ? "still absent" : "still present"} when read ` +
            `back. The mark and obsel's own properties would disagree about this task.`,
        );
      }),
    ),
  );
}

/** Mark work stale in DataHub's own UI. Throws unless the tag is readable afterwards. */
export async function applyStaleTag(taskUrns: string[]): Promise<string> {
  const detail = await callTagTool("add_tags", taskUrns);
  await confirmTagState(taskUrns, true);
  return detail;
}

/** Clear the mark, for a task that has re-run and is trustworthy again. */
export async function removeStaleTag(taskUrns: string[]): Promise<string> {
  const detail = await callTagTool("remove_tags", taskUrns);
  await confirmTagState(taskUrns, false);
  return detail;
}

/** Names of every tool the server registered. Useful for a startup health check. */
export async function listMcpTools(): Promise<string[]> {
  const client = await mcpClient();
  const { tools } = await client.listTools({}, { timeout: CALL_TIMEOUT_MS });
  return tools.map((tool) => tool.name).sort();
}

/** Shut the subprocess down. Scripts need this to exit; the server does not. */
export async function closeMcpClient(): Promise<void> {
  if (!connection) return;
  const pending = connection;
  connection = null;
  const client = await pending.catch(() => null);
  await client?.close();
}

export { McpUnavailableError, STALE_TAG_URN, PINNED_SERVER };
