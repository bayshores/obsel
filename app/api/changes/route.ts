import { readChanges } from "@/src/server/coordinator/change-history";
import { readRoute } from "@/src/server/http/route";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * This board's change history, oldest record first.
 *
 * **GET only, and that is the point rather than an omission.** obsel's rule is
 * that a flag comes off through redone work and nothing else, which is why no
 * route and no MCP tool accepts a task to clear. A ledger a caller could append
 * to, edit or delete would route around that from the other side: somebody could
 * write "this was cleared" without any work being redone, and a later reader
 * would find a history that disagrees with the marks. So the only writer is a
 * completion that already marked or cleared something, in `completion.ts`.
 * `tests/live/change-ledger.live.test.ts` asserts the mutating verbs are absent
 * here, the same way the erasure suite asserts there is no route that marks an
 * asset covered.
 *
 * Records are read straight out of DataHub, never out of a search index: the
 * index lags, and a history missing its newest entries is the shape of answer
 * this codebase has already been bitten by once (`environment-findings.md` §7).
 *
 * Unauthenticated, like `/api/swarm` and the erasure read beside it. What it
 * returns is what obsel decided about this board's own tasks — the same facts the
 * marks already carry, in the order they happened.
 */
export async function GET() {
  return readRoute("could not read the change history", () => readChanges());
}
