"use client";

/**
 * Where the operator puts the API token, once.
 *
 * Every mutation the board makes carries it, so this sits above the tabs rather
 * than inside the one that happens to need it first. `use-token.ts` says why the
 * page holds a token at all and why it is pasted rather than delivered.
 *
 * Two states, because a password field that is permanently empty tells a reader
 * nothing about whether a token is stored, and this column's vertical space is
 * measured: a stored token collapses to one line and a button.
 */

import { useState } from "react";

import { useToken } from "./use-token";

import styles from "./token-field.module.css";

export function TokenField() {
  const { token, setToken } = useToken();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (token !== null && !editing) {
    return (
      <div className={styles.row}>
        <span className={styles.set}>API token stored</span>
        <button
          type="button"
          className={styles.button}
          onClick={() => {
            setDraft("");
            setEditing(true);
          }}
        >
          Replace
        </button>
        <button type="button" className={styles.button} onClick={() => setToken(null)}>
          Forget
        </button>
      </div>
    );
  }

  return (
    <form
      className={styles.row}
      onSubmit={(event) => {
        event.preventDefault();
        setToken(draft);
        setDraft("");
        setEditing(false);
      }}
    >
      <input
        className={styles.input}
        /*
         * A password field because `scripts/start.sh` deliberately never prints
         * the token: a demo is usually being recorded, and a board that shows it
         * in full would undo that.
         */
        type="password"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        aria-label="API token"
        placeholder="API token from .env.local"
        autoComplete="off"
        spellCheck={false}
      />
      <button type="submit" className={styles.button} disabled={draft.trim() === ""}>
        Save
      </button>
    </form>
  );
}
