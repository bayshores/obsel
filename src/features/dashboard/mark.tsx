"use client";

/**
 * obsel's mark, drawn from the geometry in `mark-geometry.ts`.
 *
 * Sized by HEIGHT rather than width. The mark is wider than it is tall because
 * the scattered fragments run off to the right, so sizing by width would shrink
 * the letter itself to match a box most of which is empty, and the "o" beside
 * the wordmark would read a size smaller than the type next to it.
 *
 * The fill is `currentColor` and there is no colour prop. The mark sits on
 * `--mm-ink` in the dashboard and on nothing in particular elsewhere, and a baked
 * colour is exactly how the traced original arrived: two greys that would both
 * have been invisible against the dashboard's background. Inheriting means the
 * mark cannot be left behind by a change to the text colour around it.
 *
 * Decorative by default. In the header it sits inside a lockup that already
 * spells "obsel" in text, so announcing it would make a screen reader say the
 * product name twice. Pass a `label` where it stands alone.
 *
 * **This renders `m` components and must be inside a `LazyMotion`.** It draws
 * no animation of its own: every state here is reached by a variant name its
 * parent sets, which is what lets one hover on the lockup move the fragments
 * and the wordmark together. `brand.tsx` is that parent.
 */

import { m } from "motion/react";
import type { Variants } from "motion/react";
import type { CSSProperties } from "react";

import { MARK_BOWL, MARK_GRAINS, MARK_HEIGHT, MARK_VIEWBOX, MARK_WIDTH } from "./mark-geometry";

/**
 * The three states the mark is ever in, named once so the lockup, the bowl and
 * the fragments cannot drift apart.
 *
 * Motion propagates ONE state name down the whole tree, so the wordmark's
 * states have to be these states too. That is the reason they are named for
 * what the lockup is doing rather than for what the fragments are doing:
 * "scattered" would say nothing about a word fading in.
 */
export type MarkState = "gathered" | "rest" | "open";

/**
 * Stagger lives here rather than on the fragments.
 *
 * `staggerChildren` is a property of the parent's transition, and the mark's
 * `svg` is the parent of the 41 fragments. On the lockup it would stagger the
 * lockup's own children, which are the mark and the wordmark: two things.
 */
export const MARK_STAGGER: Variants = {
  gathered: {},
  // Assembling: a beat after the bowl, then outward, nearest fragment first.
  rest: { transition: { delayChildren: 0.08, staggerChildren: 0.012 } },
  // Coming apart: quicker, because it answers a pointer and has to feel immediate.
  open: { transition: { staggerChildren: 0.006 } },
};

const BOWL: Variants = {
  gathered: { opacity: 0, scale: 0.88 },
  rest: { opacity: 1, scale: 1 },
  open: { opacity: 1, scale: 1 },
};

/*
 * Fragment displacement is a function of index, and the index is meaningful:
 * `mark-geometry.ts` sorts the fragments left to right, so index 0 is the one
 * closest to the letter and index 40 is the furthest flung. Multiplying by `i`
 * therefore moves the outer fragments furthest, which is what makes the group
 * read as dispersing rather than sliding.
 *
 * The vertical spread is `sin(i * 2.399)`, not a random number. It has to be
 * identical on the server and on the client or React reports a hydration
 * mismatch, and it has to be identical between renders or the fragments jump.
 * 2.399 radians is close enough to the golden angle that consecutive fragments
 * land far apart instead of forming visible bands.
 */
const GRAIN: Variants = {
  gathered: (i: number) => ({ x: -4 - i * 0.42, y: 0, scale: 0.3, opacity: 0 }),
  rest: { x: 0, y: 0, scale: 1, opacity: 1 },
  open: (i: number) => ({
    x: 3 + i * 0.5,
    y: Math.sin(i * 2.399) * 3.5,
    scale: 0.78,
    opacity: 0.5,
  }),
};

const SETTLE = { duration: 0.5, ease: [0.22, 0.61, 0.36, 1] } as const;
const DISPERSE = { duration: 0.34, ease: [0.33, 0.9, 0.4, 1] } as const;

/**
 * Scale and displacement are measured from each shape's own centre.
 *
 * A CSS transform on an SVG child takes its origin from the SVG's user space,
 * not the shape, so without `fill-box` every fragment would scale toward the
 * top-left corner of the viewBox and the group would collapse sideways instead
 * of each square shrinking in place. One frozen object, not one per path.
 */
const PIVOT: CSSProperties = { transformBox: "fill-box", transformOrigin: "center" };

export function Mark({
  size = 20,
  label,
  className,
}: {
  /** Height in pixels. Width follows from the mark's own proportions. */
  size?: number;
  /** Accessible name. Omit where the lockup already names the product. */
  label?: string;
  className?: string;
}) {
  const decorative = label === undefined;

  return (
    <m.svg
      viewBox={MARK_VIEWBOX}
      height={size}
      width={(size * MARK_WIDTH) / MARK_HEIGHT}
      fill="currentColor"
      className={className}
      variants={MARK_STAGGER}
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={label}
      /* The fragments reach the right edge of the viewBox, and `open` pushes
         them past it. Without this they would be clipped mid-hover. */
      style={{ overflow: "visible", display: "block", flexShrink: 0 }}
    >
      <m.path d={MARK_BOWL} data-mark="bowl" variants={BOWL} transition={SETTLE} style={PIVOT} />
      {MARK_GRAINS.map((d, i) => (
        // Index as key AND as `custom`: this list is a frozen constant that is
        // never reordered or filtered, and the index is the fragment's distance
        // from the letter, which is what the variants above are a function of.
        <m.path
          key={i}
          custom={i}
          d={d}
          data-mark="grain"
          data-grain={i}
          variants={GRAIN}
          transition={DISPERSE}
          style={PIVOT}
        />
      ))}
    </m.svg>
  );
}

/**
 * The mark with nothing moving, for reduced motion.
 *
 * Not `Mark` with the animation props withheld: an `m.path` carrying a variant
 * whose parent never names a state still resolves nothing and renders at its
 * plain attribute values, which is the right picture by luck rather than by
 * construction. This renders plain paths, so the finished mark is the only
 * thing it can produce.
 */
export function StillMark({
  size = 20,
  label,
  className,
}: {
  size?: number;
  label?: string;
  className?: string;
}) {
  const decorative = label === undefined;

  return (
    <svg
      viewBox={MARK_VIEWBOX}
      height={size}
      width={(size * MARK_WIDTH) / MARK_HEIGHT}
      fill="currentColor"
      className={className}
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={label}
      style={{ overflow: "visible", display: "block", flexShrink: 0 }}
    >
      <path d={MARK_BOWL} data-mark="bowl" />
      {MARK_GRAINS.map((d, i) => (
        <path key={i} d={d} data-mark="grain" data-grain={i} />
      ))}
    </svg>
  );
}
