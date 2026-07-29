/**
 * The mmux design system components obsel uses, ported to TypeScript.
 *
 * mmux is the author's own design system and predates this repository; see
 * PREEXISTING.md. Six of its components are vendored here rather than
 * imported, for two reasons.
 *
 * **It has to be `.tsx`.** `tsconfig.json` sets `allowJs: false`, so a copied
 * `.jsx` file would be skipped entirely by `pnpm typecheck` — it would ship
 * untypechecked while verify reported green. The port is what puts them inside
 * the same gate as the rest of obsel.
 *
 * **The port is a fork, not a copy.** mmux sets several sizes down at 8–10px,
 * which is correct for a dense desktop instrument panel read at arm's length
 * and wrong for obsel, whose medium is a half-frame screen recording watched
 * through H.264 at half size. Seven sizes are moved up mmux's own ladder, each
 * marked `obsel:` below with what it was. They are all still mmux rungs — this
 * shifts the scale, it does not invent one.
 *
 * `PipelineStep` is deliberately not ported. Its status enum is
 * idle / active / done / **error**, and error renders red. Mapping obsel's
 * `stale` onto it would paint a task that succeeded in the colour of failure,
 * which is the opposite of what a stale mark means.
 */

import type { CSSProperties, ElementType, ReactNode } from "react";

/* ── Wordmark ───────────────────────────────────────────────────────
   mmux ships no logo mark; product names are always set in type. */

export function Wordmark({
  text = "mmux",
  size = 48,
  color = "var(--mm-cream)",
  glow = false,
  as: Tag = "span",
  style,
}: {
  text?: string;
  size?: number;
  color?: string;
  glow?: boolean;
  as?: ElementType;
  style?: CSSProperties;
}) {
  return (
    <Tag
      style={{
        display: "inline-block",
        margin: 0,
        fontSize: size,
        lineHeight: 1,
        textTransform: "lowercase",
        whiteSpace: "nowrap",
        fontFamily: "var(--mm-font-mono)",
        fontWeight: "var(--mm-weight-medium)",
        letterSpacing: "var(--mm-track-word)",
        color,
        textShadow: glow ? "var(--mm-glow-md)" : "none",
        ...style,
      }}
    >
      {text}
    </Tag>
  );
}

/* ── Divider ────────────────────────────────────────────────────────
   Hairline separator with an optional centred mono label. */

export function Divider({ label, style }: { label?: ReactNode; style?: CSSProperties }) {
  const line: CSSProperties = { height: 1, background: "var(--mm-rose-line)" };

  if (label === undefined) {
    return <hr style={{ border: "none", margin: 0, width: "100%", ...line, ...style }} />;
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--mm-space-md)",
        width: "100%",
        ...style,
      }}
    >
      <span style={{ flex: 1, ...line }} />
      <span
        style={{
          color: "var(--obsel-text-quiet)",
          fontFamily: "var(--mm-font-mono)",
          // obsel: was --mm-text-xs (9px). This label carries the stale count.
          fontSize: "var(--mm-text-md)",
          letterSpacing: "var(--mm-track-label)",
          whiteSpace: "nowrap",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {label}
      </span>
      <span style={{ flex: 1, ...line }} />
    </div>
  );
}

/* ── Panel ──────────────────────────────────────────────────────────
   The core surface: 1px rose hairline, header row, body slot. */

export function Panel({
  title,
  meta,
  label,
  tour,
  children,
  padded = true,
  style,
  bodyStyle,
}: {
  title?: ReactNode;
  meta?: ReactNode;
  /**
   * An accessible name for the section, when the title alone is not a stable
   * handle.
   *
   * A `<section>` with no accessible name is not exposed as a landmark, so the
   * page's regions were invisible to a rotor even though each one had a visible
   * heading. It also gives tests something to scope to that does not break when
   * the visible title is reworded.
   */
  label?: string;
  /**
   * A handle the tour can point at, rendered as `data-tour`.
   *
   * Not the accessible name, deliberately. `label` is copy and gets reworded,
   * and a highlight that silently stops appearing when somebody improves a
   * heading is worse than one that was never there.
   */
  tour?: string;
  children?: ReactNode;
  padded?: boolean;
  style?: CSSProperties;
  bodyStyle?: CSSProperties;
}) {
  const sub: CSSProperties = {
    color: "var(--obsel-text-quiet)",
    fontFamily: "var(--mm-font-mono)",
    // obsel: was --mm-text-xs (9px). This is where the endpoint being read is named.
    fontSize: "var(--mm-text-md)",
    letterSpacing: "var(--mm-track)",
    fontVariantNumeric: "tabular-nums",
  };

  return (
    <section
      aria-label={label}
      data-tour={tour}
      style={{
        border: "1px solid var(--mm-border)",
        borderRadius: "var(--mm-radius-none)",
        background: "linear-gradient(180deg, var(--mm-surface), transparent)",
        boxShadow: "var(--mm-shadow-inset)",
        ...style,
      }}
    >
      {(title !== undefined || meta !== undefined) && (
        <header
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: "var(--mm-space-md)",
            padding: "10px 14px",
            borderBottom: "1px solid var(--mm-border)",
            background: "var(--mm-surface)",
          }}
        >
          {title !== undefined ? (
            // An <h2>, not a <span>. It is unambiguously a section heading to
            // anyone looking at it, and was a bare text run to anyone using a
            // heading rotor — the page exposed no structure at all. globals.css
            // already zeroes heading margins, so this changes nothing visually.
            <h2
              style={{
                color: "var(--mm-cream)",
                fontFamily: "var(--mm-font-mono)",
                // obsel: was --mm-text-sm (10px).
                fontSize: "var(--mm-text-lg)",
                fontWeight: "var(--mm-weight-semi)",
                letterSpacing: "var(--mm-track-label)",
              }}
            >
              {title}
            </h2>
          ) : (
            <span />
          )}
          {meta !== undefined ? <span style={sub}>{meta}</span> : null}
        </header>
      )}
      <div style={{ padding: padded ? "var(--mm-space-lg)" : 0, ...bodyStyle }}>{children}</div>
    </section>
  );
}

/* ── StatCell / StatRibbon ──────────────────────────────────────────
   One telemetry reading: a tiny label over a big tabular value. */

export function StatCell({
  label,
  value,
  unit,
  accent = false,
  preserveCase = false,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  /** Marks a measured, confirmed figure. The cell's only emphasis. */
  accent?: boolean;
  /**
   * Leave the label's capitalisation alone.
   *
   * obsel: labels are lowercased for a uniform look, which is right for
   * "detection time" and wrong the moment a label contains someone else's product
   * name. "written into DataHub" rendered as "written into datahub", misspelling
   * DataHub on the one cell whose entire purpose is to credit it.
   *
   * Not the default, because lowercase is still correct for every other label and
   * for obsel's own name, which is lowercase by rule.
   */
  preserveCase?: boolean;
}) {
  /*
   * Two elements, not a wrapper: the label and the figure are placed into rows
   * the RIBBON owns, so every cell's label shares one row and every cell's
   * figure shares the next.
   *
   * The two labels are different heights — "detection time" fits one line and
   * "written into DataHub" takes two in the panel's width — which laid out
   * per-cell pushed one figure a line below the other. Bottom-aligning them
   * instead fixed the common case and would have come apart again on the four
   * states whose unit is a sentence ("nothing detected yet", "2 left over from
   * before"), because a unit that wraps lifts the figure above it. A shared row
   * cannot be knocked out of line by either.
   */
  return (
    <>
      <span
        style={{
          color: "var(--obsel-text-quiet)",
          fontFamily: "var(--mm-font-mono)",
          // obsel: was --mm-text-2xs (8px). "out of date" and "detection time"
          // are the labels a viewer has to read to know what the number means.
          fontSize: "var(--mm-text-cap)",
          letterSpacing: "var(--mm-track-label)",
          lineHeight: 1.3,
          textTransform: preserveCase ? "none" : "lowercase",
        }}
      >
        {label}
      </span>
      {/*
        The figure and its unit as two items on a baseline, not one run of text.
        A long unit — "nothing detected yet", "2 tags left over from before" —
        wraps onto its own line beneath the figure instead of dragging the figure
        with it, which is what produced "3 of" above "3 tagged".
      */}
      <span
        style={{
          display: "flex",
          alignItems: "baseline",
          flexWrap: "wrap",
          columnGap: "var(--mm-space-xs)",
        }}
      >
        <span
          style={{
            color: accent ? "var(--mm-rose)" : "var(--mm-cream)",
            fontFamily: "var(--mm-font-mono)",
            /*
             * obsel: was --mm-text-2xl (26px), set when these were five cells in
             * a ribbon across the full width of the page. They are now two cells
             * in a panel column whose other text is 11 to 13px, and at 26px they
             * read as belonging to a different screen. 20px keeps the hierarchy
             * — it is still by far the largest thing in the panel — without
             * shouting over everything beside it, and it is what lets a value
             * like "3 of 3" sit on one line.
             */
            fontSize: "var(--mm-text-xl)",
            fontWeight: "var(--mm-weight-bold)",
            fontVariantNumeric: "tabular-nums",
            lineHeight: 1,
            // A ratio is one token conceptually, so it never breaks across lines.
            whiteSpace: "nowrap",
            /*
             * No text glow. Nothing else in the panel glows — the two other uses
             * of `--mm-glow-sm` are box-shadows on the guide's active step and
             * the tour, where the thing being lit is a container. A glowing
             * numeral beside plain mono text was the loudest part of the cell and
             * the clearest reason it read as pasted in from somewhere else. The
             * accent colour still marks a measured, confirmed figure.
             */
          }}
        >
          {value}
        </span>
        {unit !== undefined ? (
          <span
            style={{
              // Fixed rather than `0.5em`: tied to the value's size it shrank
              // with it, and a unit is a label, not a smaller number.
              fontSize: "var(--mm-text-md)",
              color: "var(--mm-cream-dim)",
              fontFamily: "var(--mm-font-mono)",
              lineHeight: 1.3,
            }}
          >
            {unit}
          </span>
        ) : null}
      </span>
    </>
  );
}

export function StatRibbon({
  children,
  label,
  tour,
}: {
  children: ReactNode[];
  label?: string;
  /** A handle for the tour to point at. See `Panel`. */
  tour?: string;
}) {
  return (
    <div
      // A named group. Without it the five readings are five loose numbers in
      // the accessibility tree with no statement of what they belong to.
      role="group"
      aria-label={label}
      data-tour={tour}
      style={{
        display: "grid",
        gridAutoFlow: "column",
        gridAutoColumns: "1fr",
        /*
         * One row for the labels, one for the figures, owned here rather than by
         * each cell. `StatCell` places its two elements straight into them
         * through the `subgrid` below, so a label that wraps to two lines makes
         * every label's row taller instead of pushing its own figure down out of
         * line with the one beside it.
         */
        gridTemplateRows: "auto auto",
        border: "1px solid var(--mm-border)",
        background: "var(--mm-surface)",
      }}
    >
      {children.map((child, i) => (
        <div
          // Positional by nature: these are fixed columns of a ribbon, not a
          // list that reorders. There is no id to key on and none is wanted.
          key={i}
          style={{
            display: "grid",
            // Inherit the ribbon's two rows rather than declaring its own, which
            // is what puts every cell's label and figure on shared lines.
            gridTemplateRows: "subgrid",
            gridRow: "span 2",
            rowGap: "var(--mm-space-xs)",
            padding: "10px 14px",
            borderLeft: i === 0 ? "none" : "1px solid var(--mm-border)",
          }}
        >
          {child}
        </div>
      ))}
    </div>
  );
}

/* ── PulseDot ───────────────────────────────────────────────────────
   The universal mmux live signal. */

export function PulseDot({
  color = "var(--mm-green)",
  size = 6,
  pulse = false,
  glow = true,
}: {
  color?: string;
  size?: number;
  pulse?: boolean;
  glow?: boolean;
}) {
  return (
    <span
      // mm-pulse is the ONE looping animation obsel permits, and only on a
      // running task's dot. globals.css stops it under prefers-reduced-motion.
      className={pulse ? "mm-pulse" : undefined}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "var(--mm-radius-pill)",
        background: color,
        boxShadow: glow ? `0 0 ${size}px ${color}` : "none",
        flex: "0 0 auto",
      }}
    />
  );
}
