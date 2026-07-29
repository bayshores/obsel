/**
 * The shape of an erasure report, in a module the browser is allowed to import.
 *
 * These interfaces lived in `erasure-engine.ts`, which is marked `server-only`
 * because it holds DataHub clients. The dashboard has to describe what
 * `GET /api/erasure/[id]` hands it, and browser code must never import a
 * server-only module, so the shapes moved here and the engine re-exports them.
 *
 * **Types only.** Nothing in this file runs. The engine is still the only place
 * a report is built, and `erasure.ts` is still the only place coverage is
 * decided. Moving a type across a file boundary must not become a way of moving
 * a decision across it.
 */

import type { Coverage, summarize } from "./erasure";

export interface ErasureRequest {
  request: string;
  /** The subject key values this request covers. */
  identifiers: string[];
  /** Where the walk started: the assets known to hold the subject directly. */
  seeds: string[];
  hops: number;
  openedAt: string;
}

export interface ErasureReport {
  request: ErasureRequest;
  coverage: Coverage[];
  summary: ReturnType<typeof summarize>;
  /**
   * Assets the walk did not reach and attestations that were dropped, stated so
   * a reader can tell a covered estate from a small one.
   */
  assurance: {
    hopsWalked: number;
    assetsReached: number;
    /**
     * Ledger records this report was actually built from: the request record
     * and every attestation read back.
     *
     * Not the size of the ledger. Challenges are not counted, because a
     * challenge is a question obsel asked and no part of the answer, and
     * inflating this with them would let a report look better evidenced than it
     * is by the simple act of asking more often.
     */
    evidenceRecords: number;
    attestationsDroppedForKeys: { asset: string; attestor: string; reason: string }[];
    /**
     * What this report structurally cannot account for, carried in the report
     * itself rather than left in the documentation.
     *
     * Fixed sentences, not computed: they describe the shape of the method, not
     * this run. Required rather than optional, deliberately — a report without
     * them is a different and stronger-looking claim than the one obsel makes,
     * and the counts above are exactly the part a reader is most likely to
     * quote onward with no idea what they were measured over.
     *
     * The dashboard does not render these. The erasure tab already carries the
     * same statement in its own words, and one surface may not state the same
     * fact twice; the JSON is a separate surface with separate readers.
     */
    limits: string[];
  };
}

/**
 * What the browser actually receives, which is not an `ErasureReport`.
 *
 * `GET /api/erasure/[id]` deletes `identifiers` before answering, because a
 * report that echoed the key it was searching for would create fresh copies of
 * the subject's identifier in the act of accounting for its removal. The route
 * has done this since it was written; what was missing was a type saying so, so
 * the dashboard was free to reach for a field that is never there.
 *
 * Modelled as an omission rather than a separate interface, so a field added to
 * the request appears here too and only the deliberate removal is stated.
 */
export type PublishedErasureReport = Omit<ErasureReport, "request"> & {
  request: Omit<ErasureRequest, "identifiers">;
};
