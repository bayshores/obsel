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

import { useCallback, useState } from "react";

import { Backdrop } from "./backdrop";
import { guide } from "./guide";
import { GuidePanel } from "./guide-panel";
import { DataInspector, Inspector } from "./inspector";
import { joining } from "./joining";
import { JoiningPanel } from "./joining-panel";
import { Lineage } from "./lineage";
import { mine } from "./mine";
import { MinePanel } from "./mine-panel";
import { Panel, PulseDot, StatCell, StatRibbon, Wordmark } from "./mmux";
import { TracePanel } from "./trace-panel";
import { useActivity } from "./use-activity";
import { useTrace } from "./use-trace";
import { useSwarm } from "./use-swarm";
import { clockTime, inDependencyOrder, lastReportAt, summaryLine, totals } from "./timing";
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

  /*
   * The graph panel's height, which the LAYOUT decides at scale.
   *
   * 320 is the four-task demo's number and stays its number: that layout is
   * wide and short, its zoom is pinned by width, and extra height would only
   * be empty panel. A forty-task swarm is also TALL, and the same 320 forced
   * `fitView` below its zoom floor, where it clamps and centres — the graph
   * rendered cut off top and bottom. So the graph reports what its current
   * layout needs at the current width (`panelHeightFor`), the panel grows to
   * it, and the page scrolls when the board genuinely cannot fit the frame.
   * The floor keeps small swarms exactly as they were; the dead-band stops a
   * one-pixel resize from re-fitting the graph every second.
   */
  const [graphHeight, setGraphHeight] = useState(320);
  const onGraphNeedsHeight = useCallback((px: number) => {
    setGraphHeight((current) => {
      const target = Math.max(320, px);
      return Math.abs(target - current) > 8 ? target : current;
    });
  }, []);

  const tasks = inDependencyOrder(data?.snapshot.tasks ?? []);
  const t = totals(tasks);

  // A failed read invalidates every derived number, not just the connection.
  const trusted = data !== null && error === null;
  const selected = tasks.find((task) => task.urn === selectedUrn) ?? null;
  // The graph hands over one URN either way; the entity type inside it says
  // whether the click chose an agent or a table.
  const selectedDataset =
    selected === null && selectedUrn !== null && selectedUrn.startsWith("urn:li:dataset:")
      ? selectedUrn
      : null;

  const guideView = guide({
    trusted,
    everRead,
    tasks,
    snapshotAt: data?.snapshot.at ?? null,
    activity,
  });

  const joinView = joining({
    trusted,
    tasks,
    command: activity?.joinCommand ?? null,
  });

  const mineView = mine({ trusted, tasks });

  return (
    <main
      className={graphHeight > 320 ? `${styles.cockpit} ${styles.cockpitTall}` : styles.cockpit}
    >
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
            {trusted
              ? "connected"
              : everRead
                ? "not connected, showing the last read"
                : "connecting"}
          </span>
        </span>
      </header>

      <GuidePanel view={guideView} activity={activity} activityError={activityError} />

      {error !== null && (
        <div className={styles.alert} role="alert">
          <p className={styles.alertHead}>{error}</p>
          <p className={styles.alertBody}>
            {data === null
              ? "Nothing is shown below because obsel has not managed to read DataHub yet. This is a connection problem, not an empty board."
              : `Everything below is from the last read that worked${lastReadAt === null ? "" : `, at ${clockTime(lastReadAt)}`}, and may already be wrong. The measured numbers stay blank until obsel can read again.`}
          </p>
        </div>
      )}

      <div className={styles.workbench}>
        <Panel
          /*
           * What obsel is for, in the slot that used to hold a caption.
           *
           * The board never said what obsel is for, which was the complaint behind
           * ten rounds of feedback. The first two attempts were prose, a tagline in
           * the header and then paragraphs above the graph, and both were deleted
           * for being how the screen reached 604 words. The third was a question,
           * "is this finished work still built on something that is still true?",
           * and it failed for a reason a word count cannot see: it names nothing.
           * Not an agent, not a table, not a change. It reads well to somebody who
           * already knows what obsel does, which is the one reader who does not
           * need it.
           *
           * This says the same thing with the nouns put back in, and it is a plain
           * statement rather than a question because a reader arriving cold should
           * not have to work out that the picture below is the answer to a riddle
           * above it. Two clauses: what the picture shows, and why that arrangement
           * is a problem worth a tool.
           */
          title="Each agent reads a table another agent wrote, so a change in one can make another's finished work wrong"
          label="How the work connects"
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
            height: graphHeight,
            // A grown panel must not be squeezed back into clipping by a short
            // viewport; the page scrolls instead. Small swarms keep the 220
            // floor, giving up graph before strip exactly as before.
            minHeight: graphHeight > 320 ? graphHeight : 220,
            display: "flex",
            flexDirection: "column",
          }}
          bodyStyle={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }}
        >
          <Backdrop alert={t.stale > 0} />
          <div className={styles.grid} />
          <div className={styles.graphBody}>
            {tasks.length > 0 ? (
              <Lineage
                tasks={tasks}
                onSelect={setSelectedUrn}
                onNeededHeight={onGraphNeedsHeight}
              />
            ) : (
              // Gated on `trusted`, not on `everRead && data !== null`. `data` is
              // deliberately retained across a failed read, so those two are true
              // together whenever the first poll found an empty swarm and a later
              // poll failed — and the copy would then have claimed obsel was
              // connected while the header light beside it read "no read".
              <p className={styles.empty}>
                {trusted
                  ? "No agents yet. obsel is connected, and DataHub holds nothing to draw."
                  : everRead
                    ? "obsel cannot be reached, so nothing here is up to date."
                    : "Reading from DataHub."}
              </p>
            )}
          </div>

          {/*
            The key, and it changed what it explains.

            It used to gloss the three colours: "still true", "out of date",
            "working now". Two problems with that. Every node already prints its
            own state as a word next to the colour ("done", "out of date",
            "running"), so two of the three rows restated something six inches
            away; and green was called "still true" here and "done" there, which
            is two vocabularies for one colour on one screen.

            What nothing said was which box is which. The graph's entire premise
            is that agents read tables other agents write, and a reader who cannot
            tell an agent from a table cannot see the premise at all. The colours
            are now explained by the nodes, and the shapes by the key.

            Still over the graph rather than in its own row, because the vertical
            budget is spent, and still `pointer-events: none` so it cannot eat a
            click meant for a node.
          */}
          {tasks.length > 0 && (
            <ul className={styles.legend} aria-label="What the boxes mean">
              <li>
                <span className={styles.keyAgent} aria-hidden="true" /> an agent
              </li>
              <li>
                <span className={styles.keyTable} aria-hidden="true" /> a table
              </li>
              {/*
                "any box", and this line has now flipped twice, each time to
                match what the click actually does. It said "either one" when
                tables were not clickable and was corrected in a browser; tables
                open a details view of their own now, so the wider promise is
                true again. The key must never promise an interaction the board
                does not have.
              */}
              <li className={styles.keyHint}>click any box for details</li>
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
          {selectedDataset !== null && (
            <DataInspector
              dataset={selectedDataset}
              tasks={tasks}
              readAt={trusted && lastReadAt !== null ? clockTime(lastReadAt) : null}
              roundTripMs={trusted ? roundTripMs : null}
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
        Under the graph a reader has just watched, above the numbers.

        That is the order a judge reads in, and it is where "now do this with
        your own agents" belongs. It was a closed 17px line above the graph,
        which is how the person who wrote its contents came to ask whether obsel
        had any way to help somebody connect.
      */}
      <JoiningPanel view={joinView} />

      {/*
        And the same door for somebody's own tables, immediately after it.

        The README nests this under "bring your own agent" and this board does
        not, deliberately: `mine-panel.tsx` records why a fold inside a fold
        would repeat the mistake the joining panel exists to have fixed. The two
        read as a pair here, in the order the README puts them.
      */}
      <MinePanel view={mineView} tasks={tasks} />

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
            /*
             * "nothing detected yet" rather than "not measured".
             *
             * Both are true and only one of them says which. A settled board is
             * obsel's good outcome, and it was reporting that outcome in the
             * vocabulary of a broken instrument: two cells reading "not measured"
             * and "nothing marked" side by side look like a failed read, which is
             * the one thing they are not.
             *
             * Not "nothing out of date", which is what it says and also word for
             * word what the headline above already says on this board.
             */
            unit={trusted ? (t.timing !== null ? "ms" : "nothing detected yet") : undefined}
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
        {trusted
          ? summaryLine(t.tasks, t.finished, t.stale, lastReportAt(tasks))
          : "Not reading the swarm."}
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
  if (t.tagged === null || t.leftOver === null) return cell(BLANK, "obsel did not check");
  if (t.marked === 0) {
    return t.leftOver > 0
      ? cell(String(t.leftOver), "tags left over from before")
      : cell(BLANK, "nothing to write yet");
  }
  return cell(
    `${t.tagged} of ${t.marked}`,
    t.leftOver > 0 ? `tagged, ${t.leftOver} left over from before` : "tagged",
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
