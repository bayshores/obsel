/**
 * What an MCP client named itself, as the three task routes accept it.
 *
 * One definition rather than three copies, because `register`, `start` and
 * `complete` all take the same object and the whole value of recording it is
 * that the three agree about the shape.
 *
 * **A declaration, not a verification.** The name arrives from the MCP
 * `initialize` handshake, which `agents/mcp_server.py` reads off the live
 * session rather than accepting as a tool argument -- so obsel is repeating what
 * the client said when it connected instead of what an agent typed into a call.
 * That is a real difference and it is still not a check: obsel holds no registry
 * of clients and cannot refuse a name. Every surface that shows one says so, and
 * `attestation.ts` remains the only place in obsel entitled to call anything
 * verified.
 *
 * Distinct from `run.runner`, which is what the agent says did the work. A
 * Claude Code session driving a task through this door sets both, and they can
 * legitimately disagree -- the client is what spoke MCP, the runner is what did
 * the job -- so neither field is ever filled in from the other.
 */

import { z } from "zod";

export const ClientBody = z.object({
  /**
   * The client's own name for itself, e.g. `claude-code`. Bounded like `title`
   * because it renders on the page; free prose, since nothing parses it back
   * out and it never reaches a URN.
   */
  name: z.string().min(1).max(60),
  /** Its version, when it gave one. Absent is normal and is not an error. */
  version: z.string().min(1).max(60).optional(),
  /**
   * When the door read the handshake, stamped by the MCP server rather than by
   * obsel. Optional: a caller that sends a name and no timestamp has still told
   * obsel who it is, and refusing the whole record over a missing display field
   * would lose the identity to keep the clock.
   */
  at: z.string().min(1).max(40).optional(),
});

export type ClientDeclaration = z.infer<typeof ClientBody>;

/**
 * The property value obsel stores, or null when nothing was declared.
 *
 * JSON in one property rather than three keys per moment: the three moments are
 * already three properties, and nine keys for a display field would crowd out
 * the aspect a reader actually came to look at.
 */
export function clientProperty(client: ClientDeclaration | undefined): string | null {
  if (!client) return null;
  return JSON.stringify(client);
}
