"use client";

/**
 * Where the dock sits, how wide it is, and whether it is out of the way.
 *
 * Three preferences, remembered between visits, and nothing about the board
 * itself. That split is the same one `use-tour.ts` records: obsel's state is
 * derived from the swarm on every poll and never stored, so the only things
 * worth persisting are the ones the swarm cannot tell us, which are the ones a
 * reader chose.
 *
 * The width matters more here than it looks. The demo's dagre layout is wide and
 * short, so `fitView` is pinned by the canvas WIDTH, and every pixel this takes
 * is a pixel of graph. That is why the collapse exists and why the clamp has a
 * real ceiling rather than a generous one.
 *
 * Read through `useSyncExternalStore` rather than copied into state in an
 * effect. `localStorage` is an external store and this is the hook for reading
 * one: it takes a separate server snapshot, so the markup React renders on the
 * server and the markup it hydrates against agree by construction instead of by
 * a first-paint correction that shows the dock arriving on the wrong side.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";

export type DockSide = "left" | "right";

export interface DockPrefs {
  side: DockSide;
  width: number;
  collapsed: boolean;
}

export interface DockState extends DockPrefs {
  setSide: (side: DockSide) => void;
  setWidth: (width: number) => void;
  toggleCollapsed: () => void;
}

/** Where it starts, and the reason is the reading order of the picture. */
export const DEFAULT_SIDE: DockSide = "right";

/**
 * 420, which is a measurement rather than a round number.
 *
 * The guide's action buttons carry a label and a detail line, and the widest
 * detail the demo can offer needs about 380px before it breaks across three
 * lines. Below that the dock reads as a column of wrapped fragments; much above
 * it and the graph starts paying for space the guide is not using.
 */
export const DEFAULT_WIDTH = 420;

/** Narrow enough that a fix command still fits on two lines. */
export const MIN_WIDTH = 340;

/**
 * The ceiling, and it is a share of the frame rather than a fixed number.
 *
 * On a 1280 laptop a 620px dock would leave the graph less width than the dock
 * has, which is the wrong way round for a board whose subject is the graph.
 */
export function maxWidth(viewportWidth: number): number {
  return Math.max(MIN_WIDTH, Math.min(620, Math.round(viewportWidth * 0.45)));
}

export function clampWidth(width: number, viewportWidth: number): number {
  return Math.min(maxWidth(viewportWidth), Math.max(MIN_WIDTH, Math.round(width)));
}

const STORE = "obsel.dock.v1";

/** What the server renders, and what a browser with no stored answer gets. */
const DEFAULTS: DockPrefs = { side: DEFAULT_SIDE, width: DEFAULT_WIDTH, collapsed: false };

/*
 * The snapshot `useSyncExternalStore` compares between renders.
 *
 * It has to be the SAME object when nothing changed, or the hook re-renders
 * forever comparing two equal-looking values that are not identical. So the
 * parsed preferences are held here and replaced only when they genuinely change.
 */
let snapshot: DockPrefs | null = null;
const listeners = new Set<() => void>();

/**
 * Read what was stored, tolerating anything.
 *
 * A hand-edited or half-written value must land on the defaults rather than
 * throw, because this runs during the first paint of the whole board: a parse
 * error here would be a blank screen, and the thing it would be protecting is a
 * panel width.
 */
function restore(): DockPrefs {
  try {
    const raw = window.localStorage.getItem(STORE);
    if (raw === null) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Record<keyof DockPrefs, unknown>>;
    return {
      side: parsed.side === "left" ? "left" : DEFAULT_SIDE,
      width:
        typeof parsed.width === "number" && Number.isFinite(parsed.width)
          ? clampWidth(parsed.width, window.innerWidth)
          : DEFAULT_WIDTH,
      collapsed: parsed.collapsed === true,
    };
  } catch {
    return DEFAULTS;
  }
}

function getSnapshot(): DockPrefs {
  if (snapshot === null) snapshot = restore();
  return snapshot;
}

function getServerSnapshot(): DockPrefs {
  return DEFAULTS;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Change a preference and tell everyone reading it.
 *
 * Writing to disk happens here, on a settled change, rather than on every frame
 * of a drag: a resize handle pulled across the screen would otherwise write
 * sixty times a second to record a value that is about to change again.
 */
function commit(next: DockPrefs): void {
  const current = getSnapshot();
  if (
    current.side === next.side &&
    current.width === next.width &&
    current.collapsed === next.collapsed
  ) {
    return;
  }
  snapshot = next;
  try {
    window.localStorage.setItem(STORE, JSON.stringify(next));
  } catch {
    // A browser refusing storage is not a reason to refuse to move the dock.
  }
  for (const listener of listeners) listener();
}

export function useDock(): DockState {
  const prefs = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setSide = useCallback((side: DockSide) => {
    commit({ ...getSnapshot(), side });
  }, []);

  const setWidth = useCallback((width: number) => {
    commit({ ...getSnapshot(), width: clampWidth(width, window.innerWidth) });
  }, []);

  const toggleCollapsed = useCallback(() => {
    const current = getSnapshot();
    commit({ ...current, collapsed: !current.collapsed });
  }, []);

  /*
   * A window narrowed past the clamp takes the dock with it. Without this, a
   * 620px dock stored on a desktop opens on a 900px laptop with 280px left for
   * the graph, and the reader's first sight of the board is a sliver.
   *
   * A listener on an external system rather than a synchronous write, so it runs
   * when the window genuinely changes size and not on every render.
   */
  useEffect(() => {
    const onResize = (): void => {
      const current = getSnapshot();
      commit({ ...current, width: clampWidth(current.width, window.innerWidth) });
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return { ...prefs, setSide, setWidth, toggleCollapsed };
}
