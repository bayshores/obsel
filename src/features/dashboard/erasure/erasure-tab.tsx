"use client";

/**
 * The second question obsel answers, on screen for the first time.
 *
 * Staleness asks whether finished work is still built on current inputs. This
 * asks: when somebody exercises their right to erasure, which of the assets
 * their data reached has anybody actually accounted for? The machinery is the
 * same lineage walk; the answer is a per-asset state and, more usefully, the
 * list of assets nobody has spoken for.
 *
 * **What this panel may never say.** obsel holds no warehouse credentials and
 * never reads warehouse data, so it cannot prove absence and does not claim to.
 * "proven clean", "proof" and "complete" are forbidden, and so is a percentage.
 * Every word describing a state comes from `coverage-view.ts` and every sentence
 * explaining one comes from the kernel that decided it, so neither can be
 * reworded here into a claim obsel cannot support.
 *
 * **There is no control here that marks an asset covered**, because there is no
 * route that would accept one. A tool for declaring the work done is a tool for
 * silencing the one thing this half of the product is for.
 */

import { Fragment } from "react";

import { assuranceLine, coverageTone, stateWord, summaryLine } from "./coverage-view";
import { datasetTitle } from "../naming";
import { assetLabel, reasonSentence } from "@/src/server/coordinator/erasure";
import type { PublishedErasureReport } from "@/src/server/coordinator/erasure-report";

import styles from "./erasure.module.css";

export function ErasureTab({
  request,
  report,
  error,
  missing,
  everRead,
  onWatch,
  graphMode,
  onGraphMode,
}: {
  request: string | null;
  report: PublishedErasureReport | null;
  error: string | null;
  missing: boolean;
  everRead: boolean;
  onWatch: (request: string | null) => void;
  /** Whether the canvas is currently coloured by coverage rather than staleness. */
  graphMode: boolean;
  onGraphMode: (on: boolean) => void;
}) {
  return (
    // `data-tour`, so the tour's last step can point here. Not the accessible
    // name: that is copy and gets reworded, and a highlight that silently stops
    // appearing when somebody improves a heading is worse than no highlight.
    <div className={styles.body} data-tour="erasure">
      <div className={styles.head}>
        <span className={styles.label}>erasure request</span>
        <form
          className={styles.field}
          onSubmit={(event) => {
            event.preventDefault();
            const field = new FormData(event.currentTarget).get("request");
            onWatch(typeof field === "string" ? field : null);
          }}
        >
          <input
            className={styles.input}
            name="request"
            type="text"
            defaultValue={request ?? ""}
            placeholder="dsr-..."
            aria-label="Erasure request to read"
            spellCheck={false}
          />
          <button className={styles.button} type="submit">
            read
          </button>
        </form>

        {/*
          The toggle, disabled with its reason stated rather than hidden.

          A control that vanishes when it cannot be used teaches nothing. This
          one says what it needs, which is a report to colour the graph with.
        */}
        <label className={styles.mode}>
          <input
            type="checkbox"
            checked={graphMode && report !== null}
            disabled={report === null}
            onChange={(event) => onGraphMode(event.currentTarget.checked)}
          />
          <span>
            colour the graph by erasure coverage
            {report === null && (
              <span className={styles.modeReason}> (needs a report to be read first)</span>
            )}
          </span>
        </label>
      </div>

      {request === null && <NoRequest />}

      {request !== null && missing && (
        <p className={styles.problem} role="status">
          {error}
        </p>
      )}

      {request !== null && !missing && error !== null && (
        <p className={styles.problem} role="status">
          obsel could not read this request ({error}). Nothing is shown below, because a report held
          over from an earlier read would be describing an estate obsel is no longer watching.
        </p>
      )}

      {request !== null && report === null && error === null && !everRead && (
        <p className={styles.empty}>Reading the ledger.</p>
      )}

      {report !== null && <Report report={report} />}
    </div>
  );
}

/**
 * What to say when nobody has named a request.
 *
 * It offers a command rather than a button, and that is a statement about the
 * design rather than a shortcut. Opening a request is a mutation, obsel's
 * erasure mutations are token-gated, and the browser holds no token: a button
 * here could not work, and a button that cannot work is worse than a sentence
 * explaining why. It is the same reasoning the header's board note uses for
 * the flow id.
 */
function NoRequest() {
  return (
    <div className={styles.empty}>
      <p style={{ margin: 0 }}>
        An erasure request asks one question: starting from the tables known to hold a subject,
        which of the assets their data reached has anybody accounted for? obsel walks the lineage
        DataHub records and holds every asset it reaches as unattested until a signed attestation
        says otherwise.
      </p>
      <p style={{ margin: "var(--mm-space-sm) 0 0" }}>
        This obsel has not been given a request to read. Opening one is an operator action, because
        it writes to the ledger and the browser holds no token for that. The reply carries an id,
        and that id is what goes in the field above.
      </p>
      <code className={styles.emptyCommand}>
        {`curl -X POST localhost:3000/api/erasure \\
  -H "Authorization: Bearer $OBSEL_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"identifiers":["<subject key>"],"seeds":["<dataset urn>"]}'`}
      </code>
    </div>
  );
}

function Report({ report }: { report: PublishedErasureReport }) {
  const dropped = report.assurance.attestationsDroppedForKeys;

  return (
    <Fragment>
      <div className={styles.head} style={{ paddingTop: 0 }}>
        <p className={styles.summary}>{summaryLine(report.summary)}</p>
        <p className={styles.assurance}>{assuranceLine(report.assurance)}</p>
      </div>

      <ul className={styles.list} aria-label="Erasure coverage">
        {/*
          Key compromise first, because it is the only way coverage is lost
          without anybody touching data, and no other check on this board would
          detect it. A reader scrolling for it would be scrolling for the one
          thing that changes no field.
        */}
        {dropped.length > 0 && (
          <li>
            <p className={styles.dropped}>
              obsel dropped {dropped.length} {dropped.length === 1 ? "attestation" : "attestations"}{" "}
              because the key that signed{" "}
              {dropped.length === 1 ? "it is not trusted" : "them is not trusted"}. The assets they
              covered are reported below as though nobody had spoken for them, which is what is now
              true of them.
              <span className={styles.droppedList} style={{ display: "block" }}>
                {dropped.map((entry) => (
                  <span key={`${entry.asset}-${entry.attestor}`} style={{ display: "block" }}>
                    {datasetTitle(entry.asset)}: {entry.attestor}, {entry.reason.replace(/-/g, " ")}
                  </span>
                ))}
              </span>
            </p>
          </li>
        )}

        {report.coverage.map((entry) => {
          const tone = coverageTone(entry.state);
          return (
            <li
              key={entry.asset}
              className={styles.asset}
              style={{ borderLeftColor: tone.fill }}
              data-state={entry.state}
            >
              <span className={styles.assetName}>{datasetTitle(entry.asset)}</span>
              <span className={styles.assetState} style={{ color: tone.fill }}>
                {stateWord(entry.state)} · version {entry.version}
              </span>
              {/*
                The kernel's own sentence, verbatim. It is the same discipline a
                stale mark's reason is held to: obsel shows what it recorded
                rather than a summary of it, because the summary is where a claim
                grows.
              */}
              <p className={styles.assetWhy}>{entry.explanation}</p>
              {/*
                And every remaining reason, not just the one the explanation
                leads with. The sentence above ends "and 3 more" when there are
                more, and a reader who opens an asset to find out which three had
                nowhere to look.
              */}
              {entry.residue.length > 1 && (
                <ul className={styles.reasons}>
                  {entry.residue.slice(1).map((reason, index) => (
                    <li key={`${reason.kind}-${index}`}>
                      {reasonSentence(reason, assetLabel(entry.asset))}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </Fragment>
  );
}
