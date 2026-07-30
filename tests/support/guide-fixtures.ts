/**
 * The board states the guide tests are written against.
 *
 * Builders rather than literals, so a test names only the field it is about and
 * a field added to `TaskRecord` later reaches every test at once.
 */

import { guide } from "@/src/features/dashboard/guide/guide";
import type { GuideInput } from "@/src/features/dashboard/guide/guide";
import type { StaleMark, TaskRecord, TaskStatus } from "@/src/server/coordinator/types";
import type {
  DemoActivity,
  DemoStep,
  RunnerCheck,
  RunnerName,
  StepResult,
} from "@/src/server/runner/types";

export const AT = "2026-07-22T09:00:10.000Z";

export function ds(name: string): string {
  return `urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.${name},PROD)`;
}

export function task(name: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  const status: TaskStatus = overrides.status ?? "complete";
  return {
    urn: `urn:li:dataJob:(urn:li:dataFlow:(obsel,orders_pipeline,prod),${name})`,
    name,
    reads: [ds("raw_orders")],
    writes: [ds(name)],
    status,
    fingerprints: {},
    finishedAt: status === "complete" || status === "stale" ? AT : null,
    startedAt: null,
    run: null,
    stale: null,
    ...overrides,
  };
}

/**
 * A finished task whose recorded output moved: what a change leaves in DataHub.
 *
 * The hashes differ, which is the whole point. `engine.ts` writes a previous
 * entry only when the fingerprints genuinely moved, so this is the shape a real
 * board carries after a change and after a repair, and it is not the shape an
 * identical re-run produces. `identicalRerun` below is that one.
 */
export function changed(name: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return task(name, {
    fingerprints: { [ds(name)]: { schema: "s2", content: "c2" } },
    previousFingerprints: { [ds(name)]: { schema: "s1", content: "c1" } },
    ...overrides,
  });
}

/** The key present and the hashes equal, which must not read as a change. */
export function identicalRerun(name: string): TaskRecord {
  return task(name, {
    fingerprints: { [ds(name)]: { schema: "s1", content: "c1" } },
    previousFingerprints: { [ds(name)]: { schema: "s1", content: "c1" } },
  });
}

export function mark(overrides: Partial<StaleMark> = {}): StaleMark {
  return {
    causedBy: ds("clean_orders"),
    causedByTask: null,
    hops: 1,
    changeKind: "schema",
    reason: "clean_orders changed its columns after this task finished",
    since: AT,
    detectedMs: 2591,
    ...overrides,
  };
}

export function ok(detail = "fine") {
  return { ok: true, detail, fix: null };
}

/**
 * A passing runner check. Defaults to Codex because that is what detection
 * picks when both are installed, so it is the state most boards are in.
 */
export function runnerOk(name: RunnerName = "codex"): RunnerCheck {
  return { ok: true, detail: "fine", fix: null, name };
}

export function activity(overrides: Partial<DemoActivity> = {}): DemoActivity {
  return {
    running: null,
    lastResult: null,
    log: [],
    history: [],
    preflight: { datahub: ok(), vocabulary: ok(), venv: ok(), uvx: ok(), runner: runnerOk() },
    joinCommand: "claude mcp add obsel -- /tmp/x/agents/.venv/bin/python -m agents.mcp_server",
    ...overrides,
  };
}

/** Steps that ran and passed, in order, as the launcher would have recorded them. */
export function ran(...steps: DemoStep[]): StepResult[] {
  return steps.map((step) => ({
    step,
    exitCode: 0,
    signal: null,
    startedAt: AT,
    finishedAt: AT,
    durationMs: 1000,
  }));
}

/** One step that ran and failed, which must never tick its act. */
export function failed(step: DemoStep): StepResult {
  return { step, exitCode: 3, signal: null, startedAt: AT, finishedAt: AT, durationMs: 1000 };
}

export function input(overrides: Partial<GuideInput> = {}): GuideInput {
  return {
    trusted: true,
    everRead: true,
    tasks: [],
    snapshotAt: AT,
    activity: activity(),
    ...overrides,
  };
}

export const FOUR_COMPLETE = [
  task("clean_orders"),
  task("build_revenue"),
  task("write_report"),
  task("write_docs"),
];

/**
 * Every word a stage puts on screen, as one string.
 *
 * The view used to expose `narration: string[]`, and most assertions here read
 * `narration.join("\n")`. That field is gone: a stage now yields a headline, one
 * optional subline, and a prerequisite checklist on the setup and connection
 * stages. These tests are about which facts a stage states, not about which field
 * carries them, so they assert against the whole rendered text.
 */
export function allText(view: ReturnType<typeof guide>): string {
  return [
    view.headline,
    view.subline ?? "",
    ...view.checks.flatMap((check) => [check.name, check.detail ?? "", check.fix ?? ""]),
    view.attention ?? "",
    ...view.actions.flatMap((a) => [a.label, a.detail]),
  ].join("\n");
}
