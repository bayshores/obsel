"use client";

/**
 * The panel's tab strip.
 *
 * Four regions of the old board became these: the activity feed, the two
 * bring-your-own panels, and later the erasure report. They were rows stacked
 * above and below the graph, and stacking them is what starved the feed, so the
 * one thing this file must never do is show two of them at once.
 *
 * The strip is a real `tablist` of real buttons. That is worth stating because
 * the alternative shows up in every second dashboard: divs with click handlers,
 * which cannot be reached by the tab key, cannot be operated by a screen reader,
 * and report nothing about which one is current.
 */

import { m } from "motion/react";

import styles from "./panel.module.css";

/**
 * Which panel the panel is showing.
 *
 * `data` rather than `your data`, and `join` rather than `joining`: these are the
 * names in the markup and in the tour's own mapping, and they should read as
 * what a person would call the tab.
 */
export type TabId = "activity" | "history" | "join" | "data" | "erasure";

/**
 * The tabs, in the order the README introduces what they hold.
 *
 * The activity feed leads because it is the evidence for the sentence directly
 * above it in the guide. Then the two doors, agent before data, which is the
 * pairing and the order the README uses; a test used to assert they were
 * adjacent rows on the board, and the adjacency now lives here.
 */
const TABS: { id: TabId; label: string }[] = [
  { id: "activity", label: "activity" },
  /*
   * Second, next to the feed it is most likely to be confused with and most
   * needs distinguishing from.
   *
   * The feed is what obsel is doing now, and it does not survive a restart. This
   * is what obsel has decided here, kept in DataHub. Adjacent because a reader who
   * has just watched a cascade go past in the feed is exactly the reader who then
   * wants to know whether it is on the record; the labels carry the distinction —
   * "activity" is present tense, "history" is not.
   */
  { id: "history", label: "history" },
  /*
   * "your agent" and "your data", rather than "join" and "data".
   *
   * The two panels behind them are titled "bring your own agent" and "bring your
   * own data", and a pair of tabs that reads as a pair is what tells a reader
   * they are two halves of one offer. "join" on its own said nothing about what
   * a reader would be joining with.
   */
  { id: "join", label: "your agent" },
  { id: "data", label: "your data" },
  /*
   * Last, because it answers a different question from the other three.
   *
   * Those are all about the swarm on the board. This one is about a named
   * erasure request and the assets a subject's data reached, which is the same
   * lineage machinery pointed at a different obligation.
   */
  { id: "erasure", label: "erasure" },
];

export function panelId(tab: TabId): string {
  return `panel-panel-${tab}`;
}

function tabId(tab: TabId): string {
  return `panel-tab-${tab}`;
}

export function Tabs({
  active,
  onSelect,
  still,
}: {
  active: TabId;
  onSelect: (tab: TabId) => void;
  /** Reduced motion: the underline is placed rather than travelled. */
  still: boolean;
}) {
  return (
    <div className={styles.tabs} role="tablist" aria-label="What the panel is showing">
      {TABS.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            id={tabId(tab.id)}
            role="tab"
            aria-selected={selected}
            aria-controls={panelId(tab.id)}
            /*
             * Only the current tab is in the tab order, which is the roving
             * pattern a tablist is supposed to use: arrowing moves between tabs
             * and tabbing moves out of the strip into the panel. Four separate
             * tab stops in front of the panel is the thing that makes keyboard
             * users avoid tabs entirely.
             */
            tabIndex={selected ? 0 : -1}
            className={styles.tab}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(event) => {
              const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (step === 0) return;
              event.preventDefault();
              const at = TABS.findIndex((entry) => entry.id === active);
              const next = TABS[(at + step + TABS.length) % TABS.length];
              onSelect(next.id);
              document.getElementById(tabId(next.id))?.focus();
            }}
          >
            {tab.label}
            {selected && (
              /*
               * One element for the whole strip, moved by motion rather than
               * four elements switched on and off. `layoutId` is what makes it
               * the same object arriving somewhere new, and it is the reason
               * the panel's `LazyMotion` loads `domMax`: layout projection is
               * not in the smaller feature set.
               */
              <m.span
                className={styles.tabUnderline}
                layoutId="panel-tab-underline"
                {...(still ? {} : { transition: { duration: 0.24, ease: [0.2, 0.8, 0.2, 1] } })}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
