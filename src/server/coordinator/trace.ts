import "server-only";

/**
 * A running account of what the coordinator just did, for the board to show.
 *
 * The problem this solves: obsel's real work is invisible. An agent posts one
 * completion, and inside that single request obsel reads the swarm out of
 * DataHub, compares each output against the fingerprint it recorded last time,
 * walks the lineage graph for anything built on what moved, and writes a mark
 * and a tag back for each one — with bounded polling to confirm every write
 * landed. All a viewer ever saw was the answer appearing a couple of seconds
 * later, which is indistinguishable from a board that made it up.
 *
 * So the coordinator narrates itself here, and `GET /api/trace` hands the tail
 * of it to the dashboard.
 *
 * **This is narration, not a decision path.** Nothing in obsel reads these
 * events back; deleting every `emit` call would change no outcome, no mark and
 * no fingerprint. That direction is deliberate — a trace that something else
 * depended on would be state, and state that duplicates DataHub is state that
 * can disagree with it.
 *
 * In memory and process-local on purpose. It is a view of what this server just
 * did, not a record: it does not survive a restart, and it is not evidence of
 * anything. The evidence is the marks in DataHub.
 *
 * The buffer itself is in `trace-buffer.ts`, which is not `server-only` and is
 * therefore testable; this module owns only the one instance.
 */

import { createTraceBuffer } from "./trace-buffer";
import type { TraceBuffer } from "./trace-buffer";

/**
 * How many steps are kept.
 *
 * A full `run` of the demo swarm emits roughly four per agent, and a cascade a
 * dozen more, so this holds several complete steps — enough that the panel can
 * be read after the fact, and bounded so a long-lived dev server cannot grow
 * without limit.
 */
const TRACE_LIMIT = 200;

// Survives Next's dev-server module reloads. Without this a recompile mid-run
// empties the panel while the run it is narrating is still going.
const globalRef = globalThis as typeof globalThis & { __obselTrace?: unknown };

/**
 * The shape is CHECKED, not assumed, and that is not defensive decoration.
 *
 * A plain `??=` reuses whatever is already on `globalThis` under this key. When
 * this module's stored shape changes and the dev server hot-reloads, the object
 * left behind by the previous version is still truthy, so it is handed back and
 * every call against it throws — which is exactly what happened here: an
 * earlier version cached `{events, next}` and the first read after the reload
 * died on `buffer(...).read is not a function`, taking the route with it.
 *
 * Validating instead means a shape change heals itself on the next call, at the
 * cost of the steps held at that moment. Losing narration is the right thing to
 * lose; the endpoint answering is not.
 */
function isTraceBuffer(value: unknown): value is TraceBuffer {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<TraceBuffer>;
  return (
    typeof candidate.emit === "function" &&
    typeof candidate.read === "function" &&
    typeof candidate.clear === "function"
  );
}

function buffer(): TraceBuffer {
  // Read into a local and return that, rather than re-reading the property
  // after the guard: the key is typed `unknown`, and TypeScript does not carry
  // a narrowing on a mutable property across the branch that assigns it.
  const existing = globalRef.__obselTrace;
  if (isTraceBuffer(existing)) return existing;
  const fresh = createTraceBuffer(TRACE_LIMIT);
  globalRef.__obselTrace = fresh;
  return fresh;
}

/**
 * Record one step. Returns nothing and throws nothing.
 *
 * Deliberately incapable of failing the caller: this sits inside
 * `coordinateCompletion`, between deciding a task is stale and writing the
 * mark, so a narration bug must never be able to stop that mark from landing.
 */
export const emit: TraceBuffer["emit"] = (phase, message, outcome = null) => {
  buffer().emit(phase, message, outcome);
};

/** The kept steps, oldest first. A copy, so a caller cannot mutate the buffer. */
export const read: TraceBuffer["read"] = () => buffer().read();

/** Drop everything, for a fresh take. */
export const clear: TraceBuffer["clear"] = () => {
  buffer().clear();
};
