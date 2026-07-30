import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MARK_BOWL,
  MARK_GRAINS,
  MARK_HEIGHT,
  MARK_VIEWBOX,
  MARK_WIDTH,
} from "@/src/features/dashboard/brand/mark-geometry";

/**
 * The favicon and the in-app mark are the same drawing, kept in two files.
 *
 * `app/icon.svg` has to be a static file: it is a Next.js file convention, and
 * the `<link rel="icon">` is generated from it at build time, so it cannot
 * import the geometry module the dashboard draws from. The two therefore hold
 * duplicate copies of the same 43 contours.
 *
 * That duplication is the reason this file exists. Nothing about a wrong
 * favicon is loud: it is 16 pixels wide, it is cached hard by every browser,
 * and it renders in a strip nobody is looking at. A regeneration that updates
 * the module and not the icon would leave the tab showing the previous mark
 * indefinitely, and no other check in the repository would notice.
 *
 * The two colour assertions are not style policing. Both encode the one thing
 * the icon is for beyond identity: staying legible in a browser tab whose
 * theme obsel does not control.
 */

const ICON = readFileSync(new URL("../app/icon.svg", import.meta.url), "utf8");

/** Every `d` in the icon, in document order. */
function iconPaths(): string[] {
  return [...ICON.matchAll(/<path\s+d="([^"]+)"\s*\/>/g)].map((m) => m[1]);
}

function attr(tag: string, name: string): string {
  const el = new RegExp(`<${tag}\\b[^>]*>`).exec(ICON);
  if (el === null) throw new Error(`app/icon.svg has no <${tag}>`);
  const found = new RegExp(`\\b${name}="([^"]+)"`).exec(el[0]);
  if (found === null) throw new Error(`<${tag}> in app/icon.svg has no ${name}`);
  return found[1];
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("the favicon draws the same mark as the page", () => {
  it("holds the bowl and every fragment, in the module's order", () => {
    expect(iconPaths()).toEqual([MARK_BOWL, ...MARK_GRAINS]);
  });

  it("has no path the geometry module does not define", () => {
    // Guards the direction the assertion above cannot: a path appended to the
    // icon by hand would still leave the first 42 matching.
    expect(iconPaths()).toHaveLength(1 + MARK_GRAINS.length);
  });

  it("keeps the bowl and its counter in one path", () => {
    // Two contours, one `d`. Split into separate paths, the nonzero fill rule
    // has nothing to subtract and the hole in the "o" fills solid.
    expect(MARK_BOWL.match(/M/g)).toHaveLength(2);
  });
});

describe("the favicon survives a browser tab it does not control", () => {
  it("is filled to its own edges", () => {
    // A rounded or inset background would let the tab strip's own colour show
    // at the corners, which is the single thing the red is there to prevent.
    const [, , w, h] = attr("svg", "viewBox").split(/\s+/).map(Number);
    expect(attr("rect", "width")).toBe(String(w));
    expect(attr("rect", "height")).toBe(String(h));
    expect(ICON).not.toMatch(/<rect[^>]*\brx=/);
  });

  it("draws the mark clear of its own background", () => {
    const background = attr("rect", "fill");
    const mark = attr("g", "fill");
    expect(contrast(mark, background)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("the mark's declared box is the box its geometry occupies", () => {
  it("agrees with MARK_WIDTH and MARK_HEIGHT", () => {
    // `mark.tsx` derives its rendered width from these two numbers rather than
    // from the viewBox, so a viewBox edited alone would silently stretch it.
    expect(MARK_VIEWBOX).toBe(`0 0 ${MARK_WIDTH.toFixed(2)} ${MARK_HEIGHT.toFixed(2)}`);
  });

  it("is wider than it is tall, which is why the mark is sized by height", () => {
    expect(MARK_WIDTH).toBeGreaterThan(MARK_HEIGHT);
  });
});
