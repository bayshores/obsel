"use client";

/**
 * React wrapper around the backdrop shader.
 *
 * Deliberately thin, and deliberately holding no state. The shader's own
 * settings live in the handle, not in React, so an `alert` change repaints one
 * frame through a uniform instead of re-rendering a component tree — and so a
 * lost WebGL context can never desynchronise from what the cockpit believes.
 */

import { useEffect, useRef } from "react";

import { AMBER, ROSE, mountBackdrop } from "./backdrop-shader";
import type { BackdropHandle } from "./backdrop-shader";

export function Backdrop({ alert }: { alert: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<BackdropHandle | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    handleRef.current = mountBackdrop(canvas, { tint: ROSE, alert: 0, speed: 0 });
    return () => {
      handleRef.current?.destroy();
      handleRef.current = null;
    };
  }, []);

  useEffect(() => {
    // Runs on mount as well as on change, in the same effect flush as the
    // mount above and therefore before the browser composites the canvas. That
    // is what makes a reload mid-cascade paint amber straight away — there is
    // no "you missed it" state. Reading `alert` through a ref during render to
    // seed the mount would be the obvious alternative and is forbidden:
    // react-hooks/refs rejects touching a ref while rendering.
    //
    // Only the colour uniform moves. speed stays 0 — see backdrop-shader.ts on
    // why nothing animates here during the one shot that matters.
    handleRef.current?.set({ tint: alert ? AMBER : ROSE, alert: alert ? 1 : 0 });
  }, [alert]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        display: "block",
        pointerEvents: "none",
      }}
    />
  );
}
