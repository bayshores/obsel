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
  glow = false,
  preserveCase = false,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  accent?: boolean;
  glow?: boolean;
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
  return (
    <div style={{ display: "grid", gap: "var(--mm-space-2xs)", padding: "8px 14px" }}>
      <span
        style={{
          color: "var(--obsel-text-quiet)",
          fontFamily: "var(--mm-font-mono)",
          // obsel: was --mm-text-2xs (8px). "out of date" and "detection time"
          // are the labels a viewer has to read to know what the number means.
          fontSize: "var(--mm-text-cap)",
          letterSpacing: "var(--mm-track-label)",
          textTransform: preserveCase ? "none" : "lowercase",
        }}
      >
        {label}
      </span>
      <span
        style={{
          color: accent ? "var(--mm-rose)" : "var(--mm-cream)",
          fontFamily: "var(--mm-font-mono)",
          // obsel: was --mm-text-stat (17px). These five numbers are the
          // measured result; at half size 17px is not enough.
          fontSize: "var(--mm-text-2xl)",
          fontWeight: "var(--mm-weight-bold)",
          fontVariantNumeric: "tabular-nums",
          lineHeight: 1,
          textShadow: glow ? "var(--mm-glow-sm)" : "none",
        }}
      >
        {value}
        {unit !== undefined ? (
          <span style={{ fontSize: "0.5em", color: "var(--mm-cream-dim)", marginLeft: 3 }}>
            {unit}
          </span>
        ) : null}
      </span>
    </div>
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
        border: "1px solid var(--mm-border)",
        background: "var(--mm-surface)",
      }}
    >
      {children.map((child, i) => (
        <div
          // Positional by nature: these are fixed columns of a ribbon, not a
          // list that reorders. There is no id to key on and none is wanted.
          key={i}
          style={{ borderLeft: i === 0 ? "none" : "1px solid var(--mm-border)" }}
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
