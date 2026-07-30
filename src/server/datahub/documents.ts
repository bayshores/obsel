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

/**
 * What kind of thing one ledger record is.
 *
 * Two threads share this machinery. `request`, `challenge`, `attestation` and
 * `retraction` are the erasure evidence chain. `change` is the staleness half's
 * history: one record per coordination decision that marked or cleared finished
 * work. They are separate streams that happen to use the same append-only store,
 * and nothing reads across them.
 */
export type LedgerKind = "request" | "challenge" | "attestation" | "retraction" | "change";

export interface LedgerRecord {
  /** Stable id, unique within its kind. */
  id: string;
  kind: LedgerKind;
  /**
   * The thread this record belongs to: the erasure request for the four erasure
   * kinds, the flow slug for a `change`. Either way it is the value the record's
   * own URN was derived from, and it lands on `obsel.request` as the group key.
   */
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

/**
 * A flow id, reduced to something safe inside a URN.
 *
 * `OBSEL_FLOW_ID` reaches obsel from the environment and is not validated
 * anywhere, so it can carry the same punctuation `assetSlug` exists for. The
 * hash keeps two flow ids that differ only in punctuation apart; the readable
 * head is so a person reading the ledger in DataHub's UI can tell which board a
 * record belongs to.
 */
function flowSlug(flowId: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < flowId.length; index += 1) {
    hash ^= flowId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const readable = flowId.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 40);
  return `${readable || "flow"}_${hash.toString(16).padStart(8, "0")}`;
}

/**
 * URN for the nth change record on one board.
 *
 * Scoped to the flow, and that is not optional. `OBSEL_FLOW_ID` is how obsel
 * isolates boards from each other — the live suites rely on it so they cannot
 * reset the operator's page — and an unscoped sequence would have every server
 * on one DataHub appending into a single stream, so a test run would interleave
 * its records with the operator's history and both would read as one board's.
 */
export function changeUrn(flowId: string, sequence: number): string {
  return ledgerUrn("change", `${flowSlug(flowId)}.${sequence}`);
}

/**
 * Append one change record to a board's history.
 *
 * A writer of its own rather than a caller composing the id, so `flowSlug` stays
 * the only place that knows how a flow id becomes a URN segment. A coordinator
 * that built the id itself would be a second definition of that, and the two
 * would eventually disagree about a flow id with a hyphen in it.
 */
export async function writeChangeRecord(
  flowId: string,
  sequence: number,
  record: { at: string; body: string; assets: string[] },
): Promise<string> {
  return await writeLedgerRecord({
    id: `${flowSlug(flowId)}.${sequence}`,
    kind: "change",
    request: flowId,
    at: record.at,
    body: record.body,
    assets: record.assets,
  });
}

/**
 * The highest change sequence obsel has written on this board, cached.
 *
 * On `globalThis` for the same reason the trace buffer is: a module-level `let`
 * is re-initialised by a hot reload, and re-seeding is a run of network reads.
 * Unlike the trace, losing it costs nothing but time — the seed below recomputes
 * it from DataHub, which is the actual source of truth.
 */
const HEAD = Symbol.for("obsel.changeHead");

interface HeadCache {
  [HEAD]?: Map<string, number>;
}

function heads(): Map<string, number> {
  const store = globalThis as HeadCache;
  const existing = store[HEAD];
  // Shape-checked rather than `??=`, the same lesson `trace.ts` records: a hot
  // reload can leave an incompatible object behind, and `.get is not a function`
  // takes down every read that follows.
  if (existing instanceof Map) return existing;
  const fresh = new Map<string, number>();
  store[HEAD] = fresh;
  return fresh;
}

/**
 * Reserve the next sequence number for a change record on this board.
 *
 * Seeded once per flow per process by counting up to the first genuine 404, then
 * incremented in memory. Safe against two completions racing because every
 * caller holds the coordination lock in `completion.ts` while it writes — the
 * same single-server scope the erasure mutation lock already accepts and states.
 *
 * `SEED_CEILING` bounds the seeding walk. A board with more history than that
 * keeps recording: the walk stops looking, the head lands at the ceiling, and
 * the next write goes above it. That can leave a gap in the sequence, which the
 * reader tolerates by design — it stops at the first 404 and reports what it
 * found, so a gap costs visibility of the older records rather than correctness
 * of the newer ones. The alternative, refusing to record, would lose the record
 * entirely.
 */
const SEED_CEILING = 2_000;

export async function nextChangeSequence(flowId: string): Promise<number> {
  const cache = heads();
  const known = cache.get(flowId);
  if (known !== undefined) {
    const next = known + 1;
    cache.set(flowId, next);
    return next;
  }

  let sequence = 0;
  while (sequence < SEED_CEILING) {
    const record = await readLedgerRecord(changeUrn(flowId, sequence + 1));
    if (record === null) break;
    sequence += 1;
  }
  const next = sequence + 1;
  cache.set(flowId, next);
  return next;
}

/**
 * Forget the cached head for one board, or all of them.
 *
 * For the live suites, which write into a flow and then read it back with a
 * different process's cache in play. Not exported to any route: nothing an
 * operator can reach needs it, and clearing it only costs a re-seed.
 */
export function forgetChangeHeads(flowId?: string): void {
  if (flowId === undefined) heads().clear();
  else heads().delete(flowId);
}

/**
 * The change history of one board, oldest first.
 *
 * Counted up from one to the first genuine 404, exactly like
 * `readAttestationsFor` and for the same reason: there is no search in this path
 * because the index lags, and a history that silently omitted its newest records
 * would be worse than one that failed to load. `readLedgerRecord` uses the
 * OpenAPI v3 read, which genuinely 404s.
 *
 * `limit` bounds the walk rather than describing the board. A caller that hits
 * it has more history than it asked for, not an error, and `from` is how a
 * caller that already holds the earlier records resumes instead of re-reading
 * them: records are immutable once written, so anything below `from` cannot have
 * changed.
 */
export async function readChangesFor(
  flowId: string,
  { from = 1, limit = 200 }: { from?: number; limit?: number } = {},
): Promise<LedgerRecord[]> {
  const found: LedgerRecord[] = [];
  for (let sequence = from; sequence < from + limit; sequence += 1) {
    const record = await readLedgerRecord(changeUrn(flowId, sequence));
    if (record === null) break;
    found.push(record);
  }
  return found;
}

function jsonHeaders(): Record<string, string> {
  const base: Record<string, string> = { "Content-Type": "application/json" };
  const token = process.env.DATAHUB_GMS_TOKEN;
  if (token) base.Authorization = `Bearer ${token}`;
  return base;
}
