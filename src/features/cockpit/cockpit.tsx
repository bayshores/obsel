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
import { Feed } from "./feed-panel";
import { Inspector } from "./inspector";
import { Lineage } from "./lineage";
import { LedgerRow } from "./ledger";
import { Divider, Panel, PulseDot, StatCell, StatRibbon, Wordmark } from "./mmux";
import { ENDPOINT, POLL_MS, useSwarm } from "./use-swarm";
import { clockTime, inDependencyOrder, summaryLine, totals } from "./timing";

import styles from "./cockpit.module.css";

const DASH = "—";

export function Cockpit() {
  const { data, error, lastReadAt, roundTripMs, everRead, events } = useSwarm();
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

  return (
    <main className={styles.cockpit}>
      <header className={styles.header}>
        <div className={styles.identity}>
          <Wordmark text="obsel" size={20} />
          <span className={styles.flow}>
            ▸ {data?.snapshot.flow !== undefined ? shortFlow(data.snapshot.flow) : "no swarm"}
          </span>
        </div>

        <div className={styles.lights}>
          {/* Two lights, and only two. /api/health does not exist yet, so the
              cockpit reports what the browser genuinely observed and nothing
              more — a fabricated "datahub: ok" would be a claim nobody checked. */}
          <span className={styles.light}>
            <PulseDot color={trusted ? "var(--mm-green)" : "var(--mm-red)"} />
            <span style={{ color: trusted ? "var(--mm-green)" : "var(--mm-red)" }}>
              {trusted ? "read" : "no read"}
            </span>
          </span>
          <span className={styles.reading}>
            {/* Named "board round trip", never "datahub". It contains the Next
                render, a /relationships call and N entity reads; calling it
                DataHub latency would state a number measured for another thing. */}
            board round trip {roundTripMs === null ? DASH : `${roundTripMs} ms`} · answered{" "}
            {lastReadAt === null ? DASH : clockTime(lastReadAt)}
          </span>
        </div>
      </header>

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
          title="obsel's read of the lineage graph"
          meta="GET /relationships · laid out from the edges, not from a diagram"
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
                  ? "No tasks registered yet. obsel is connected and the swarm is empty."
                  : everRead
                    ? "Not reading the swarm. Nothing below is current."
                    : "Reading the swarm from DataHub."}
              </p>
            )}
          </div>
        </Panel>

        {/* The gutter: beside the graph on a wide screen, a fixed strip beneath
            it otherwise. Both panels are fixed in their cross-axis, so the graph
            stays the only region that gives up pixels. */}
        <div className={styles.gutter}>
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
          <Feed
            events={events}
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
              ? `01 · cascade ledger — ${t.stale} of ${t.finished} finished tasks rest on something that changed`
              : "01 · cascade ledger — nothing to explain"
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
        <p className={styles.provenance}>
          marks are written to DataHub as urn:li:tag:obsel-stale + obsel.stale.causedBy · hops ·
          changeKind · reason · since · detectedMs
        </p>
      </section>

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

      <footer className={styles.footer}>
        <span>
          {trusted ? summaryLine(t.tasks, t.finished, t.stale) : "Not reading the swarm."}
        </span>
        <span>
          reading <code>{ENDPOINT}</code> every {POLL_MS} ms · obsel does not judge whether work is
          good, only whether it is still built on something true.
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
