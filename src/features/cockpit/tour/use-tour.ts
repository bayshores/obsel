"use client";

/**
 * Where the tour is, and who decided it.
 *
 * The split this hook exists to keep: **the reader owns which explanation they
 * are reading, and the board owns whether an action has happened.** Nothing
 * about chapter two is stored anywhere, because storing it is how a tour ends
 * up insisting you press a button you pressed ten minutes ago. It is derived on
 * every render from the same snapshot the rest of the cockpit is derived from,
 * so a board driven from a terminal, from somebody else's agent, or from a
 * reload halfway through all open the tour at the act that genuinely comes next.
 *
 * What is stored, in `localStorage`, is two things about the person: whether
 * they have ever met the tour, so the button stops asking for attention after
 * the first time; and the step they last had open, so closing and reopening does
 * not start them over. Both are preferences, the same class of thing as the
 * folded panels in `mine-panel.tsx`. Neither is ever consulted about the board.
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

import { TOUR, settledIndex } from "./steps";
import type { TourStep } from "./steps";
import type { GuideInput } from "../guide";

/** One key, one small object. Bumping the version resets everyone, deliberately. */
const STORE = "obsel.tour.v1";

interface Stored {
  /** They have opened it, finished it, or said not now. The button goes quiet. */
  met: boolean;
  /** The step they last had open, by id. Ids are stable; see `steps.ts`. */
  at: string | null;
}

const NEW_HERE: Stored = { met: false, at: null };

/**
 * The stored record, read the way React wants a browser-only value read.
 *
 * `useSyncExternalStore` rather than a `useState` seeded in an effect, and the
 * difference is not style. `localStorage` does not exist while the page is
 * rendered on the server, so a value read during render makes the server's HTML
 * and the browser's first paint disagree and React throws out the subtree. This
 * hands React a server snapshot to hydrate against and the real one immediately
 * after, which is the supported way to say "this value only exists in a browser".
 */
function subscribe(onChange: () => void): () => void {
  // Another tab clearing the record is a real event and worth honouring; it is
  // also the only thing that fires here, since a tab's own writes do not.
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(STORE);
  } catch {
    // Private browsing, a blocked origin. Nothing is stored, and the only
    // consequence is that the tour offers itself again next time.
    return null;
  }
}

function parse(raw: string | null): Stored {
  if (raw === null) return NEW_HERE;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return NEW_HERE;
    const candidate = parsed as Partial<Stored>;
    return {
      met: candidate.met === true,
      at: typeof candidate.at === "string" ? candidate.at : null,
    };
  } catch {
    return NEW_HERE;
  }
}

function save(next: Stored): void {
  try {
    window.localStorage.setItem(STORE, JSON.stringify(next));
  } catch {
    /* Nothing to do and nothing worth telling anybody. The tour still works. */
  }
}

export interface TourState {
  open: boolean;
  /** The step on screen, already reconciled against the board. */
  step: TourStep;
  /** Its position, 1-based, for `3 of 10`. */
  number: number;
  total: number;
  /**
   * Nobody has met the tour in this browser yet, so the button asks to be
   * noticed. False the moment they open it or say not now, and never true
   * again in this browser.
   */
  fresh: boolean;
  start: () => void;
  close: () => void;
  next: () => void;
  back: () => void;
  /** "not now" on the opening offer: the button goes quiet without opening. */
  dismiss: () => void;
}

export function useTour(input: GuideInput): TourState {
  const [open, setOpen] = useState(false);

  /*
   * Stepping back pauses the board from pulling the reader forward again.
   *
   * Without it, going back to look at an act that is already done would last
   * exactly one frame: the reconciliation below would see it done and advance
   * straight past it. Pressing next clears it, so ordinary forward movement
   * hands control back to the board.
   */
  const [held, setHeld] = useState(false);

  const raw = useSyncExternalStore(subscribe, readRaw, () => null);
  /*
   * What has been decided in this session, which has not necessarily been read
   * back out of the store. A tab's own write does not fire a `storage` event,
   * so without this every press would leave the hook showing the value from
   * before it.
   */
  const [session, setSession] = useState<Stored | null>(null);
  const persisted = useMemo(() => parse(raw), [raw]);
  const stored = session ?? persisted;

  const bookmark = Math.max(
    0,
    TOUR.findIndex((step) => step.id === stored.at),
  );

  /*
   * The reconciliation, derived during render rather than in an effect.
   *
   * An effect would apply it a frame late, which on the poll that finishes an
   * act means one frame of the tour still asking for something that has already
   * happened. Here the step on screen is always the one the current snapshot
   * supports.
   */
  const at = held ? bookmark : settledIndex(bookmark, input);

  const put = useCallback((next: Stored) => {
    setSession(next);
    save(next);
  }, []);

  const goTo = useCallback(
    (to: number) => put({ met: true, at: TOUR[Math.min(Math.max(to, 0), TOUR.length - 1)].id }),
    [put],
  );

  const start = useCallback(() => {
    setOpen(true);
    setHeld(false);
    goTo(at);
  }, [at, goTo]);

  const close = useCallback(() => {
    setOpen(false);
    goTo(at);
  }, [at, goTo]);

  const dismiss = useCallback(() => goTo(at), [at, goTo]);

  const next = useCallback(() => {
    setHeld(false);
    goTo(at + 1);
  }, [at, goTo]);

  const back = useCallback(() => {
    setHeld(true);
    goTo(at - 1);
  }, [at, goTo]);

  return {
    open,
    step: TOUR[at],
    number: at + 1,
    total: TOUR.length,
    fresh: !stored.met,
    start,
    close,
    next,
    back,
    dismiss,
  };
}
