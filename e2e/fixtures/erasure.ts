/**
 * Canned `GET /api/erasure/{id}` bodies for the browser suite.
 *
 * Typed as the published report shape, so a drift between what the route returns
 * and what the tab reads fails `pnpm typecheck` before any browser starts.
 *
 * These are invented values. Nothing here may be screenshotted into the
 * submission or quoted as a measurement: a real report is derived from the
 * ledger on every read, and a fixture that looks like one is exactly the thing
 * obsel must not put on screen.
 *
 * Two shapes, and the second is the one that matters. `dayOne` is what a request
 * looks like the moment it is opened, when nobody has attested to anything and
 * every asset is unattested, because that list is the report's most valuable
 * output on its first day. `mixed` exercises the states and residue kinds a
 * report can hold at once, including an attestation dropped for a key that is no
 * longer trusted, which is the only way coverage is lost without anybody
 * touching data.
 */

import type { PublishedErasureReport } from "@/src/server/coordinator/erasure-report";

const PLATFORM = "urn:li:dataPlatform:obsel";

function dataset(name: string): string {
  return `urn:li:dataset:(${PLATFORM},obsel_demo.${name},PROD)`;
}

/** The seeds and hop count every fixture below shares. */
const REQUEST = {
  request: "dsr-2f9c",
  seeds: [dataset("raw_orders")],
  hops: 3,
  openedAt: "2026-07-24T09:14:00.000Z",
};

/** Nobody has attested to anything yet. Every asset is unattested. */
export function dayOne(): PublishedErasureReport {
  const assets = ["raw_orders", "clean_orders", "daily_revenue"];
  return {
    request: REQUEST,
    coverage: assets.map((name) => ({
      request: REQUEST.request,
      asset: dataset(name),
      version: "unknown",
      state: "UNPROVEN" as const,
      residue: [{ kind: "no-attestation" as const }],
      explanation: `${name.replace(/_/g, " ")} at version unknown is unattested: nobody has attested to it`,
    })),
    summary: { total: 3, attested: 0, unproven: 3, contradicted: 0 },
    assurance: {
      hopsWalked: 3,
      assetsReached: 3,
      evidenceRecords: 1,
      attestationsDroppedForKeys: [],
    },
  };
}

/**
 * Every state at once, plus a dropped key.
 *
 * Six assets: two attested, three unattested for three different reasons, and
 * one an attestor reports the subject is still present in.
 */
export function mixed(): PublishedErasureReport {
  return {
    request: REQUEST,
    coverage: [
      {
        request: REQUEST.request,
        asset: dataset("raw_orders"),
        version: "v7",
        state: "ATTESTED",
        residue: [],
        explanation: "raw orders is attested absent over version v7 by warehouse-team",
      },
      {
        request: REQUEST.request,
        asset: dataset("clean_orders"),
        version: "v4",
        state: "ATTESTED",
        residue: [],
        explanation: "clean orders is attested absent over version v4 by warehouse-team",
      },
      {
        request: REQUEST.request,
        asset: dataset("daily_revenue"),
        version: "v9",
        state: "UNPROVEN",
        residue: [{ kind: "not-total", materialization: "merge" }, { kind: "not-sole-producer" }],
        explanation:
          "daily revenue at version v9 is unattested: the run that wrote it was a merge, so it left the rest of the table standing, and 1 more",
      },
      {
        request: REQUEST.request,
        asset: dataset("revenue_report"),
        version: "v2",
        state: "UNPROVEN",
        residue: [{ kind: "attested-other-version", attestedVersion: "v1" }],
        explanation:
          "revenue report at version v2 is unattested: the attestation covers version v1, and revenue report has been written since",
      },
      {
        request: REQUEST.request,
        asset: dataset("pipeline_docs"),
        version: "unknown",
        state: "UNPROVEN",
        residue: [{ kind: "no-attestation" }],
        explanation: "pipeline docs at version unknown is unattested: nobody has attested to it",
      },
      {
        request: REQUEST.request,
        asset: dataset("order_archive"),
        version: "v3",
        state: "CONTRADICTED",
        residue: [],
        explanation:
          "archive-team reports the subject is still present in order archive at version v3",
      },
    ],
    summary: { total: 6, attested: 2, unproven: 3, contradicted: 1 },
    assurance: {
      hopsWalked: 3,
      assetsReached: 6,
      evidenceRecords: 9,
      attestationsDroppedForKeys: [
        {
          asset: dataset("pipeline_docs"),
          attestor: "docs-bot",
          reason: "key-compromised",
        },
      ],
    },
  };
}
