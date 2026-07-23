"use client";

/**
 * The cockpit a judge watches while the demo runs.
 *
 * One read, `GET /api/swarm`, once a second. Everything on screen is derived
 * from that snapshot by pure functions — `layoutGraph` for where things sit,
 * `nodeTone` for what colour they are, `totals` and `detectionTiming` for the
 * numbers. There is no second source and nothing is remembered between polls,
 * so the cockpit cannot drift out of step with what the coordinator believes.
 *
 * The honesty rule that shapes the layout: **obsel never shows a number it did
 * not measure.** When the read fails, every stat becomes an em dash rather than
 * holding its last value, because a stale "0 out of date" beside a broken
 * connection is precisely the false all-clear obsel exists to prevent.
 */

import { useState } from "react";

import { Backdrop } from "./backdrop";
import { guide } from "./guide";
import { GuidePanel } from "./guide-panel";
import { Inspector } from "./inspector";
import { Lineage } from "./lineage";
import { Panel, PulseDot, StatCell, StatRibbon, Wordmark } from "./mmux";
import { TracePanel } from "./trace-panel";
import { useActivity } from "./use-activity";
import { useTrace } from "./use-trace";
import { useSwarm } from "./use-swarm";
import { clockTime, inDependencyOrder, summaryLine, totals } from "./timing";
import type { SwarmTotals } from "./timing";

import styles from "./cockpit.module.css";

/**
 * What a withheld number reads as.
 *
 * Was an em dash. The honesty rule it serves is unchanged: when a read fails,
 * every derived figure renders as this rather than holding its last value,
 * because a stale "0 out of date" beside a broken connection is exactly the false
 * all-clear obsel exists to prevent. Only the character changed.
 */
const BLANK = "··";

export function Cockpit() {
  const { data, error, lastReadAt, roundTripMs, everRead } = useSwarm();
  const { activity, error: activityError } = useActivity();
  const { events: traceEvents, error: traceError } = useTrace();
  // A URN, not a TaskRecord: the record is replaced by a new object on every
  // poll, so holding one would pin the inspector to a snapshot that is seconds
  // stale while the rest of the cockpit moves on.
  const [selectedUrn, setSelectedUrn] = useState<string | null>(null);

  const tasks = inDependencyOrder(data?.snapshot.tasks ?? []);
  const t = totals(tasks);

  // A failed read invalidates every derived number, not just the connection.
  const trusted = data !== null && error === null;
  const selected = tasks.find((task) => task.urn === selectedUrn) ?? null;

  const guideView = guide({
    trusted,
    everRead,
    tasks,
    snapshotAt: data?.snapshot.at ?? null,
    activity,
  });

  return (
    <main className={styles.cockpit}>
      {/*
        One line: who this is, which pipeline, and whether the board is live.

        The tagline ("flags finished agent work when what it was built on
        changes") and the poll description ("reading obsel once a second") both
        lived here. The tagline is what the headline below now says in terms of
        what actually happened, and the poll rate is machinery, not news. Both are
        still recorded, in the details panel and the README.
      */}
      <header className={styles.header}>
        <div className={styles.identity}>
          <Wordmark text="obsel" size={20} />
          <span className={styles.flow}>
            {data?.snapshot.flow !== undefined ? shortFlow(data.snapshot.flow) : "no swarm"}
          </span>
        </div>

        {/* One light. /api/health does not exist, so the cockpit reports what the
            browser genuinely observed and nothing more: a fabricated
            "datahub: ok" would be a claim nobody checked. */}
        <span className={styles.light}>
          <PulseDot color={trusted ? "var(--mm-green)" : "var(--mm-red)"} />
          <span style={{ color: trusted ? "var(--mm-green)" : "var(--mm-red)" }}>
            {trusted ? "connected" : everRead ? "showing the last good read" : "connecting"}
          </span>
        </span>
      </header>

      <GuidePanel view={guideView} activity={activity} activityError={activityError} />

      {error !== null && (
        <div className={styles.alert} role="alert">
          <p className={styles.alertHead}>{error}</p>
          <p className={styles.alertBody}>
            {data === null
              ? "Nothing is shown below because obsel has not read the swarm yet. This is a connection problem, not an empty swarm."
              : `The graph and ledger below are the last successful read${lastReadAt === null ? "" : ` from ${clockTime(lastReadAt)}`} and may already be wrong. Every measured number is withheld until a read succeeds.`}
          </p>
        </div>
      )}

      <div className={styles.workbench}>
        <Panel
          title="how the work connects"
          // The subtitle said "each box is an agent; each panel beside it is a
          // table it reads or writes". The boxes now carry legible names at 13px
          // instead of hand-positioned 11px SVG text, and the arrows say which
          // way the data moves, so the picture no longer needs a caption
          // explaining how to read it.
          padded={false}
          /*
           * A fixed height, and NOT the region that absorbs the column's slack.
           *
           * That reads backwards for the board's most important panel, so it is
           * worth stating why. `fitView` scales the graph to fit, and this layout
           * is about 1500 x 180, so the scale is decided entirely by the width
           * available. Extra height cannot make the picture any bigger; it only
           * adds empty panel above and below a band of boxes. Handing this row the
           * slack produced exactly that, and then a 154px black gap at the bottom
           * of the frame once the row was capped to stop it.
           *
           * 320 fits the graph at its zoom ceiling with breathing room, and the
           * log strip beneath takes everything else. Shrinkable to 220 so a short
           * viewport gives up graph before it gives up the strip or scrolls.
           */
          style={{
            flex: "0 1 auto",
            height: 320,
            minHeight: 220,
            display: "flex",
            flexDirection: "column",
          }}
          bodyStyle={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }}
        >
          <Backdrop alert={t.stale > 0} />
          <div className={styles.grid} />
          <div className={styles.graphBody}>
            {tasks.length > 0 ? (
              <Lineage tasks={tasks} onSelect={setSelectedUrn} />
            ) : (
              // Gated on `trusted`, not on `everRead && data !== null`. `data` is
              // deliberately retained across a failed read, so those two are true
              // together whenever the first poll found an empty swarm and a later
              // poll failed — and the copy would then have claimed obsel was
              // connected while the header light beside it read "no read".
              <p className={styles.empty}>
                {trusted
                  ? "No agents registered yet. obsel is connected and the board is empty."
                  : everRead
                    ? "Not reading obsel. Nothing below is current."
                    : "Reading from DataHub."}
              </p>
            )}
          </div>

          {/*
            The key. Amber is the entire message of this board and nothing on
            screen said what it meant — you had to already know. It sits over the
            graph rather than in its own row because the vertical budget is
            spent, and it is `pointer-events: none` so it cannot eat a click
            meant for a node.
          */}
          {tasks.length > 0 && (
            <ul className={styles.legend} aria-label="What the colours mean">
              <li>
                <PulseDot color="var(--mm-green)" size={7} glow={false} /> still true
              </li>
              <li>
                <PulseDot color="var(--obsel-stale)" size={7} glow={false} /> out of date
              </li>
              <li>
                <PulseDot color="var(--mm-rose)" size={7} glow={false} pulse /> working now
              </li>
            </ul>
          )}
        </Panel>

        {/* The gutter: beside the graph on a wide screen, a fixed strip beneath
            it otherwise. It is fixed in its cross-axis either way, so the graph
            stays the only region that gives up pixels. */}
        <div className={styles.gutter}>
          {/*
            Rendered only when something is selected, which reverses an earlier
            decision worth recording. The inspector used to hold its slot
            permanently so that opening it moved nothing — right when its
            neighbour was a thin feed. Beside the trace it was ruinous: the two
            split a 220px gutter, and 106px is less than this panel's header
            plus its footnote, so the step list was laid out at exactly ZERO
            pixels. The transparency the whole panel exists for was measurable
            only in the DOM.

            What that discipline protected is still protected: the gutter's
            height is fixed, so the graph, ledger, ribbon and footer do not move
            when this appears — only the trace beside it gives up room, and only
            while someone is deliberately reading raw values.
          */}
          {selected !== null && (
            <Inspector
              task={selected}
              snapshotAt={data?.snapshot.at ?? null}
              readAt={trusted && lastReadAt !== null ? clockTime(lastReadAt) : null}
              roundTripMs={trusted ? roundTripMs : null}
              // Not gated on `trusted`: this is where DataHub's UI lives, not a
              // measurement of it, so a failed read does not make it wrong.
              datahubUrl={data?.datahubUrl ?? null}
              onClose={() => setSelectedUrn(null)}
              style={{
                flex: "1 1 0",
                minWidth: 0,
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
              }}
            />
          )}
          <TracePanel
            events={traceEvents}
            error={traceError}
            style={{
              flex: "1 1 0",
              minWidth: 0,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
            }}
          />
        </div>
      </div>

      {/*
        Two figures, down from five.

        `tasks`, `finished` and `out of date` all left: every one of them is
        countable off the graph, and between this ribbon, the headline and the
        ledger's divider the board was stating "3 of 4" four separate times.
        What is left is the pair a reader cannot derive by looking, and the one
        the whole demo exists to establish.
      */}
      <StatRibbon label="Detection">
        {[
          <StatCell
            key="detection"
            label="detection time"
            value={trusted && t.timing !== null ? String(t.timing.ms) : BLANK}
            unit={trusted ? (t.timing !== null ? "ms" : "not measured") : undefined}
            accent={trusted && t.timing !== null}
            glow={trusted && t.timing !== null}
          />,
          /*
           * What obsel put back into DataHub, counted from what DataHub reports.
           *
           * This slot held "deepest reach · 2 hops", which was the largest of the
           * `· N hops` labels the graph's own boxes already carry: the ribbon
           * restating the screen. What went here instead is the claim the board
           * could not make at all. obsel writes a tag and its properties onto each
           * marked job through the MCP server, and until now the only trace of that
           * on screen was five grey words at the bottom of a scroller. This counts
           * the tags back off the entities.
           *
           * A real check, not a badge. obsel writes the mark before the tag and
           * DataHub's writes are asynchronous, so a marked task legitimately has no
           * tag for a moment and the count reads low until it lands. That is why
           * this is a count rather than a tick: a number moving from 2 of 3 to 3 of
           * 3 reads as a write in flight, where a red cross would read as a failure
           * and be wrong. The one state that never resolves itself is a tag with no
           * mark, which is named separately.
           */
          writeBack(trusted, t),
        ]}
      </StatRibbon>

      {/*
        The ledger is gone from the board, and its content is not.

        It rendered all four tasks as cards carrying a status word, a human name, a
        code identifier, a job sentence, a reason sentence, a timestamp and a line
        of runner metadata: 311px and 205 words, describing the same four tasks the
        graph above draws. Two renderings of one thing, and together the largest
        single source of the 604 words on this screen.

        Every one of those facts now lives in the details panel, opened by clicking
        a box on the graph. The mark's `reason` is unchanged, still stored on the
        mark, still written into DataHub, and still shown verbatim rather than
        summarised, so the rule that a mark carries a traceable cause is untouched.

        The live region stays. It is the only thing that announced the cascade to a
        screen reader, and it costs no pixels.
      */}
      <p className={styles.announce} role="status" aria-live="polite">
        {trusted ? summaryLine(t.tasks, t.finished, t.stale) : "Not reading the swarm."}
      </p>
    </main>
  );
}

/**
 * The write-back cell, in every state it can honestly be in.
 *
 * Five states, and the distinctions between them are the point:
 *
 * - **read failed** — withheld, like every other measured figure on the board.
 * - **not recorded** — this snapshot predates obsel reading tags back, so it says
 *   so. Rendering `0 of 3` would claim three tags are missing that obsel never
 *   looked for, which understates its own contribution and is still a false claim.
 * - **nothing marked** — a calm board. `0 of 0 tagged` is true and reads as a
 *   failure, so it is worded rather than counted.
 * - **left over** — DataHub holds a tag for work obsel considers clean. Unlike a
 *   shortfall this never resolves by waiting, so it gets its own words.
 * - **counted** — `N of M`, accented only when every write is confirmed.
 */
function writeBack(trusted: boolean, t: SwarmTotals): React.ReactElement {
  // `preserveCase`, because the ribbon lowercases labels and this one carries
  // DataHub's name. It rendered as "written into datahub" until this was added,
  // misspelling the product on the one cell that exists to credit it.
  const cell = (value: string, unit?: string, lit = false): React.ReactElement => (
    <StatCell
      key="written"
      label="written into DataHub"
      preserveCase
      value={value}
      unit={unit}
      accent={lit}
      glow={lit}
    />
  );

  if (!trusted) return cell(BLANK);
  if (t.tagged === null || t.leftOver === null) return cell(BLANK, "not recorded");
  if (t.marked === 0) {
    return t.leftOver > 0 ? cell(String(t.leftOver), "left over") : cell(BLANK, "nothing marked");
  }
  return cell(
    `${t.tagged} of ${t.marked}`,
    t.leftOver > 0 ? `tagged, ${t.leftOver} left over` : "tagged",
    t.tagged === t.marked,
  );
}

/** `urn:li:dataFlow:(obsel,orders_pipeline,prod)` → `orders_pipeline · prod`. */
function shortFlow(flowUrn: string): string {
  const open = flowUrn.indexOf("(");
  if (open === -1) return flowUrn;
  const parts = flowUrn
    .slice(open + 1)
    .replace(")", "")
    .split(",");
  return parts.length >= 3 ? `${parts[1]} · ${parts[2]}` : flowUrn;
}
