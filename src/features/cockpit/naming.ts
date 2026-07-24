/**
 * What a person should read where a code identifier would otherwise be.
 *
 * The board used to lead with the raw identifiers — `clean_orders`,
 * `build_revenue`, `write_docs` — everywhere: the graph nodes, the ledger rows,
 * the guide's narration. Those are the names the URNs are built from, so they
 * are correct and they are load-bearing; they are also meaningless to anyone
 * who has not read `agents/pipeline.py`. Shown a screenshot, a newcomer could
 * not tell what any of the four agents was for.
 *
 * So every identifier now renders as a human name with the identifier beside
 * it, rather than instead of it. Both, because the code name is what makes the
 * task findable in DataHub, and hiding it would trade one kind of opacity for
 * another.
 *
 * **No task or table name is hardcoded here.** A task's human name comes from
 * DataHub — `obsel.title`, registered alongside the description — and this
 * module only supplies the fallback for anything registered without one, plus
 * the transform that makes a table name readable. A pipeline this repository
 * has never seen still renders in words rather than in snake_case.
 */

import type { TaskRecord } from "@/src/server/coordinator/types";

/**
 * The last segment of a dataset URN's path — `clean_orders` out of
 * `urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.clean_orders,PROD)`.
 *
 * Deliberately duplicated from `src/server/coordinator/staleness.ts` rather than
 * imported. This module is rendered in the browser, and obsel's architecture forbids
 * browser code importing server modules — a rule about the dependency direction,
 * not about how expensive the function is. The two must stay in step; a test
 * asserts they agree.
 *
 * It lives here rather than in `graph/layout.ts`, where it used to: naming is
 * what it does, and the layout now reserves box widths from the *display* names
 * below, so keeping it there would have made the two modules import each other.
 */
export function shortName(datasetUrn: string): string {
  const parts = datasetUrn.split(",");
  const path = parts.length > 1 ? parts[1] : datasetUrn;
  const segments = path.split(".");
  return segments[segments.length - 1];
}

/** `clean_orders` → `clean orders`. Underscores only; nothing else is guessed. */
export function humanize(identifier: string): string {
  return identifier.replace(/_/g, " ");
}

/**
 * The short human name for a task: what it registered, else its humanised
 * identifier.
 *
 * Takes the shape rather than the whole record so tests and the graph's width
 * reservation can call it with a literal.
 */
export function taskTitle(task: Pick<TaskRecord, "name"> & { title?: string | null }): string {
  const declared = task.title;
  return declared !== undefined && declared !== null && declared !== ""
    ? declared
    : humanize(task.name);
}

/**
 * The human name for a dataset, from its URN — `clean orders` out of
 * `urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.clean_orders,PROD)`.
 *
 * Datasets carry no obsel properties of their own, so there is nothing declared
 * to prefer: they are named descriptively already and only the underscores are
 * in the way.
 */
export function datasetTitle(datasetUrn: string): string {
  return humanize(shortName(datasetUrn));
}

/** `reads raw orders · writes clean orders`, or the half of it that applies. */
export function flowLine(task: TaskRecord): string {
  const reads = task.reads.map(datasetTitle).join(", ");
  const writes = task.writes.map(datasetTitle).join(", ");
  if (reads === "" && writes === "") return "declares no inputs or outputs";
  if (reads === "") return `writes ${writes}`;
  if (writes === "") return `reads ${reads}`;
  return `reads ${reads} · writes ${writes}`;
}
