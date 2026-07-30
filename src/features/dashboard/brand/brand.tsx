"use client";

/**
 * The mark, and the product name it reveals.
 *
 * The header used to carry both at once, permanently. A mark and the word it
 * stands for, side by side and never changing, say the same thing twice in a
 * bar whose remaining job is to report which pipeline is on screen and whether
 * the board is live. So the resting header is the mark alone, and the name
 * ghosts in when a pointer is over it.
 *
 * **The one hard rule: nothing else in the header may move.** `orders_pipeline
 * · prod` sits immediately to the right of the name, and a reveal that grew the
 * lockup would shove it sideways every time a pointer crossed the corner of the
 * screen. The name is therefore always in the layout at its full width and is
 * only ever made transparent, so the box it occupies is the same in every state
 * (`brand.module.css` states the same rule against the stylesheet). Opacity,
 * blur and `x` are all either non-layout properties or transforms; not one of
 * them can reflow the line.
 *
 * Two conditions get the name permanently, because in both of them a hover is
 * either impossible or unwanted, and a product name nobody can reach is worse
 * than a header that repeats itself:
 *
 * - **No hover-capable pointer**, which is a touch screen. There is no hover
 *   state to enter, so the reveal would simply never fire.
 * - **`prefers-reduced-motion`**, where this renders `StillMark` and the plain
 *   finished lockup. That follows `guide-panel.tsx`: the preference is honoured
 *   by rendering the finished picture, not by playing a shorter animation.
 */

import { LazyMotion, domMax, m } from "motion/react";
import type { Variants } from "motion/react";
import { memo, useEffect, useState } from "react";

import { Mark, StillMark } from "./mark";
import { Wordmark } from "../mmux";

import styles from "./brand.module.css";

/**
 * The name's three states, named for the lockup rather than for the word.
 *
 * `gathered` and `rest` are deliberately identical. Motion sends one state name
 * to the whole tree, and the mark uses `gathered` for its entrance; the name
 * has no entrance of its own and must stay hidden through both, so the pair
 * being equal here is the point rather than a duplication to tidy away.
 */
const NAME: Variants = {
  gathered: { opacity: 0, filter: "blur(4px)", x: -6 },
  rest: { opacity: 0, filter: "blur(4px)", x: -6 },
  open: { opacity: 1, filter: "blur(0px)", x: 0 },
};

const GHOST = { duration: 0.26, ease: [0.22, 0.61, 0.36, 1] } as const;

/**
 * The mark's height, and the type set beside it.
 *
 * Constants rather than literals because this component renders the lockup
 * twice, once animated and once still, and a size changed in one branch only
 * would be visible to nobody testing with a pointer and reduced motion off.
 *
 * The pair is deliberately not equal. The mark is a solid shape with no
 * ascender or descender, so matching its height to the type's font size makes
 * it read a size smaller than the word: the word's 24px is distributed over
 * lowercase letters that use around half of it, while the mark uses all of its
 * 26px.
 */
const MARK_SIZE = 26;
const NAME_SIZE = 24;

/**
 * Subscribe to a media query, starting at false.
 *
 * Read after mount rather than during render, because the server has no
 * `matchMedia` and a guess made during render would make the first client
 * render disagree with the HTML it is hydrating.
 */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(query);
    const sync = () => setMatches(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [query]);

  return matches;
}

function BrandImpl({ size = MARK_SIZE }: { size?: number }) {
  /*
   * Both preferences are read here rather than through motion's
   * `useReducedMotion`, and that is not a style choice.
   *
   * `useReducedMotion` returns `null` until it has detected, then reports the
   * real answer on a LATER render. Everywhere else in this dashboard that is
   * invisible, because `guide-panel.tsx` and `tour-panel.tsx` re-render on every
   * poll and pick the answer up a tick later. This component is `memo`'d with
   * props that never change, precisely so 43 motion components do not reconcile
   * once a second, so it renders exactly once and would hold that first `null`
   * for the life of the page. Measured: with the preference set at the browser
   * context, the query reported `reduce` and the hook still returned `null`, so
   * the animated lockup rendered for a reader who had asked for no animation.
   *
   * Reading the query directly is also reactive, which the hook is not: a reader
   * who turns the preference on gets the still lockup without a reload.
   */
  const still = useMediaQuery("(prefers-reduced-motion: reduce)");

  /*
   * Whether this pointer can hover at all. Starting false means the first paint
   * is the hover build and a touch device corrects one frame later, which is the
   * safe direction to be wrong in: the opposite order would flash the name on
   * every desktop load.
   */
  const hoverless = useMediaQuery("(hover: none)");

  if (still) {
    return (
      <span className={styles.brand} data-brand="lockup">
        <StillMark size={size} />
        <span className={styles.name} data-brand="name">
          <Wordmark text="obsel" size={NAME_SIZE} />
        </span>
      </span>
    );
  }

  return (
    /*
     * `LazyMotion` with `strict`, the same as `guide-panel.tsx` and
     * `tour-panel.tsx`: `strict` makes the full `motion.` components throw, so
     * a later edit cannot quietly pull in the whole feature bundle for one
     * header animation. `domMax` rather than `domAnimation` because the header
     * shares it with those panels, and two feature bundles would be worse than
     * the one this already loads.
     */
    <LazyMotion features={domMax} strict>
      <m.span
        className={styles.brand}
        data-brand="lockup"
        /*
         * No entrance: `initial={false}` puts the lockup at `rest` on the first
         * frame rather than animating into it.
         *
         * There was one, a `gathered` state the fragments flew out of on mount,
         * and it is gone for want of evidence rather than because it broke. It
         * could not be verified: the only browser available here reports
         * `visibilityState: "hidden"` and serves 0 animation frames per second,
         * and motion is driven by `requestAnimationFrame`, so an entrance
         * renders at its first values and stays there. That is indistinguishable
         * from a mark that is permanently invisible, which is what it looked
         * like. An entrance is worth having and worth adding back, from a real
         * browser where somebody can watch it finish. `mark.tsx` still defines
         * the `gathered` state it would use.
         */
        initial={false}
        animate={hoverless ? "open" : "rest"}
        whileHover={hoverless ? undefined : "open"}
      >
        <Mark size={size} />
        <m.span className={styles.name} data-brand="name" variants={NAME} transition={GHOST}>
          <Wordmark text="obsel" size={NAME_SIZE} />
        </m.span>
      </m.span>
    </LazyMotion>
  );
}

/**
 * Memoised because the header re-renders once a second and this never changes.
 *
 * `useSwarm` polls `GET /api/swarm` every second and the resulting state change
 * re-renders the whole dashboard, this lockup included. Its props do not depend
 * on any of that, so without `memo` React would reconcile 43 motion components
 * every second for a picture that is identical each time.
 */
export const Brand = memo(BrandImpl);
