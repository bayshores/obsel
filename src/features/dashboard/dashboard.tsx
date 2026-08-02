"use client";

/**
 * The dashboard a judge watches while the demo runs.
 *
 * One read, `GET /api/swarm`, once a second. Everything on screen is derived
 * from that snapshot by pure functions — `layoutPositions` for where things sit,
 * `nodeTone` for what colour they are, `totals` and `detectionTiming` for the
 * numbers. There is no second source and nothing is remembered between polls,
 * so the dashboard cannot drift out of step with what the coordinator believes.
 *
 * The honesty rule that shapes the layout: **obsel never shows a number it did
 * not measure.** When the read fails, every stat blanks rather than holding its
 * last value, because a stale "0 out of date" beside a broken connection is
 * precisely the false all-clear obsel exists to prevent.
 *
 * The shape of the screen: the lineage canvas IS the page, and one panel beside
 * it holds the guide, the evidence and the numbers. `dashboard.module.css` records
 * why, and what it cost. The three things this file owns that the swarm cannot
 * tell it are the panel's position, which tab is open, and which node is selected.
 */

import { useCallback, useMemo, useState } from "react";

import { Backdrop } from "./backdrop/backdrop";
import { Brand } from "./brand/brand";
import { Panel } from "./panel/panel";
import type { TabId } from "./panel/tabs";
import { usePanel } from "./panel/use-panel";
import { ErasureTab } from "./erasure/erasure-tab";
import { useErasure } from "./erasure/use-erasure";
import { guide } from "./guide/guide";
import type { GuideInput } from "./guide/guide";
import { DetailsSurface } from "./details/details-surface";
import { joining } from "./joining/joining";
import { Lineage } from "./graph/lineage";
import { yourData } from "./your-data/your-data";
import { PulseDot } from "./mmux";
import { useToken } from "./token/use-token";
import { TourPanel, TourOpener } from "./tour/tour-panel";
import type { TourTarget } from "./tour/steps";
import { useTour } from "./tour/use-tour";
import { useActivity } from "./hooks/use-activity";
import { useHoverIntent } from "./hooks/use-hover-intent";
import { useChanges } from "./hooks/use-changes";
import { useTrace } from "./hooks/use-trace";
import { useSwarm } from "./hooks/use-swarm";
import { clockTime, inDependencyOrder, lastReportAt, summaryLine, totals } from "./timing";
import type { TaskRecord } from "@/src/server/coordinator/types";

import styles from "./dashboard.module.css";

/**
 * Which node one URN names.
 *
 * The graph hands over one URN whichever kind of box was pointed at; the entity
 * type inside it says whether that was an agent or a table. Written once and
 * called twice, for the pinned node and the hovered one, so the two can never
 * come to disagree about what a URN means.
 */
function resolve(
  tasks: TaskRecord[],
  urn: string | null,
): { task: TaskRecord | null; dataset: string | null } {
  if (urn === null) return { task: null, dataset: null };
  const task = tasks.find((candidate) => candidate.urn === urn) ?? null;
  if (task !== null) return { task, dataset: null };
  return { task: null, dataset: urn.startsWith("urn:li:dataset:") ? urn : null };
}

export function Dashboard() {
  const { data, error, lastReadAt, roundTripMs, everRead } = useSwarm();
  const { activity, error: activityError } = useActivity();
  const { events: traceEvents, error: traceError } = useTrace();
  // A URN, not a TaskRecord: the record is replaced by a new object on every
  // poll, so holding one would pin the inspector to a snapshot that is seconds
  // stale while the rest of the dashboard moves on.
  const [selectedUrn, setSelectedUrn] = useState<string | null>(null);
  // What the pointer is on, which is a different question from what a reader
  // committed to by clicking. Held here rather than in the canvas because two
  // siblings need it: the details surface previews it, and the graph animates
  // the edges around it.
  const hover = useHoverIntent();

  const panel = usePanel();
  const [activeTab, setActiveTab] = useState<TabId>("activity");

  /*
   * The erasure half, and the two pieces of state it needs.
   *
   * `graphMode` is the reader's choice to colour the board by coverage instead
   * of by staleness. Neither is persisted: a returning reader lands on the
   * staleness board, which is what obsel is watching continuously, rather than
   * on a report about a request they may have finished with.
   *
   * The report is only read while something is showing it. A five-second lineage
   * walk running behind a tab nobody has open is load on DataHub for no reader.
   */
  const [graphMode, setGraphMode] = useState(false);
  const erasure = useErasure(activeTab === "erasure" || graphMode);
  // Read here rather than in the guide panel, because the guide's view is a pure
  // function of one input object and this is one of the facts it decides on.
  const { token } = useToken();

  /*
   * The change history, read only while its tab is open.
   *
   * Same rule as the erasure report and for the same reason: this walks a ledger
   * in DataHub, once per record, and running that behind a tab nobody has open is
   * load obsel is putting on DataHub for no reader. History is also append-only
   * and grows once per cascade, so nothing is missed by not watching it.
   */
  const changes = useChanges(activeTab === "history");

  /*
   * The report as a lookup the graph can use, or nothing.
   *
   * Built here rather than in the canvas so the rule is in one place: the board
   * is coloured by coverage only when a reader asked for that AND a report has
   * actually been read. A mode with no report would paint every table as
   * unreached, which is a claim about an estate obsel has not looked at.
   */
  const coverage = useMemo(() => {
    if (!graphMode || erasure.report === null) return null;
    return new Map(erasure.report.coverage.map((entry) => [entry.asset, entry.state]));
  }, [graphMode, erasure.report]);

  const tasks = inDependencyOrder(data?.snapshot.tasks ?? []);
  const t = totals(tasks);

  // A failed read invalidates every derived number, not just the connection.
  const trusted = data !== null && error === null;
  const selected = resolve(tasks, selectedUrn);
  const hovered = resolve(tasks, hover.urn);
  const inspecting = selected.task !== null || selected.dataset !== null;
  /*
   * Which node the board draws flow around: the pointer wins, and the pinned
   * node keeps it when the pointer is elsewhere. Hovering a second node while
   * one is pinned therefore shows what a click would open without disturbing
   * what is open.
   */
  const flowUrn = hover.urn ?? selectedUrn;
  // The legend and the details card share the bottom edge of a narrow canvas,
  // so the legend stands down whenever the card is showing anything.
  const showingDetails = inspecting || hovered.task !== null || hovered.dataset !== null;

  /*
   * One input object, read by both the guide panel and the tour.
   *
   * Named rather than built inline because the tour's action steps ask the same
   * questions of it the guide does -- has anything been registered, has it all
   * finished, is anything marked -- and two objects built from the same fields
   * in two places is how the two would eventually answer differently.
   */
  const guideInput: GuideInput = {
    trusted,
    everRead,
    tasks,
    snapshotAt: data?.snapshot.at ?? null,
    activity,
    hasToken: token !== null,
  };
  const guideView = guide(guideInput);

  const joinView = joining({
    trusted,
    tasks,
    command: activity?.joinCommand ?? null,
  });

  const mineView = yourData({ trusted, tasks });

  /*
   * The tour. It reads the same input as everything else and stores nothing
   * about the board; `tour/use-tour.ts` records the split.
   */
  const tour = useTour(guideInput);

  /*
   * How the tour reaches a region that is currently behind a tab.
   *
   * Three of its steps point at panels that used to be permanently on screen and
   * are now one of three views of the panel's body. A highlight applied to a
   * region that is not rendered lands on nothing, and the tour would appear to
   * skip the step: it would advance, having pointed at nothing.
   *
   * So the tour asks for a region and the dashboard opens it. The guide and the
   * numbers are permanently visible, and the graph is the page, so those three
   * are deliberately no-ops rather than omissions.
   */
  const reveal = useCallback(
    (target: TourTarget) => {
      if (target === "trace") setActiveTab("activity");
      if (target === "joining") setActiveTab("join");
      if (target === "erasure") setActiveTab("erasure");
      if (panel.collapsed && target !== "graph") panel.toggleCollapsed();
    },
    [panel],
  );

  return (
    <main className={styles.stage}>
      {/*
        One line: who this is, which pipeline, and whether the board is live.
      */}
      <header className={styles.header}>
        <div className={styles.identity}>
          {/*
            The mark, and the name it reveals on hover. `Brand` owns both, and
            reserves the name's full width in every state so that the flow name
            to its right does not move when a pointer crosses the corner.
          */}
          <Brand />
          {/*
            Which board this is, and how to open a different one.

            A disclosure rather than a permanent paragraph, because the header is
            one line by design and this is needed once. Closed, it is the name it
            always was.

            No button switches boards, and the sentence does not pretend one
            does. obsel reads the flow once when it starts, and the demo agents
            read the same variable independently, so a control here would move
            the board and leave the agents pointed at the old one.
          */}
          <details className={styles.board}>
            <summary className={styles.flow}>
              {data?.snapshot.flow !== undefined ? shortFlow(data.snapshot.flow) : "no swarm"}
            </summary>
            <p className={styles.boardNote}>
              This board is one DataFlow in DataHub. obsel reads its name when it starts, so
              starting it with a different one opens a separate board, with its own agents and its
              own history. A new board opens empty, which is the one state that offers the choice
              between the demo agents and the taxi swarm. Nothing on this board is deleted or moved.
              {/*
                A command rather than the bare variable name. The board's own
                rule, asserted in `e2e/dashboard.spec.ts`, is that a lone
                identifier in a code span is an internal name leaking into a
                sentence, and that a command earns its span by having a verb and
                an argument.
              */}
              <code className={styles.boardCommand}>OBSEL_FLOW_ID=my_board pnpm dev</code>
            </p>
          </details>
        </div>

        <div className={styles.headerEnd}>
          {/*
            The way into the tour, and on a first visit the thing on this board
            most likely to be noticed. In the header rather than inside the guide
            block, because it has to be findable in every state the board can be
            in, including the ones where that block is a connection error.
          */}
          <TourOpener tour={tour} />

          {/* One light. /api/health does not exist, so the page reports what
              the browser genuinely observed and nothing more: a fabricated
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
        </div>
      </header>

      {/*
        What this block adds, once the guide has already said the board lost its
        connection: the endpoint that failed, and when the last working read was.
        Both are facts a reader cannot get anywhere else on the screen.

        Still its own row rather than a banner over the canvas. A warning that
        covers the board it is warning about is worse than no warning, and the
        canvas gives up the pixels and re-fits underneath it.
      */}
      {error !== null && (
        <div className={styles.alert} role="alert">
          <p className={styles.alertHead}>{error}</p>
          <p className={styles.alertBody}>
            {data === null
              ? "Nothing is shown below because obsel has not managed to read DataHub yet. This is a connection problem, not an empty pipeline."
              : `Everything below is from the last read that worked${lastReadAt === null ? "" : `, at ${clockTime(lastReadAt)}`}, and may already be wrong.`}
          </p>
        </div>
      )}

      <div className={panel.side === "left" ? `${styles.deck} ${styles.deckLeft}` : styles.deck}>
        <section
          className={styles.canvasRegion}
          aria-label="How the work connects"
          data-tour="graph"
        >
          <Backdrop alert={t.stale > 0} />
          <div className={styles.grid} />
          <div className={styles.graphBody}>
            {tasks.length > 0 ? (
              <Lineage
                tasks={tasks}
                onSelect={setSelectedUrn}
                onHover={(urn) => (urn === null ? hover.leave() : hover.enter(urn))}
                flowUrn={flowUrn}
                focus={selectedUrn}
                coverage={coverage}
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
            What obsel is for, over the picture it is about.

            This was the graph panel's title, and it is the sentence the board
            took ten rounds of feedback to arrive at. The first two attempts were
            prose, a tagline in the header and then paragraphs above the graph,
            and both were deleted for being how the screen reached 604 words. The
            third was a question, "is this finished work still built on something
            that is still true?", and it failed for a reason a word count cannot
            see: it names nothing. Not an agent, not a table, not a change. It
            reads well to somebody who already knows what obsel does, which is
            the one reader who does not need it.

            This says the same thing with the nouns put back in, and it is a
            plain statement rather than a question because a reader arriving cold
            should not have to work out that the picture is the answer to a
            riddle above it.
          */}
          {/*
            Not gated on there being a graph. An empty board is the state where
            a reader most needs to be told what this screen is for, and it was
            the one state that used to say it: the sentence was a panel title, so
            it stood over the empty panel too. Losing it here would have made the
            first thing a new operator sees the one thing that explains nothing.
          */}
          <div className={styles.caption}>
            <h2 className={styles.captionTitle}>
              Each agent reads a table another agent wrote, so a change in one can make
              another&apos;s finished work wrong
            </h2>
          </div>

          {/*
            The key, and it explains the shapes rather than the colours.

            Every node already prints its own state as a word next to the colour
            ("done", "out of date", "running"), so glossing the colours here
            restated something six inches away in a second vocabulary. What
            nothing said was which box is which, and the graph's entire premise
            is that agents read tables other agents write.

            Hidden while the details card is open: the two would otherwise share
            the bottom edge of a narrow canvas.
          */}
          {tasks.length > 0 && !showingDetails && coverage === null && (
            <ul className={styles.legend} aria-label="What the boxes mean">
              <li>
                <span className={styles.keyAgent} aria-hidden="true" /> an agent
              </li>
              <li>
                <span className={styles.keyTable} aria-hidden="true" /> a table
              </li>
              {/* No "click any box for details" hint here. The details surface
                  in the opposite corner says that, permanently, and saying it
                  twice on one screen is the thing this rewrite removed. */}
            </ul>
          )}

          {/*
            The erasure board's own key, which names three states rather than two
            shapes.

            The agents are still drawn, and the key says they are not judged here
            rather than leaving a reader to guess why the boxes carrying most of
            the colour a moment ago are now grey. Coverage is a property of an
            asset; obsel has nothing to say about an agent's own erasure state,
            and a board that dimmed them silently would look like it did.
          */}
          {tasks.length > 0 && !showingDetails && coverage !== null && (
            <ul className={styles.legend} aria-label="What the colours mean">
              <li>
                <span
                  className={styles.keyState}
                  style={{ background: "var(--mm-green)" }}
                  aria-hidden="true"
                />{" "}
                attested absent
              </li>
              <li>
                <span
                  className={styles.keyState}
                  style={{ background: "var(--obsel-text-quiet)" }}
                  aria-hidden="true"
                />{" "}
                unattested
              </li>
              <li>
                <span
                  className={styles.keyState}
                  style={{ background: "var(--mm-red)" }}
                  aria-hidden="true"
                />{" "}
                reported still present
              </li>
              <li className={styles.keyHint}>an agent is not judged here</li>
            </ul>
          )}

          <DetailsSurface
            pinnedTask={selected.task}
            pinnedDataset={selected.dataset}
            hoverTask={hovered.task}
            hoverDataset={hovered.dataset}
            tasks={tasks}
            snapshotAt={data?.snapshot.at ?? null}
            readAt={trusted && lastReadAt !== null ? clockTime(lastReadAt) : null}
            roundTripMs={trusted ? roundTripMs : null}
            datahubUrl={data?.datahubUrl ?? null}
            /*
             * Looked up per table rather than computed for the pinned one.
             *
             * The surface shows a hovered table as readily as a pinned one, and
             * a state computed here for the pinned table would have been
             * printed under whichever table the pointer happened to be on. That
             * is not a display fault: it is obsel stating an erasure verdict
             * about the wrong asset.
             *
             * Null whenever the board is not coloured by coverage. A report read
             * for the panel's tab says nothing about a table the reader is
             * inspecting on the staleness board, and showing it there would be
             * two answers to two different questions in one panel.
             */
            coverageFor={(dataset) =>
              coverage === null
                ? null
                : (coverage.get(dataset) ?? "not reached by the lineage walk")
            }
            populated={tasks.length > 0}
            onClose={() => setSelectedUrn(null)}
            onPin={() => setSelectedUrn(hover.urn)}
            onHold={hover.hold}
            onRelease={hover.release}
          />
        </section>

        <Panel
          side={panel.side}
          width={panel.width}
          collapsed={panel.collapsed}
          onToggleCollapsed={panel.toggleCollapsed}
          onSetSide={panel.setSide}
          onSetWidth={panel.setWidth}
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          guideView={guideView}
          activity={activity}
          activityError={activityError}
          trusted={trusted}
          traceEvents={traceEvents}
          traceError={traceError}
          changes={changes}
          onReveal={reveal}
          joinView={joinView}
          mineView={mineView}
          tasks={tasks}
          totals={t}
          erasure={
            <ErasureTab
              request={erasure.request}
              report={erasure.report}
              error={erasure.error}
              missing={erasure.missing}
              everRead={erasure.everRead}
              onWatch={erasure.watch}
              graphMode={graphMode}
              onGraphMode={setGraphMode}
            />
          }
        />
      </div>

      <TourPanel
        tour={tour}
        view={guideView}
        input={guideInput}
        reveal={reveal}
        panelSide={panel.side}
      />

      {/*
        The live region. It is the only thing that announces the cascade to a
        screen reader, and it costs no pixels.
      */}
      <p className={styles.announce} role="status" aria-live="polite">
        {trusted
          ? summaryLine(t.tasks, t.finished, t.stale, lastReportAt(tasks))
          : "Not reading the agents."}
      </p>
    </main>
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
