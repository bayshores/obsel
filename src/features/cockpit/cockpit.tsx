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
import { LedgerRow } from "./ledger";
import { Divider, Panel, PulseDot, StatCell, StatRibbon, Wordmark } from "./mmux";
import { TracePanel } from "./trace-panel";
import { useActivity } from "./use-activity";
import { useTrace } from "./use-trace";
import { POLL_MS, useSwarm } from "./use-swarm";
import { clockTime, inDependencyOrder, summaryLine, totals } from "./timing";

import styles from "./cockpit.module.css";

const DASH = "—";

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
  const stat = (value: string): string => (trusted ? value : DASH);

  const guideView = guide({
    trusted,
    everRead,
    tasks,
    snapshotAt: data?.snapshot.at ?? null,
    activity,
  });

  return (
    <main className={styles.cockpit}>
      <header className={styles.header}>
        <div>
          <div className={styles.identity}>
            <Wordmark text="obsel" size={20} />
            <span className={styles.flow}>
              ▸ {data?.snapshot.flow !== undefined ? shortFlow(data.snapshot.flow) : "no swarm"}
            </span>
          </div>
          <p className={styles.tagline}>
            flags finished agent work when what it was built on changes
          </p>
        </div>

        <div className={styles.lights}>
          {/* Two lights, and only two. /api/health does not exist yet, so the
              cockpit reports what the browser genuinely observed and nothing
              more — a fabricated "datahub: ok" would be a claim nobody checked. */}
          <span className={styles.light}>
            <PulseDot color={trusted ? "var(--mm-green)" : "var(--mm-red)"} />
            <span style={{ color: trusted ? "var(--mm-green)" : "var(--mm-red)" }}>
              {trusted ? "connected" : "can't reach obsel"}
            </span>
          </span>
          {/* The read latency and the answered-at clock used to sit here as
              "board round trip 51 ms · answered 17:22:16", which is the first
              thing a newcomer's eye lands on and means nothing to them. Both are
              still reported — in the Details panel, labelled — and what stays
              here is the one fact this line existed to carry: whether what is on
              screen is current. */}
          <span className={styles.reading}>
            {trusted
              ? "reading obsel once a second"
              : everRead
                ? "showing the last good read"
                : "connecting"}
          </span>
        </div>
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
          meta="each box is an agent; each panel beside it is a table it reads or writes"
          padded={false}
          // The one region that takes the leftover height. 220px is the floor at
          // which the graph is still readable in a recording.
          style={{ flex: "1 1 auto", minHeight: 220, display: "flex", flexDirection: "column" }}
          bodyStyle={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }}
        >
          <Backdrop alert={t.stale > 0} />
          <div className={styles.grid} />
          <div className={styles.graphBody}>
            {tasks.length > 0 ? (
              <Lineage tasks={tasks} />
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
        Above the ledger, not below it, and that ordering is load-bearing.

        The ledger is both the tallest region and the only one whose height grows
        with the swarm — four rows at 96px in the cascaded state — so it is
        always what pushes the column past the viewport. With the ribbon beneath
        it, the first thing to go off the bottom of a 990px recording frame was
        the measured detection time: the one number the whole demo is trying to
        establish, hidden by the rows it is the summary of.

        Put first, the summary and its measured figures are above the fold in
        every state, and any overflow comes out of per-row detail that the
        viewer can scroll to — which is the right thing to lose, and the reason
        this is a structural fix rather than a pass of pixel trimming.
      */}
      <StatRibbon label="Swarm totals">
        {[
          <StatCell key="tasks" label="tasks" value={stat(String(t.tasks))} />,
          <StatCell key="finished" label="finished" value={stat(String(t.finished))} />,
          <StatCell
            key="stale"
            label="out of date"
            value={stat(String(t.stale))}
            accent={trusted && t.stale > 0}
          />,
          <StatCell
            key="reach"
            label="deepest reach"
            value={t.deepestReach === null ? stat(DASH) : stat(String(t.deepestReach))}
            unit={
              trusted && t.deepestReach !== null
                ? t.deepestReach === 1
                  ? "hop"
                  : "hops"
                : undefined
            }
          />,
          // "not measured" sits in the unit slot rather than the value slot.
          // It is a sentence, not a reading, and at the value's size it wrapped
          // across two lines and read like a number that had gone wrong.
          <StatCell
            key="detection"
            label="detection time"
            value={trusted && t.timing !== null ? String(t.timing.ms) : DASH}
            unit={trusted ? (t.timing !== null ? "ms" : "not measured") : undefined}
            accent={trusted && t.timing !== null}
            glow={trusted && t.timing !== null}
          />,
        ]}
      </StatRibbon>

      <section className={styles.ledger} aria-label="Cascade ledger">
        {/*
          The whole point of the demo — three tasks flipping to stale — changed
          four places in the DOM and was announced to nobody. This is the one
          live region: `summaryLine` states the counts in a sentence and only
          changes when the counts do, so it is not chatter on every poll.
        */}
        <p className={styles.announce} role="status" aria-live="polite">
          {trusted ? summaryLine(t.tasks, t.finished, t.stale) : "Not reading the swarm."}
        </p>
        <Divider
          label={
            t.stale > 0
              ? `each agent — ${t.stale} of ${t.finished} finished agents are built on something that changed`
              : "each agent — what it is for, and whether its work still holds"
          }
        />
        <ul className={styles.rows}>
          {tasks.map((task) => (
            <LedgerRow
              key={task.urn}
              task={task}
              // The snapshot's own timestamp, so an in-flight elapsed is
              // measured entirely on obsel's clock. It advances once per poll,
              // which is what makes the figure tick without a second timer —
              // and it freezes when reads fail, so a broken connection stops
              // the count rather than letting it run on unattended.
              snapshotAt={data?.snapshot.at ?? null}
              selected={task.urn === selectedUrn}
              onSelect={() => setSelectedUrn(task.urn === selectedUrn ? null : task.urn)}
            />
          ))}
        </ul>
      </section>

      {/* One line, not two. The summary that used to lead this row is the same
          sentence the ledger's live region already announces and the divider
          above already states in numbers — three copies of one fact, on a screen
          whose problem was density. What is left is the framing a newcomer
          cannot get from anywhere else on the board. */}
      <footer className={styles.footer}>
        <span>
          obsel does not judge whether work is good, only whether it is still built on something
          true.
        </span>
        <span>
          {trusted
            ? `re-read every ${POLL_MS / 1000}s${roundTripMs === null ? "" : ` · last read took ${roundTripMs} ms`}${lastReadAt === null ? "" : `, answered ${clockTime(lastReadAt)}`}`
            : "not reading — every measured number above is withheld"}
        </span>
      </footer>
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
