"use client";

/**
 * Which node a reader means, as opposed to which node the pointer crossed.
 *
 * The forty-task board is dense enough that reaching one box sweeps the pointer
 * over several others. Reacting to every one of them would churn the details
 * surface through six previews on the way to the seventh, which is unreadable
 * and reads as a fault. Two delays fix it, and they are different on purpose:
 *
 * - **entering** waits, so a box the pointer only passed over never previews;
 * - **leaving** waits longer, so the gap between two adjacent boxes, or between
 *   a box and the surface describing it, does not flash the panel back to idle.
 *
 * `hold` is what makes the preview usable rather than a tease: a reader moving
 * onto the surface to finish reading it is not leaving the node, so the pending
 * clear is cancelled until they leave the surface too.
 *
 * These are design constants, not measurements, and nothing about obsel's
 * answers depends on them.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const ENTER_MS = 80;
const LEAVE_MS = 140;

export interface HoverIntent {
  /** The node a reader means, or null. */
  urn: string | null;
  enter: (urn: string) => void;
  leave: () => void;
  /** Pointer moved onto the surface: keep whatever is showing. */
  hold: () => void;
  /** Pointer left the surface: resume the pending clear. */
  release: () => void;
}

export function useHoverIntent(): HoverIntent {
  const [urn, setUrn] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);

  const clearTimer = (): void => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  // Nothing here survives the component, including a timer that would otherwise
  // set state on something unmounted.
  useEffect(() => clearTimer, []);

  const enter = useCallback((next: string) => {
    clearTimer();
    held.current = false;
    timer.current = setTimeout(() => setUrn(next), ENTER_MS);
  }, []);

  const leave = useCallback(() => {
    clearTimer();
    timer.current = setTimeout(() => {
      // Held means the pointer is on the surface itself, which is not leaving.
      if (!held.current) setUrn(null);
    }, LEAVE_MS);
  }, []);

  const hold = useCallback(() => {
    held.current = true;
    clearTimer();
  }, []);

  const release = useCallback(() => {
    held.current = false;
    clearTimer();
    timer.current = setTimeout(() => setUrn(null), LEAVE_MS);
  }, []);

  return { urn, enter, leave, hold, release };
}
