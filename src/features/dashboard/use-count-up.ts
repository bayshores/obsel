"use client";

/**
 * The detection number arriving, counted rather than printed.
 *
 * One figure on the board is the answer to the question the whole demo asks:
 * how long obsel took to notice. It used to appear fully formed between two
 * polls, which is the same as not appearing at all to anyone who blinked. This
 * runs it up from zero over `COUNT_UP_MS` so the moment is visible.
 *
 * **The end state is exact.** The last frame renders the target itself rather
 * than a rounded approximation of it, because this is a measured number and a
 * number obsel measured must be the number obsel shows. Everything about the
 * animation is presentation; nothing about it is allowed to change the value.
 *
 * The math is separated from the hook deliberately: `countUpValue` is pure and
 * unit tested, and the hook around it is four lines of `requestAnimationFrame`
 * that only a browser can exercise.
 */

import { useEffect, useState } from "react";

import { EASE } from "./motion-tokens";

/** How long the run takes. Short enough to be over before a reader looks away. */
export const COUNT_UP_MS = 600;

/**
 * `--mm-ease` evaluated at one point, so the number travels on the same curve
 * everything else on the board does.
 *
 * A cubic bezier is defined in terms of its own parameter, not in terms of
 * elapsed time, so reaching the y for a given x means solving for t first. Twenty
 * halvings settle it well past the precision a rounded integer can show, and it
 * runs once a frame, which is nothing.
 */
function easeAt(progress: number): number {
  const [x1, y1, x2, y2] = EASE;
  const axis = (t: number, a: number, b: number): number => {
    const u = 1 - t;
    return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t;
  };
  let low = 0;
  let high = 1;
  let t = progress;
  for (let i = 0; i < 20; i += 1) {
    t = (low + high) / 2;
    if (axis(t, x1, x2) < progress) low = t;
    else high = t;
  }
  return axis(t, y1, y2);
}

/**
 * What the counter reads, part way through.
 *
 * Pure, and the two ends are the part worth testing: at or past the duration it
 * is the target exactly, and at or before zero it is zero. In between it is the
 * eased fraction rounded, because a detection time is whole milliseconds and a
 * counter showing `73.4126` reads as a different kind of measurement.
 */
export function countUpValue(target: number, elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0 || elapsedMs >= durationMs) return target;
  if (elapsedMs <= 0) return 0;
  return Math.round(target * easeAt(elapsedMs / durationMs));
}

/**
 * The counter as a hook: `null` while there is nothing to show, the target once
 * the run finishes, and the run in between.
 *
 * `key` is what decides a new run. It is not the value: a board polled once a
 * second re-serves the same detection time for as long as the mark stands, and
 * keying on the number would restart the count every second forever. The caller
 * passes something identifying the mark itself, so the run happens once, when
 * the mark does.
 *
 * `animate` false renders the target immediately, with no frames at all. That is
 * the reduced-motion path, and it follows the board's rule: honouring the
 * preference means showing the finished picture, not a hurried animation of it.
 * It is also how a withheld number stays withheld, since an untrusted read has
 * nothing to count towards.
 */
export function useCountUp(target: number | null, key: string, animate: boolean): number | null {
  /*
   * What the counter is currently counting, adjusted during render rather than
   * in an effect.
   *
   * This is React's own pattern for resetting state when the thing it describes
   * changes, and it is used here for a reason a `useEffect` cannot serve: the
   * reset has to be visible in the SAME frame the new mark is. Reset from an
   * effect and the render in between shows the finished number, which is then
   * replaced by zero and counted back up to. That reads as a glitch rather than
   * as an arrival.
   *
   * `target` is part of the identity as well as `key`, so a figure that changes
   * is counted afresh instead of leaving the old one on screen.
   */
  const [counting, setCounting] = useState<{ key: string; target: number } | null>(null);
  const [value, setValue] = useState(0);

  if (
    target !== null &&
    (counting === null || counting.key !== key || counting.target !== target)
  ) {
    setCounting({ key, target });
    setValue(0);
  }

  /*
   * Depends on `counting`, not on `key` and `target` directly, and that is what
   * confines the run to a genuinely new figure. A board polled once a second
   * re-serves the same mark for as long as it stands; `counting` keeps its
   * identity across those polls, so this effect does not re-run and no frames
   * are scheduled. A read that fails and recovers lands on the same mark too,
   * and is likewise not counted twice.
   */
  useEffect(() => {
    if (counting === null || !animate) return;
    let frame = 0;
    let start: number | null = null;
    const step = (now: number): void => {
      if (start === null) start = now;
      const elapsed = now - start;
      setValue(countUpValue(counting.target, elapsed, COUNT_UP_MS));
      if (elapsed < COUNT_UP_MS) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [counting, animate]);

  if (target === null) return null;
  // Not animating means the finished picture on the first frame, which is the
  // board's rule for reduced motion and also what a withheld read wants.
  return animate ? value : target;
}
