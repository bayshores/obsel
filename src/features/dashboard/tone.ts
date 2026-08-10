/**
 * What color a task is drawn in, and the word used for its state.
 *
 * The single place either decision is made, for the graph and the ledger alike.
 * Two surfaces disagreeing about whether a task is stale — on camera, during
 * the one shot the whole demo is built around — is a failure mode worth one
 * shared function to rule out.
 *
 * Nothing here is a color value. Every field resolves to a custom property so
 * the mmux token sheet stays the only definition of the palette.
 */

import type { TaskStatus } from "@/src/server/coordinator/types";

export const STALE = "var(--obsel-stale)";
export const ROSE = "var(--mm-rose)";
export const GREEN = "var(--mm-green)";
export const MUTE = "var(--obsel-text-quiet)";

/**
 * Lowercase, because mmux never uppercases as a styling choice — and because
 * "out of date" is a sentence fragment a viewer reads, not a badge they decode.
 */
export const STATUS_WORD: Record<TaskStatus, string> = {
  registered: "waiting",
  running: "running",
  complete: "done",
  stale: "out of date",
};

/** The longest word above. Feeds `reserveFor`, so box widths never move. */
export const LONGEST_STATUS_WORD: string = Object.values(STATUS_WORD).reduce(
  (longest, word) => (word.length > longest.length ? word : longest),
  "",
);

export interface Tone {
  /** Fills the status bar and the status line. Amber only ever means stale. */
  fill: string;
  /** An outline, when a mark is attached to work that is not itself stale. */
  outline: string | null;
}

/**
 * The only function that decides a node's color.
 *
 * It takes exactly two arguments and reads nothing else — no timer, no
 * animation state, no render count. That is deliberate: the cascade animation
 * can write `stroke-dashoffset` and caption opacity and nothing more, so a
 * dropped frame or an interrupted transition is incapable of changing what the
 * dashboard claims is true.
 *
 * **The invariant: amber FILL if and only if `status === "stale"`.**
 *
 * A mark can outlive that status. `TaskRecord.stale` is documented to persist
 * while a stale task is being re-run to fix it, so such a task sits at
 * `running` with its mark still attached. Two of obsel's correctness rules pull
 * in opposite directions there — "only finished work goes stale" forbids
 * painting in-flight work stale, while "every stale mark carries its reason"
 * forbids hiding the mark — and an outline satisfies both at once. Collapsing
 * this to one argument, or to "amber iff a mark exists", makes the graph and
 * the ledger contradict each other on screen.
 */
export function nodeTone(status: TaskStatus, hasMark: boolean): Tone {
  if (status === "stale") return { fill: STALE, outline: null };
  if (status === "running") return { fill: ROSE, outline: hasMark ? STALE : null };
  if (status === "complete") return { fill: GREEN, outline: hasMark ? STALE : null };
  return { fill: MUTE, outline: null };
}
