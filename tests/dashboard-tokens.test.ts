import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { AMBER, ROSE } from "@/src/features/dashboard/backdrop/backdrop-shader";

/**
 * The backdrop shader is the one place in the dashboard that cannot use a token.
 *
 * A WebGL uniform takes three numbers; it cannot resolve `var(--mm-rose)`. So
 * the two colours it needs are written out as 0–1 triples, and this file is
 * what stops them drifting from the stylesheet. A linter cannot see inside an
 * array of floats — nothing else would catch mmux retuning its rose and the
 * backdrop quietly keeping the old one for the rest of the project's life.
 */

const CSS = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

function tokenHex(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(CSS);
  if (match === null) throw new Error(`--${name} is not defined as a hex literal in globals.css`);
  return match[1].toLowerCase();
}

function hexToTriple(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

describe("shader colours equal their design tokens", () => {
  it("ROSE is --mm-rose", () => {
    const expected = hexToTriple(tokenHex("mm-rose"));
    for (let i = 0; i < 3; i += 1) {
      expect(ROSE[i], `channel ${i} of --mm-rose (${tokenHex("mm-rose")})`).toBeCloseTo(
        expected[i],
        3,
      );
    }
  });

  it("AMBER is --obsel-stale", () => {
    const expected = hexToTriple(tokenHex("obsel-stale"));
    for (let i = 0; i < 3; i += 1) {
      expect(AMBER[i], `channel ${i} of --obsel-stale (${tokenHex("obsel-stale")})`).toBeCloseTo(
        expected[i],
        3,
      );
    }
  });

  it("would notice a drift — the two colours are not interchangeable", () => {
    expect(ROSE).not.toEqual(AMBER);
    expect(tokenHex("mm-rose")).not.toBe(tokenHex("obsel-stale"));
  });
});

describe("the obsel token block is complete", () => {
  it("defines every custom property the page references", () => {
    for (const token of ["obsel-stale", "obsel-stale-wash", "obsel-stale-line", "obsel-focus"]) {
      expect(CSS, `--${token} missing from globals.css`).toContain(`--${token}:`);
    }
  });

  it("derives the stale wash and line from the stale hue, not a second colour", () => {
    const [r, g, b] = hexToTriple(tokenHex("obsel-stale")).map((c) => Math.round(c * 255));
    for (const token of ["obsel-stale-wash", "obsel-stale-line"]) {
      const match = new RegExp(`--${token}:\\s*rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+)`).exec(CSS);
      expect(match, `--${token} should be an rgba of the stale hue`).not.toBeNull();
      expect([Number(match?.[1]), Number(match?.[2]), Number(match?.[3])]).toEqual([r, g, b]);
    }
  });

  it("keeps the focus ring off the stale hue, so the two can never be confused", () => {
    const focus = /--obsel-focus:\s*([^;]+);/.exec(CSS)?.[1].trim();
    expect(focus).toBe("var(--mm-rose-hot)");
  });
});

describe("no stray colour literals in the page's own source", () => {
  /*
   * Enumerated from disk, not listed by hand.
   *
   * This was a hardcoded array of four filenames, and deleting one of them broke
   * the test outright. The worse failure was the silent one: every stylesheet
   * added since the list was written, including the new node components, was
   * never checked at all. Reading the directory means a new file is covered the
   * moment it exists.
   *
   * `backdrop-shader.ts` is the one exemption, and it is exempt by name because
   * GLSL has no custom properties to reference: its colours are float triples
   * that a test elsewhere asserts against the tokens they mirror.
   *
   * The walk is recursive because the stylesheets live in a folder per concern.
   * A flat read covered whichever files had not been grouped yet, which is the
   * same silent gap in a new form.
   */
  const FILES = readdirSync(new URL("../src/features/dashboard/", import.meta.url), {
    recursive: true,
  })
    .map(String)
    .filter((name) => name.endsWith(".module.css") || name === "tone.ts")
    .sort();

  it("checks every stylesheet in the directory, so a new one cannot go unexamined", () => {
    expect(FILES).toContain("dashboard.module.css");
    expect(FILES).toContain("graph/lineage.module.css");
    expect(FILES).toContain("graph/nodes.module.css");
    expect(FILES).toContain("tone.ts");
  });

  it("keeps the palette in globals.css, with the shader triples the sole exception", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(
        new URL(`../src/features/dashboard/${file}`, import.meta.url),
        "utf8",
      );
      const code = source
        // comments legitimately quote hex values while explaining them
        .replace(/\/\*[\s\S]*?\*\//g, "")
        // A mask-image's colours are an alpha ramp, not paint: `#000` there
        // means "fully opaque at this stop" and never reaches a pixel as a
        // colour. Exempted by declaration rather than by loosening the rule,
        // so a real hex sneaking into `background` or `fill` still fails.
        .replace(/mask-image:[^;]+;/g, "");
      for (const hit of code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) offenders.push(`${file}: ${hit[0]}`);
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Contrast, computed rather than asserted in prose.
 *
 * obsel is read as a compressed screen recording at half size, so quiet text
 * being merely "de-emphasised" is not a style choice with no consequence. The
 * token that carries the stat-ribbon labels, the fingerprint being compared,
 * the ledger timestamps and the divider stating the stale count sat at 2.25:1
 * until this test existed.
 */
function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: readonly number[]): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrast(fg: readonly number[], bg: readonly number[]): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Composite a translucent foreground over an opaque background. */
function over(fg: readonly number[], bg: readonly number[], alpha: number): number[] {
  return [0, 1, 2].map((i) => bg[i] + alpha * (fg[i] - bg[i]));
}

function rgbaToken(name: string): { rgb: number[]; alpha: number } {
  const match = new RegExp(
    `--${name}:\\s*rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([\\d.]+)\\)`,
  ).exec(CSS);
  if (match === null) throw new Error(`--${name} is not an rgba() literal in globals.css`);
  return {
    rgb: [Number(match[1]), Number(match[2]), Number(match[3])],
    alpha: Number(match[4]),
  };
}

function hexRgb(name: string): number[] {
  const n = Number.parseInt(tokenHex(name).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

describe("quiet text clears WCAG AA on every background it is drawn on", () => {
  const AA = 4.5;

  it("--obsel-text-quiet is legible on ink, the raised surface and the stale wash", () => {
    const quiet = rgbaToken("obsel-text-quiet");
    const ink = hexRgb("mm-ink");
    const ink2 = hexRgb("mm-ink-2");
    const stale = hexRgb("obsel-stale");
    const wash = rgbaToken("obsel-stale-wash");

    const backgrounds: [string, number[]][] = [
      ["--mm-ink", ink],
      ["--mm-ink-2", ink2],
      // a stale ledger row: the amber wash composited over ink
      ["stale wash over ink", over(stale, ink, wash.alpha)],
    ];

    for (const [name, bg] of backgrounds) {
      const text = over(quiet.rgb, bg, quiet.alpha);
      const ratio = contrast(text, bg);
      expect(
        ratio,
        `--obsel-text-quiet on ${name} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(AA);
    }
  });

  it("records why mmux's own muted token could not be used as-is", () => {
    // Not a criticism of mmux — 0.28 is right for decoration. It is a record
    // that the override exists for a measured reason, and a guard against
    // someone "simplifying" the dashboard back onto it.
    const mute = rgbaToken("mm-cream-mute");
    const ink = hexRgb("mm-ink");
    const ratio = contrast(over(mute.rgb, ink, mute.alpha), ink);
    expect(ratio).toBeLessThan(AA);
  });

  it("keeps the stale amber itself well clear of AA", () => {
    const ink2 = hexRgb("mm-ink-2");
    expect(contrast(hexRgb("obsel-stale"), ink2)).toBeGreaterThanOrEqual(AA);
  });
});
