import "server-only";

/**
 * The evidence ledger, kept in DataHub `document` entities.
 *
 * obsel has no database and this does not introduce one. What it does
 * introduce is the one kind of record that genuinely has to outlive
 * coordination state: a legal evidence chain. An erasure report that cannot
 * show which attestation closed which asset, signed by whom, over which
 * version, is not evidence of anything.
 *
 * **`document`, not `dataProcessInstance`**, and the difference is not
 * cosmetic. DataHub's stock `datahub-gc` ships `dataprocess_cleanup` enabled by
 * default at ten days with a SOFT delete, and the graph index filters
 * soft-deleted entities out of relationship queries. The chain would not 404 on
 * day eleven; its edges would simply stop coming back while the aspects sat
 * intact in storage. Of the six cleanup modules that source provides, none
 * names `document`, including the soft-deleted sweep whose entity list covers
 * twenty-three types and omits it. Measured and written up in
 * `docs/environment-findings.md` §13.2.
 *
 * **Append-only comes free.** A record here is written once and never updated.
 * Retraction is a new record that refers to an earlier one, never an edit of
 * it, because a ledger you can quietly rewrite is not a ledger.
 */

import { confirmWrite, gmsUrl } from "./client";

/** What kind of thing one ledger record is. */
export type LedgerKind = "request" | "challenge" | "attestation" | "retraction";

export interface LedgerRecord {
  /** Stable id, unique within its kind. */
  id: string;
  kind: LedgerKind;
  /** The erasure request every record belongs to. */
  request: string;
  /** ISO timestamp obsel stamped when the record was written. */
  at: string;
  /**
   * The record itself, as canonical JSON.
   *
   * Stored as text rather than as structured properties because a DSSE envelope
   * is well past Lucene's 32,766-byte keyword ceiling once a rebuild declares
   * its inputs, and `StructuredPropertiesValidator` rejects a string-backed
   * value above it across GraphQL, OpenAPI and MCP alike.
   */
  body: string;
  /** Dataset URNs this record is about, for `relatedAssets`. */
  assets: string[];
}

const ACTOR = "urn:li:corpuser:datahub";

/** URN for one ledger record. Namespaced by kind so ids cannot collide across them. */
export function ledgerUrn(kind: LedgerKind, id: string): string {
  return `urn:li:document:obsel.${kind}.${id}`;
}

/**
 * Write one record, and confirm it landed before saying so.
 *
 * DataHub writes are asynchronous. `async=false` asks GMS to process inline and
 * is used, but the read-back still polls, because an accepted write is not a
 * readable one and the difference has bitten this codebase before. A ledger
 * entry reported written and not actually present is worse here than anywhere
 * else in obsel: the coverage answer would cite evidence nobody can retrieve.
 */
export async function writeLedgerRecord(record: LedgerRecord): Promise<string> {
  const urn = ledgerUrn(record.kind, record.id);
  const now = Date.parse(record.at);

  const body = [
    {
      urn,
      documentInfo: {
        value: {
          status: { state: "PUBLISHED" },
          contents: { text: record.body },
          created: { time: now, actor: ACTOR },
          lastModified: { time: now, actor: ACTOR },
          title: `obsel ${record.kind} ${record.id}`,
          source: { sourceType: "EXTERNAL" },
          // Queryable without parsing the body, which is what makes reading a
          // whole request's ledger back one filtered scan rather than N reads.
          customProperties: {
            "obsel.kind": record.kind,
            "obsel.request": record.request,
            "obsel.at": record.at,
          },
          ...(record.assets.length > 0
            ? { relatedAssets: record.assets.map((asset) => ({ asset })) }
            : {}),
        },
      },
    },
  ];

  const response = await fetch(`${gmsUrl()}/openapi/v3/entity/document?async=false`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 400);
    throw new Error(`writing ledger record ${urn} answered ${response.status}: ${detail}`);
  }

  await confirmWrite(async () => {
    const found = await readLedgerRecord(urn);
    return found === null ? null : found;
  }, 15_000);

  return urn;
}

/** One record, or null when nothing was ever written under that URN. */
export async function readLedgerRecord(urn: string): Promise<LedgerRecord | null> {
  /*
   * `GET /openapi/v3/entity/document/<urn>`, never `GET /entities/<urn>`. The
   * latter synthesises a well-formed response for any syntactically valid URN
   * including invented ones, so it would report every record as present — and
   * a ledger that claims to hold evidence it does not hold is the worst
   * possible failure of a ledger.
   */
  const response = await fetch(
    `${gmsUrl()}/openapi/v3/entity/document/${encodeURIComponent(urn)}`,
    { headers: jsonHeaders(), signal: AbortSignal.timeout(20_000) },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`reading ledger record ${urn} answered ${response.status}`);
  }

  const entity = (await response.json()) as {
    documentInfo?: {
      value?: {
        contents?: { text?: string };
        customProperties?: Record<string, string>;
        relatedAssets?: { asset: string }[];
      };
    };
  };
  const info = entity.documentInfo?.value;
  if (!info) return null;

  const props = info.customProperties ?? {};
  const [, kind, ...rest] = urn.replace("urn:li:document:obsel.", "obsel.").split(".");
  return {
    id: rest.join("."),
    kind: (props["obsel.kind"] as LedgerKind) ?? (kind as LedgerKind),
    request: props["obsel.request"] ?? "",
    at: props["obsel.at"] ?? "",
    body: info.contents?.text ?? "",
    assets: (info.relatedAssets ?? []).map((entry) => entry.asset),
  };
}

/**
 * Every attestation recorded for one asset on one request, in order.
 *
 * **No search index anywhere in this path.** The first version of this read the
 * ledger back over GraphQL search, and it did not work: a record written a
 * moment earlier was not yet indexed, so a request could not find its own
 * opening record and every read after it 404ed. That is the failure
 * `environment-findings.md` §7 describes, arriving in the ledger rather than in
 * lineage — and it is worse here, because a coverage report that cannot see an
 * attestation reports the asset as unattested, which reads as a real finding.
 *
 * So nothing is searched for. Ledger URNs are derived from values the caller
 * already holds, and records are enumerated by counting up from one until a
 * genuine 404. Sequence numbers keep the ledger append-only: a second
 * attestation about the same asset is a new record beside the first, never a
 * write over it.
 */
export async function readAttestationsFor(
  request: string,
  asset: string,
  limit = 25,
): Promise<LedgerRecord[]> {
  const found: LedgerRecord[] = [];
  for (let sequence = 1; sequence <= limit; sequence += 1) {
    const record = await readLedgerRecord(attestationUrn(request, asset, sequence));
    if (record === null) break;
    found.push(record);
  }
  return found;
}

/**
 * A stable, collision-free slug for a URN inside another URN.
 *
 * A dataset URN carries commas, colons and parentheses, all of which are
 * structural in a DataHub URN, so it cannot be embedded literally. The hash is
 * what keeps two assets whose names differ only in punctuation from landing on
 * one ledger record; the readable tail is there so a human reading the ledger in
 * DataHub's UI can tell which table a record is about without decoding anything.
 */
function assetSlug(asset: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < asset.length; index += 1) {
    hash ^= asset.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const readable = asset
    .split(",")[1]
    ?.split(".")
    .slice(-2)
    .join("_")
    .replace(/[^a-zA-Z0-9_]/g, "");
  return `${readable ?? "asset"}_${hash.toString(16).padStart(8, "0")}`;
}

export function attestationUrn(request: string, asset: string, sequence: number): string {
  return ledgerUrn("attestation", `${request}.${assetSlug(asset)}.${sequence}`);
}

function jsonHeaders(): Record<string, string> {
  const base: Record<string, string> = { "Content-Type": "application/json" };
  const token = process.env.DATAHUB_GMS_TOKEN;
  if (token) base.Authorization = `Bearer ${token}`;
  return base;
}
