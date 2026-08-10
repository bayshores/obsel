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
import { DataHubError } from "./errors";

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

  /*
   * Append-only, enforced at the write for attestations.
   *
   * The OpenAPI v3 write below is an upsert: posting a URN that already holds a
   * record replaces its `documentInfo` and the earlier record is gone. Every
   * other guard in this path is on the caller's side of the boundary, so a
   * caller that computed the wrong sequence number destroyed evidence and was
   * told the write succeeded. Reading first turns that into a refusal, which is
   * the direction this failure has to fall: a refused attestation is resubmitted,
   * an overwritten one is not recoverable.
   *
   * Attestations only. `change` records are written from a cached head that
   * tolerates gaps by design (see `nextChangeSequence`), and `challenge` and
   * `request` records are keyed by values that are unique on their own.
   */
  if (record.kind === "attestation") {
    const held = await readLedgerRecord(urn);
    if (held !== null) {
      throw new DataHubError(
        `ledger record ${urn} already exists; the evidence ledger is append-only`,
        409,
      );
    }
  }

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
    throw new DataHubError(
      `writing ledger record ${urn} answered ${response.status}: ${detail}`,
      response.status,
    );
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
    throw new DataHubError(
      `reading ledger record ${urn} answered ${response.status}`,
      response.status,
    );
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
 *
 * **There is no record ceiling here, and there was.** The walk used to stop at
 * twenty-five. Two things then went wrong at once on an asset with that many
 * records, and neither announced itself: `submitAttestation` derives the next
 * sequence from this read, so a capped read handed back a sequence that was
 * already taken; and the spent-nonce check reads this list, so a nonce consumed
 * by a record above the cap read as unconsumed. Twenty-five re-attestations on
 * one asset is ordinary volume for an estate under compaction. A ceiling on a
 * count-to-404 walk is a ceiling on what the report can see, so the walk runs
 * until the ledger genuinely ends.
 */
export async function readAttestationsFor(request: string, asset: string): Promise<LedgerRecord[]> {
  return await readSequence((sequence) =>
    readLedgerRecord(attestationUrn(request, asset, sequence)),
  );
}

/**
 * Read a derived-URN sequence from one upward, stopping at the first absence.
 *
 * Pure sequence logic over whatever reader it is handed, so the rule it holds —
 * every present record from one to the end, and nothing invented past the end —
 * is testable without a network. The walk terminates because each further step
 * requires the step before it to have found a record, and the ledger is finite.
 */
export async function readSequence<T>(read: (sequence: number) => Promise<T | null>): Promise<T[]> {
  const found: T[] = [];
  for (let sequence = 1; ; sequence += 1) {
    const record = await read(sequence);
    if (record === null) return found;
    found.push(record);
  }
}

/**
 * The sequence number the next attestation about this asset lands on.
 *
 * Counted to the first genuine 404 rather than taken from a bounded read, and
 * kept beside the reader so the two cannot disagree about where the ledger ends.
 * `writeLedgerRecord` refuses an occupied attestation URN, so a wrong answer
 * here is a refusal rather than an overwrite.
 */
export async function nextAttestationSequence(request: string, asset: string): Promise<number> {
  let sequence = 1;
  while ((await readLedgerRecord(attestationUrn(request, asset, sequence))) !== null) {
    sequence += 1;
  }
  return sequence;
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
  try {
    const urn = await writeLedgerRecord({
      id: `${flowSlug(flowId)}.${sequence}`,
      kind: "change",
      request: flowId,
      at: record.at,
      body: record.body,
      assets: record.assets,
    });
    noteChangeWritten(flowId, sequence);
    return urn;
  } catch (error) {
    /*
     * A failed write may have landed anyway: `writeLedgerRecord` also throws when
     * the record was accepted and the read-back did not confirm it inside 15 s.
     * Neither keeping nor advancing the cached head is safe on that evidence, so
     * the cache is dropped and the next reservation walks DataHub, which is the
     * only thing that knows whether the record is there.
     */
    forgetChangeHeads(flowId);
    throw error;
  }
}

/**
 * The highest change sequence obsel has written on this board, cached.
 *
 * On `globalThis` for the same reason the trace buffer is: a module-level `let`
 * is re-initialized by a hot reload, and re-seeding is a run of network reads.
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
 * One past the head, which `changeHeadFor` seeds once per flow per process by
 * counting up to the first genuine 404 and holds in memory after that. Safe
 * against two completions racing because every caller holds the coordination
 * lock in `completion.ts` while it writes — the
 * same single-server scope the erasure mutation lock already accepts and states.
 *
 * **Reserving does not advance the cached head.** The head moves in
 * `noteChangeWritten`, once the record is confirmed present, and that ordering is
 * the whole point: `writeChangeRecord`'s only caller swallows a failed write, so
 * a head advanced first would leave a sequence reserved and never written. This
 * sequence is dense, and every reader counts up to the first genuine 404, so an
 * empty position does not cost the record at it — it hides every record above it,
 * for good. A reservation reused after a failed write costs at most one
 * unconfirmed record overwritten by the next one.
 *
 * `SEED_CEILING` bounds the seeding walk. A board with more history than that
 * keeps recording: the walk stops looking, the head lands at the ceiling, and the
 * next write goes above it, leaving position 2001 empty. Every record from 2002
 * up is then unreachable to the readers below. That is accepted rather than
 * repaired here, because the alternative at the ceiling is refusing to record at
 * all, and the ceiling sits far above any board obsel has run.
 */
const SEED_CEILING = 2_000;

export async function nextChangeSequence(flowId: string): Promise<number> {
  return (await changeHeadFor(flowId)) + 1;
}

/**
 * Move the cached head to a sequence whose record is confirmed written.
 *
 * The commit half of `nextChangeSequence`'s reservation, called by
 * `writeChangeRecord` and by nothing else in obsel: no route and no tool reaches
 * it, because a caller that could move the head without writing a record is the
 * gap this ordering exists to prevent. Exported so the sequence bookkeeping can
 * be exercised without DataHub, in `tests/change-sequence.test.ts`.
 *
 * Takes the higher of the two, so a write at a sequence below the head — a retry
 * refilling a position, say — cannot walk the head backwards.
 */
export function noteChangeWritten(flowId: string, sequence: number): void {
  const cache = heads();
  const known = cache.get(flowId);
  cache.set(flowId, known === undefined ? sequence : Math.max(known, sequence));
}

/**
 * The highest sequence this board has written, without reserving anything.
 *
 * The one place the seeding walk lives. `nextChangeSequence` reserves the
 * position after this and writers commit through `noteChangeWritten`, so a reader
 * asking where the history ends changes nothing.
 *
 * Zero means the board has never recorded a decision.
 */
export async function changeHeadFor(flowId: string): Promise<number> {
  const cache = heads();
  // The cache holds the highest sequence confirmed written, which is the head.
  // Seeding it with anything else makes the next writer skip a number, and a
  // gap stops the walk permanently: every record above it becomes unreachable.
  const known = cache.get(flowId);
  if (known !== undefined) return known;

  let sequence = 0;
  while (sequence < SEED_CEILING) {
    const record = await readLedgerRecord(changeUrn(flowId, sequence + 1));
    if (record === null) break;
    sequence += 1;
  }
  cache.set(flowId, sequence);
  return sequence;
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
