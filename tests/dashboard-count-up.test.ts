/**
 * The detection number as it runs up to itself.
 *
 * One property matters more than the rest and is asserted first: the run ends on
 * the measured value exactly. obsel's rule is that it never shows a number it did
 * not measure, and an animation that landed on 117 for a measured 118 would be
 * breaking that rule in the last frame, where nobody would look for it.
 *
 * The hook around this is four lines of `requestAnimationFrame`, which only a
 * browser can exercise; `e2e/dashboard.spec.ts` covers that half.
 */

import { describe, expect, it } from "vitest";

import { COUNT_UP_MS, countUpValue } from "@/src/features/dashboard/use-count-up";

describe("where the count starts and ends", () => {
  it("ends on the measured value exactly", () => {
    expect(countUpValue(118, COUNT_UP_MS, COUNT_UP_MS)).toBe(118);
    expect(countUpValue(5399, COUNT_UP_MS, COUNT_UP_MS)).toBe(5399);
  });

  it("stays on the measured value after the run is over", () => {
    expect(countUpValue(118, COUNT_UP_MS + 5000, COUNT_UP_MS)).toBe(118);
  });

  it("starts at zero", () => {
    expect(countUpValue(118, 0, COUNT_UP_MS)).toBe(0);
  });

  /*
   * A frame can be delivered with a negative elapsed time if the clock is read
   * before the run's own start stamp. Rendering a negative millisecond count
   * beside the word "detection time" would read as a broken instrument.
   */
  it("never goes below zero on an early frame", () => {
    expect(countUpValue(118, -16, COUNT_UP_MS)).toBe(0);
  });

  it("shows the value straight away when there is no duration to run over", () => {
    expect(countUpValue(118, 0, 0)).toBe(118);
  });
});

describe("how it travels", () => {
  it("only ever moves forward", () => {
    let previous = -1;
    for (let elapsed = 0; elapsed <= COUNT_UP_MS; elapsed += 8) {
      const value = countUpValue(5399, elapsed, COUNT_UP_MS);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it("stays within the value it is counting towards", () => {
    for (let elapsed = 0; elapsed <= COUNT_UP_MS; elapsed += 8) {
      expect(countUpValue(118, elapsed, COUNT_UP_MS)).toBeLessThanOrEqual(118);
    }
  });

  /*
   * `--mm-ease` is front loaded: most of the distance is covered early and the
   * tail settles. That is what makes the number read as arriving rather than as
   * a progress bar, and it is the same curve every other movement on the board
   * uses, so it is worth pinning that this is the curve in use.
   */
  it("covers most of the distance in the first half", () => {
    const half = countUpValue(1000, COUNT_UP_MS / 2, COUNT_UP_MS);
    expect(half).toBeGreaterThan(500);
  });

  it("renders whole milliseconds, never a fraction", () => {
    for (let elapsed = 0; elapsed <= COUNT_UP_MS; elapsed += 17) {
      expect(Number.isInteger(countUpValue(5399, elapsed, COUNT_UP_MS))).toBe(true);
    }
  });
});
