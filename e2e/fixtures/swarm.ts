/**
 * Canned `GET /api/swarm` bodies for the browser suite.
 *
 * Typed as `SwarmResponse`, which is the point: `tsconfig.json` includes
 * `**​/*.ts`, so if the shape the cockpit reads ever drifts from the shape these
 * describe, `pnpm typecheck` fails inside `pnpm verify` — before anyone runs a
 * browser. A fixture that has quietly stopped resembling the real payload is
 * worse than no fixture, because the suite keeps passing.
 *
 * These are invented values. Nothing here may be screenshotted into the
 * submission or quoted as a measurement.
 */

import { STALE_TAG_URN } from "@/src/server/datahub/urns";
import type { SwarmResponse } from "@/src/features/cockpit/use-swarm";
import type { OutputFingerprint, StaleMark, TaskRecord } from "@/src/server/coordinator/types";

const FLOW = "urn:li:dataFlow:(obsel,orders_pipeline,prod)";
const AT = "2026-07-21T14:22:07.000Z";

function ds(name: string): string {
  return `urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.${name},PROD)`;
}

function jobUrn(name: string): string {
  return `urn:li:dataJob:(${FLOW},${name})`;
}

/** 64 hex characters, like the real thing — the inspector shows all of them. */
function hex(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function print(schema: string, content: string): OutputFingerprint {
  return { schema: hex(schema), content: hex(content) };
}

/** The same one-liners the real pipeline registers — words, not measurements. */
const JOBS: Record<string, string> = {
  clean_orders: "cleans the raw orders export into a tidy four-column table",
  build_revenue: "totals the clean orders into one revenue row per day",
  write_report: "writes the short revenue report an operations lead reads",
  write_docs: "documents the daily_revenue table for the next engineer",
};

/** The human names the real pipeline registers as `obsel.title`. */
const TITLES: Record<string, string> = {
  clean_orders: "Orders cleaner",
  build_revenue: "Daily revenue",
  write_report: "Revenue report",
  write_docs: "Table docs",
};

function task(
  name: string,
  reads: string[],
  writes: string[],
  extra: Partial<TaskRecord> = {},
): TaskRecord {
  return {
    urn: jobUrn(name),
    name,
    title: TITLES[name] ?? null,
    description: JOBS[name] ?? null,
    reads: reads.map(ds),
    writes: writes.map(ds),
    status: "complete",
    fingerprints: {},
    finishedAt: AT,
    startedAt: null,
    run: null,
    stale: null,
    /*
     * Present and empty by default, which is what a real read looks like.
     *
     * `toTaskRecord` always sets these now, so an untagged job carries an empty list
     * rather than no list. The distinction is load-bearing on the board: absent means
     * obsel never read tags, empty means DataHub reports none, and the ribbon says
     * different things for each. A fixture that omitted the keys would silently
     * exercise only the "not recorded" path.
     */
    tags: [],
    staleTagged: false,
    ...extra,
  };
}

/** A job DataHub reports obsel's stale tag on. */
const TAGGED: Partial<TaskRecord> = { tags: [STALE_TAG_URN], staleTagged: true };

function mark(hops: number, reason: string): StaleMark {
  return {
    causedBy: ds("clean_orders"),
    causedByTask: jobUrn("clean_orders"),
    hops,
    changeKind: "schema",
    /*
     * The column diff every mark from a schema change carries.
     *
     * Present on the two-hop marks as well as the one-hop mark, because it
     * describes the ORIGIN's change and every task in the cascade is stale
     * because of that same change. A fixture that omitted it here would exercise
     * only the fallback wording and leave the sentence that actually explains
     * obsel, naming the column that moved, untested in a browser.
     */
    columns: { added: ["order_total_usd"], removed: ["order_total"] },
    reason,
    since: AT,
    detectedMs: 118,
  };
}

const R1 = "read clean orders, and its columns changed after this finished";
const R2 =
  "built on work from Daily revenue, which is itself out of date because clean orders changed";

function wrap(tasks: TaskRecord[]): SwarmResponse {
  return {
    snapshot: { flow: FLOW, tasks, at: AT },
    ready: [],
    blocked: [],
    // Set so the details panel's link is exercised. Nothing in the suite navigates
    // to it — DataHub is not running under the browser tests — but the href it
    // builds is asserted, which is the part that has to be right.
    datahubUrl: "http://localhost:9002",
  };
}

/** Four tasks finished, nothing marked. */
export function calm(): SwarmResponse {
  return wrap([
    task("clean_orders", ["raw_orders"], ["clean_orders"], {
      fingerprints: { [ds("clean_orders")]: print("a", "b") },
    }),
    task("build_revenue", ["clean_orders"], ["daily_revenue"], {
      fingerprints: { [ds("daily_revenue")]: print("c", "d") },
    }),
    task("write_report", ["daily_revenue"], ["revenue_report"], {
      fingerprints: { [ds("revenue_report")]: print("e", "f") },
    }),
    task("write_docs", ["daily_revenue"], ["pipeline_docs"], {
      fingerprints: { [ds("pipeline_docs")]: print("1", "2") },
    }),
  ]);
}

/**
 * One schema-only change, three tasks out of date.
 *
 * `clean_orders`'s content fingerprint is identical to the calm fixture's and
 * its schema differs — the rename the demo is built on.
 */
export function cascaded(): SwarmResponse {
  return wrap([
    task("clean_orders", ["raw_orders"], ["clean_orders"], {
      fingerprints: { [ds("clean_orders")]: print("9", "b") },
    }),
    task("build_revenue", ["clean_orders"], ["daily_revenue"], {
      status: "stale",
      stale: mark(1, R1),
      fingerprints: { [ds("daily_revenue")]: print("c", "d") },
      ...TAGGED,
    }),
    task("write_report", ["daily_revenue"], ["revenue_report"], {
      status: "stale",
      stale: mark(2, R2),
      fingerprints: { [ds("revenue_report")]: print("e", "f") },
      ...TAGGED,
    }),
    task("write_docs", ["daily_revenue"], ["pipeline_docs"], {
      status: "stale",
      stale: mark(2, R2),
      fingerprints: { [ds("pipeline_docs")]: print("1", "2") },
      ...TAGGED,
    }),
  ]);
}

/**
 * The same cascade with one tag not yet landed.
 *
 * A moment every real cascade passes through rather than a fault: obsel writes the
 * mark and then the tag, and DataHub's writes are asynchronous. The board has to
 * report two of three without implying a failure, which is why the ribbon counts
 * instead of ticking.
 */
export function midWrite(): SwarmResponse {
  const response = cascaded();
  const tasks = response.snapshot.tasks.map((task) =>
    task.name === "write_docs" ? { ...task, tags: [], staleTagged: false } : task,
  );
  return { ...response, snapshot: { ...response.snapshot, tasks } };
}

/**
 * A calm board with obsel's tag still on one job.
 *
 * What a reset done by hand leaves behind: the `obsel.*` properties are cleared and
 * the tag is not, because they live on different aspects of the same entity. DataHub
 * then shows a stale badge on work obsel says is fine, and unlike a write in flight
 * this never resolves itself. It is the most damaging frame
 * the video could contain.
 */
export function leftOverTag(): SwarmResponse {
  const response = calm();
  const tasks = response.snapshot.tasks.map((task) =>
    task.name === "write_docs" ? { ...task, ...TAGGED } : task,
  );
  return { ...response, snapshot: { ...response.snapshot, tasks } };
}

/**
 * A cascade read by a build that did not know about tags.
 *
 * `examples/*.json` captured before today looks exactly like this. obsel knows
 * nothing about the tags, which is not the same as DataHub holding none, and the
 * board has to say so rather than report zero.
 */
export function withoutTagInfo(): SwarmResponse {
  const response = cascaded();
  const tasks = response.snapshot.tasks.map((task) => {
    // The keys are deleted rather than set to undefined, because that is the shape
    // an older capture actually has: absent, not present-and-empty. The board
    // distinguishes the two.
    const stripped: TaskRecord = { ...task };
    delete stripped.tags;
    delete stripped.staleTagged;
    return stripped;
  });
  return { ...response, snapshot: { ...response.snapshot, tasks } };
}

/** Connected, nothing registered. A real state at the start of the demo. */
export function empty(): SwarmResponse {
  return wrap([]);
}

/**
 * A board holding exactly one task, in each of the three states a count of one
 * can be in.
 *
 * Invented, like the rest of this file, and it exists because a swarm of one was
 * an impossible state until the bring-your-own-data panel started registering
 * tasks one at a time. Every sentence on the board that counts something had been
 * written for the demo's four or the taxi swarm's forty, and "1 agents ready to
 * run" reached a real browser on 2026-07-26.
 *
 * `guide.ts` and `timing.ts` are checked at one by their own unit tests, which is
 * where the wording is decided. What only a browser can show is the rendered
 * board agreeing with itself: the headline, the live region and the ribbon are
 * three separate derivations of the same count, and nothing but the page puts
 * them side by side.
 */
export function justOne(state: "waiting" | "finished" | "flagged"): SwarmResponse {
  if (state === "waiting") {
    return wrap([
      task("clean_orders", ["raw_orders"], ["clean_orders"], {
        status: "registered",
        finishedAt: null,
      }),
    ]);
  }
  const finished = task("clean_orders", ["raw_orders"], ["clean_orders"], {
    fingerprints: { [ds("clean_orders")]: print("a", "b") },
  });
  if (state === "finished") return wrap([finished]);
  return wrap([{ ...finished, status: "stale", stale: mark(1, R1) }]);
}

/**
 * obsel's own demo, plus somebody else's agent part way through joining.
 *
 * **These two tasks are in `obsel_demo`, and that is deliberate.** It is what
 * the MCP door genuinely emits: `register_task` takes short names and
 * `datasetUrn` qualifies anything unnamespaced under the demo namespace, so a
 * stranger's table really is `obsel_demo.clean_expenses`. An earlier version of
 * this fixture gave the visitor a `finance.` prefix that no caller produces,
 * and it hid a classifier that would have counted every real visiting agent as
 * obsel's own. A fixture written to match a belief tests the belief.
 *
 * `clean_expenses` has finished and `monthly_totals` has only declared itself,
 * so three of the four steps have happened and the fourth has not.
 *
 * Invented, like everything else in this file. `docs/verification.md` records
 * the real MCP session this shape was checked against.
 */
export function visiting(): SwarmResponse {
  const mine = (name: string, reads: string[], writes: string[], extra: Partial<TaskRecord> = {}) =>
    ({ ...task(name, reads, writes, extra), title: null, description: null }) satisfies TaskRecord;

  return wrap([
    ...calm().snapshot.tasks,
    mine("clean_expenses", ["expenses_csv"], ["clean_expenses"], {
      startedAt: AT,
      finishedAt: AT,
      fingerprints: { [ds("clean_expenses")]: print("7", "8") },
    }),
    mine("monthly_totals", ["clean_expenses"], ["monthly_totals"], {
      status: "registered",
      startedAt: null,
      finishedAt: null,
    }),
  ]);
}

export const REASONS = { one: R1, two: R2 };
