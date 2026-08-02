"use client";

/**
 * The API token the operator pastes in, and the header the board sends with it.
 *
 * Every mutating route obsel serves requires a bearer token, including the four
 * the board itself calls. `src/server/http/auth.ts` records why that changed and
 * what was wrong with the earlier arrangement. The consequence here is that the
 * page needs somewhere to keep a token, and the operator needs one place to put
 * it.
 *
 * **The token is not delivered to the page, it is pasted into it.** `.env.local`
 * holds it, `scripts/start.sh` generates it there, and a route that handed it to
 * the browser would mean anyone who can load the board can read it, which is the
 * gate spelled backwards.
 *
 * `localStorage` rather than component state, for the same reason
 * `use-erasure.ts` keeps the request id there: the board is reloaded constantly
 * during a demo, and a token that has to be re-pasted after every reload is one
 * an operator will stop pasting. It is read through `useSyncExternalStore` so
 * the server's markup and the hydrated markup agree by construction, which for a
 * field a reader may already be typing into is correctness rather than polish.
 */

import { useCallback, useSyncExternalStore } from "react";

const STORE = "obsel.token.v1";

/** Undefined until first read, so the store is loaded once rather than per render. */
let token: string | null | undefined;
const listeners = new Set<() => void>();

function readStore(): string | null {
  try {
    const stored = window.localStorage.getItem(STORE);
    return stored === null || stored === "" ? null : stored;
  } catch {
    return null;
  }
}

function getSnapshot(): string | null {
  if (token === undefined) token = readStore();
  return token;
}

/** The server holds no operator's token, and none is the honest answer there. */
function getServerSnapshot(): string | null {
  return null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The `Authorization` header for a mutation, or nothing at all.
 *
 * Not a hook, so the panels can spread it into a `fetch` inside an event
 * handler without re-rendering on a token they are not displaying. With no
 * token it contributes no header, and obsel answers 401 with a sentence saying
 * so, which is the message the operator should see rather than one this page
 * invented about a field being empty.
 */
export function authHeader(): Record<string, string> {
  const current = typeof window === "undefined" ? null : getSnapshot();
  return current === null ? {} : { Authorization: `Bearer ${current}` };
}

/** What a panel adds to a 401 so the operator knows where the token goes. */
export const TOKEN_HINT =
  "Paste the API token from .env.local into the token field at the top of this panel.";

export interface TokenState {
  token: string | null;
  setToken: (next: string | null) => void;
}

export function useToken(): TokenState {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setToken = useCallback((next: string | null) => {
    const trimmed = next === null ? null : next.trim();
    const value = trimmed === "" || trimmed === null ? null : trimmed;
    if (getSnapshot() === value) return;
    token = value;
    try {
      if (value === null) window.localStorage.removeItem(STORE);
      else window.localStorage.setItem(STORE, value);
    } catch {
      // A browser refusing storage still gets a working board for this session:
      // the value stays in the module and the header still goes out.
    }
    for (const listener of listeners) listener();
  }, []);

  return { token: current, setToken };
}
