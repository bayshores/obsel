/**
 * How many words the board puts in front of a reader, split by how they are read.
 *
 * Shared by the four-task ceiling in `cockpit.spec.ts` and the scale-independence
 * check in `scale.spec.ts`, which is the point of pulling it out: the two have to
 * measure the same thing the same way, or comparing them proves nothing.
 *
 * Three kinds of reading, deliberately never summed into one number:
 *
 * - **prose** is sentences somebody has to actually read. It is the metric that
 *   matters and the one that went wrong, and it must not grow with the size of
 *   the pipeline.
 * - **log** is a scrolling step list, skimmed, in a fixed-height panel. Only its
 *   visible rows count. The panel renders the whole trace, so counting all of it
 *   would make a ceiling track how much obsel narrated rather than how dense the
 *   board is, and the way to pass would be to narrate less.
 * - **graph** is one- to three-word labels on boxes, scanned. There is one label
 *   per node and the node count is the user's pipeline, so a TOTAL here measures
 *   how big their pipeline is. It is reported per node instead.
 *
 * Two exclusions, both because this is a budget about what is on screen:
 * the screen-reader-only live region is real text that is deliberately never
 * painted, and the log's scrolled-out rows are held but not shown.
 */

import type { Page } from "@playwright/test";

export interface BoardWords {
  /** Sentences a reader has to read. The number that matters. */
  prose: number;
  /** Visible step rows plus the panel's own always-present chrome. */
  log: number;
  /** Every step row held, visible or scrolled out. Context, never a ceiling. */
  logAll: number;
  /** Every word on every node label, summed. Grows with the pipeline. */
  graph: number;
  /** How many boxes those words are spread across. */
  graphNodes: number;
  /** The most words on any single node. This is the one that must stay small. */
  graphWorst: number;
  /** The polite live region, never painted. */
  announced: number;
}

export async function boardWords(page: Page): Promise<BoardWords> {
  return page.evaluate(() => {
    const count = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;
    const words = (el: Element | null): number =>
      el === null ? 0 : count((el as HTMLElement).innerText ?? "");

    const panel = document.querySelector('[aria-label="What obsel is doing"]');
    const list = panel?.querySelector("ol") ?? null;
    const logAll = words(panel);
    // Anything with pixels inside the scroller's box, so a step half under a
    // sticky heading still counts: a reader can read part of it.
    const logSeen =
      list === null
        ? 0
        : (() => {
            const box = list.getBoundingClientRect();
            return [...list.querySelectorAll("li")]
              .filter((li) => {
                const b = li.getBoundingClientRect();
                return b.bottom > box.top + 1 && b.top < box.bottom - 1;
              })
              .reduce((n, li) => n + count(li.textContent ?? ""), 0);
          })();
    // The panel's own title, count and footnote are on screen always, so they
    // belong in the visible figure.
    const chrome = logAll - words(list);

    /*
     * `innerText`, not `textContent`, and this mattered.
     *
     * `prose` is a subtraction: everything the body says, less the parts counted
     * separately. That only works if both sides are counted the same way, and
     * they were not. A node is two spans, so `textContent` runs the last word of
     * the title into the first word of the status — `martout of date` — and
     * reports one word fewer than the body's own `innerText` contributed. One per
     * node, silently charged to prose.
     *
     * At four tasks and nine boxes that is nine words and looks like rounding. At
     * eighty-two it is most of a paragraph, so the forty-task board appeared to
     * say 25 more words than the demo while its copy was in fact shorter. A
     * ceiling that drifts with node count is the exact defect pulling the graph
     * out of the total was meant to remove.
     */
    const nodes = [...document.querySelectorAll(".react-flow__node")].map((node) => words(node));
    const graph = nodes.reduce((n, each) => n + each, 0);
    const announced = words(document.querySelector('main [aria-live="polite"]'));

    return {
      prose: words(document.body) - logAll - graph - announced,
      log: logSeen + chrome,
      logAll,
      graph,
      graphNodes: nodes.length,
      graphWorst: nodes.reduce((worst, each) => Math.max(worst, each), 0),
      announced,
    };
  });
}

/** One line naming every figure, so a failure reports the whole split. */
export function describeWords(seen: BoardWords): string {
  return (
    `prose ${seen.prose}, log ${seen.log} of ${seen.logAll} held, ` +
    `graph ${seen.graph} over ${seen.graphNodes} nodes (worst ${seen.graphWorst}), ` +
    `announced ${seen.announced}`
  );
}
