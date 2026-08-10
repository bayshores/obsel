/**
 * The MCP integration, against the real `uvx mcp-server-datahub` subprocess.
 *
 * This is the hackathon's required-technology integration, and it had no automated test
 * of any kind. It is also the one part of obsel that cannot be meaningfully covered by a
 * stand-in: everything worth asserting here is a fact about a subprocess, a version
 * resolution, and a strict tool schema. A stand-in would be asserting that obsel calls a
 * function this file also wrote.
 *
 * The tag writes land on a real DataJob in the integration flow (`OBSEL_FLOW_ID` from
 * `vitest.live.config.ts`), never the demo's, and every assertion reads the tag back off
 * the entity over GMS rather than trusting what MCP returned. That distinction is the
 * whole point of `confirmTagState`, and it exists because of a measured receipt:
 * `remove_tags` issued immediately after `add_tags` errored, and the identical call
 * seconds later succeeded (`docs/environment-findings.md` §6.1).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireDataHub, requireStaleTag, requireUvx } from "./reachable";

const { applyStaleTag, removeStaleTag, listMcpTools, closeMcpClient, PINNED_SERVER } =
  await import("@/src/server/datahub/mcp");
const { registerTask } = await import("@/src/server/coordinator/engine");
const { readTagUrns } = await import("@/src/server/datahub/client");
const { STALE_TAG_URN, taskUrn } = await import("@/src/server/datahub/urns");

/** A task of this file's own, so a tag left behind cannot confuse the engine suite. */
const SUBJECT = "mcp_tag_subject";

beforeAll(async () => {
  await requireDataHub();
  await requireStaleTag();
  requireUvx();
  // A real DataJob. `add_tags` on an entity DataHub does not hold is not the case under
  // test here, and would fail for a reason that has nothing to do with MCP.
  await registerTask(SUBJECT, ["raw_orders"], ["mcp_tag_output"], undefined, "MCP tag subject");
});

afterAll(async () => {
  // Leave the entity clean either way. Registration is permanent by design, so the tag
  // is the only part that can be put back.
  await removeStaleTag([taskUrn(SUBJECT)]).catch(() => undefined);
  // The server is a child process. Without this, vitest does not exit.
  await closeMcpClient();
});

describe("the pinned server, and the trap the pin exists for", () => {
  it("pins with == and never with @latest", () => {
    /*
     * §2, and the reason it is critical rather than tidy: `uvx mcp-server-datahub@latest`
     * resolved to 0.4.0 on this machine, which registers **zero** mutation tools and
     * ignores `TOOLS_IS_MUTATION_ENABLED` without any warning. obsel would detect
     * staleness perfectly and mark none of it while reporting success.
     *
     * The pin is overridable so an operator can move it, but only ever as `==<version>`,
     * which cannot accidentally land on `@latest`.
     */
    expect(PINNED_SERVER).toMatch(/^mcp-server-datahub==\d+\.\d+\.\d+$/);
    expect(PINNED_SERVER).not.toContain("@latest");
    expect(PINNED_SERVER).not.toContain("@");
  });

  it("registers the write tools obsel needs, checked and not assumed", async () => {
    // The registered set is environment-dependent, so obsel raises at connect time
    // rather than discovering a missing tool when the first mark is dropped.
    const tools = await listMcpTools();
    expect(tools).toContain("add_tags");
    expect(tools).toContain("remove_tags");
    // §3 measured 21 tools with mutation enabled and 6 without. This asserts the shape
    // of that difference rather than the exact count, which is a server detail.
    expect(tools.length).toBeGreaterThan(10);
  });
});

describe("the tag round trip, confirmed by reading DataHub rather than MCP", () => {
  it("applies the tag and leaves it readable on the entity", async () => {
    const urn = taskUrn(SUBJECT);
    await removeStaleTag([urn]).catch(() => undefined);
    expect(await readTagUrns(urn)).not.toContain(STALE_TAG_URN);

    const detail = await applyStaleTag([urn]);

    // MCP's own acknowledgement, kept because obsel surfaces it in errors.
    expect(detail).toBeTruthy();
    // And the fact, read back over GMS off `globalTags`, which is what a person browsing
    // DataHub actually sees.
    expect(await readTagUrns(urn)).toContain(STALE_TAG_URN);
  });

  it("clears the tag, and clears it immediately after applying it", async () => {
    /*
     * The exact sequence §6.1 caught failing: `remove_tags` right after `add_tags`
     * errored, and the identical call seconds later worked. `applyStaleTag` does not
     * return until the tag is readable, so by construction this removal is not issued
     * into that window — which is the behavior being asserted, not avoided.
     */
    const urn = taskUrn(SUBJECT);
    await applyStaleTag([urn]);
    await removeStaleTag([urn]);
    expect(await readTagUrns(urn)).not.toContain(STALE_TAG_URN);
  });

  it("is idempotent in both directions", async () => {
    // A cascade can mark a task that is already marked, and a reset can clear a tag that
    // was never applied. Neither may throw, or one stray state breaks a whole demo take.
    const urn = taskUrn(SUBJECT);
    await applyStaleTag([urn]);
    await applyStaleTag([urn]);
    expect(await readTagUrns(urn)).toContain(STALE_TAG_URN);
    await removeStaleTag([urn]);
    await removeStaleTag([urn]);
    expect(await readTagUrns(urn)).not.toContain(STALE_TAG_URN);
  });

  it("does nothing at all for an empty list, without spawning a server", async () => {
    // `resetSwarm` calls this with whatever it found, which is often nothing. A no-op
    // has to be a no-op rather than an MCP round trip that fails on an empty argument.
    await expect(applyStaleTag([])).resolves.toBe("");
    await expect(removeStaleTag([])).resolves.toBe("");
  });
});

describe("failures are named, not swallowed", () => {
  it("refuses a tag URN DataHub does not hold, and names the fix", async () => {
    /*
     * §6.2: applying an unregistered tag URN is rejected, and there is no `create_tag`
     * on open-source Core, so obsel cannot mint vocabulary at runtime. The failure has
     * to arrive with the setup command attached, because the alternative — detecting
     * staleness and silently recording none of it — is the failure mode the whole
     * environment-findings document exists to prevent.
     *
     * Driven through the real tool rather than through obsel's wrapper, because what is
     * being checked is that DataHub really does reject it. obsel's own message for the
     * case is built from that rejection's text.
     */
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport, getDefaultEnvironment } =
      await import("@modelcontextprotocol/sdk/client/stdio.js");

    const client = new Client({ name: "obsel-test", version: "0.1.0" });
    await client.connect(
      new StdioClientTransport({
        command: "uvx",
        args: [PINNED_SERVER],
        env: {
          ...getDefaultEnvironment(),
          DATAHUB_GMS_URL: process.env.DATAHUB_GMS_URL ?? "http://localhost:8080",
          TOOLS_IS_MUTATION_ENABLED: "true",
          TOOLS_IS_USER_ENABLED: "true",
        },
        stderr: "pipe",
      }),
      { timeout: 120_000 },
    );

    try {
      const result = await client.callTool(
        {
          name: "add_tags",
          arguments: {
            tag_urns: ["urn:li:tag:obsel-does-not-exist-probe"],
            entity_urns: [taskUrn(SUBJECT)],
          },
        },
        undefined,
        { timeout: 60_000 },
      );

      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content ?? "");
      // The string obsel matches on to attach its own hint.
      expect(text).toContain("Urn does not exist");
    } finally {
      await client.close();
    }
  });

  it("reports a tag write that did not land rather than trusting the acknowledgement", async () => {
    /*
     * `applyStaleTag` confirms by reading the entity back, so its success means the tag
     * is genuinely there. The negative half of that promise is asserted here by pointing
     * it at a DataJob URN DataHub does not hold: MCP may or may not object, and obsel
     * must not return success either way.
     */
    const absent = taskUrn("mcp_subject_that_was_never_registered");
    await expect(applyStaleTag([absent])).rejects.toThrow();
    expect(await readTagUrns(absent)).not.toContain(STALE_TAG_URN);
  });
});

describe("a session that dies under obsel is survived, not cached", () => {
  /*
   * The corpse bug, with a real corpse.
   *
   * Found live on 2026-07-24: the module caches one connection for the process,
   * and the cache used to be cleared only when CONNECTING failed. A session
   * that connected and died later — the uvx child outlived by a night of
   * forty-task runs — left a client every later call hit, and the SDK answers
   * calls on a closed transport with "Not connected". Every completion after
   * that moment 500ed at the tag step with the staleness decision already
   * committed, which put the record and the visible tag in disagreement: the
   * exact state `confirmTagState` exists to rule out.
   *
   * The hostile input is real, per the house rule: the actual subprocess gets
   * SIGKILL, and the assertion is that the next apply lands on the entity
   * anyway, read back over GMS. Killing is safe to retry through because both
   * tag tools are idempotent, proven above. Last in the file on purpose: it
   * executes the shared session so every earlier test runs on a session whose
   * history it knows.
   */
  it("kills the real subprocess, and the next apply reconnects and lands", async () => {
    const { execSync } = await import("node:child_process");

    // Warm and proven: the session exists and can write.
    await applyStaleTag([taskUrn(SUBJECT)]);
    await removeStaleTag([taskUrn(SUBJECT)]);

    // The kill must have something to kill, or this test is not testing it.
    const pids = execSync("pgrep -f mcp-server-datahub || true").toString().trim();
    expect(pids, "the MCP subprocess should be running").not.toBe("");
    execSync("pkill -9 -f mcp-server-datahub");

    // No settling wait on purpose: whether the close event beats the next call
    // or races it, both paths must end in a fresh session doing the work.
    await applyStaleTag([taskUrn(SUBJECT)]);
    expect(await readTagUrns(taskUrn(SUBJECT))).toContain(STALE_TAG_URN);

    await removeStaleTag([taskUrn(SUBJECT)]);
    expect(await readTagUrns(taskUrn(SUBJECT))).not.toContain(STALE_TAG_URN);
  }, 300_000);
});
