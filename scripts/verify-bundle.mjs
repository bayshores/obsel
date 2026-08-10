/**
 * The evidence check itself: one bundle in, a verdict and its printed lines out.
 *
 * Two callers run this exact code and nothing else runs it:
 *
 * - `scripts/verify-erasure-evidence.mjs`, the CLI a judge runs with Node and
 *   nothing else. It owns argv, reading the file, and the exit codes.
 * - `site/`, the hosted page, which bundles this module for the browser.
 *
 * **The split is the point.** This file touches no filesystem and no `process`,
 * so the browser build resolves every import it has for real. There is no stub
 * standing in for anything: the page bundles this module, `attestation.ts` and
 * `erasure.ts` as they are. Its one substitution is the Ed25519 and SHA-256
 * arithmetic, because `verifyAttestation` is synchronous by design and
 * WebCrypto's API is not; `site/node-crypto.js` carries that, and
 * `tests/site-verify.test.ts` holds the two to the same answers over real
 * signatures and real tampered ones.
 *
 * **No second implementation of anything.** Node 24 strips types on import, so
 * `attestation.ts` and `erasure.ts` are imported and run directly — the same
 * signature check and the same coverage kernel the server runs. A verifier that
 * reimplemented either would eventually disagree with the server about a space
 * in a canonical encoding, and would then be checking something other than what
 * was signed.
 *
 * What it therefore does check, that the server does not: obsel stamps
 * `signatureVerified: true` on every ledger record it reads and never redoes the
 * arithmetic (`erasure-engine.ts`, `attestationOf`). Every signature in a bundle
 * is verified here from the bytes.
 *
 * ## Why `now` is each record\'s own `at`, and not the clock
 *
 * `verifyAttestation` takes `now` because freshness is part of what it decides:
 * a challenge lives fifteen minutes, and a record answering an expired one is
 * refused. Passing the wall clock here would refuse every bundle older than
 * fifteen minutes, including every honest one, which is to say all of them — a
 * bundle is read days or months after it was captured, by definition.
 *
 * So each record is verified at `now = record.at`, and the question that answers
 * is the question actually worth asking: was this record signed inside the window
 * obsel opened for it? `at` is inside the signed payload, so it cannot be moved
 * without breaking the signature, and the window is `issuedAt`..`expiresAt` on a
 * challenge obsel minted. This module adds the lower bound explicitly, because
 * `verifyAttestation` only checks the upper one — its caller is a live server,
 * where a record predating the challenge is impossible.
 *
 * **What that cannot establish**: `at` is a timestamp the attestor wrote. This
 * check says the record is consistent with the challenge obsel issued; it does
 * not establish what time it really was when somebody signed. Nothing offline
 * can.
 */

/*
 * Literal specifiers rather than `new URL(...)` construction, for one reason:
 * the site build has to follow these imports statically to bundle the same
 * files, and a computed URL is opaque to it. Node resolves a relative dynamic
 * import against this module either way, so the CLI behavior is unchanged.
 */
const { createHash } = await import("node:crypto");
const { verifyAttestation, invalidatedByKeys } =
  await import("../src/server/coordinator/attestation.ts");
const { ASSURANCE_LIMITS, assetLabel, coverageFor, summarize } =
  await import("../src/server/coordinator/erasure.ts");

export { ASSURANCE_LIMITS };

/**
 * Everything this check reports goes through one sink, findings included, so
 * the CLI's one redirect captures the whole verdict — and so the hosted page
 * can show the identical lines rather than a retelling of them.
 */
const collected = [];
let echo = true;
function say(line = "") {
  collected.push(line);
  if (echo) console.log(line);
}

/**
 * The whole check, over a parsed bundle.
 *
 * Returns the verdict and every line the CLI would have printed, in order.
 * `print` echoes them to the console as they are produced, which is what the
 * CLI wants and a page does not.
 */
export async function verifyBundle(bundle, { print = false, source = "" } = {}) {
  collected.length = 0;
  echo = print;

  say("obsel offline evidence verifier");
  if (source) say(`bundle    ${source}`);
  say(`captured  ${bundle.capturedAt}, format ${bundle.formatVersion}`);
  say(
    `request   ${bundle.request.request}, opened ${bundle.request.openedAt}, ` +
      `${bundle.request.hops} hops from ${bundle.request.seeds.length} seed asset(s)`,
  );
  say(
    `evidence  ${bundle.attestations.length} attestation(s), ${bundle.challenges.length} ` +
      `challenge(s), ${bundle.keys.length} registered key(s), ` +
      `${bundle.reachable.length} assets reached`,
  );
  say();

  const checked = checkRecords(bundle);
  const dropped = invalidatedByKeys(checked.accepted, bundle.keys);
  reportDropped(dropped);

  const recomputed = recompute(bundle, checked.accepted, dropped);
  const disagreements = compare(bundle, recomputed);

  say();
  say("what this checks, and what it cannot");
  say(
    "  every signature above was verified here from the bytes in this file, against the " +
      "registry in this file. obsel does not redo that on a read.",
  );
  for (const limit of ASSURANCE_LIMITS) say(`  ${limit}`);

  say();
  const ok = checked.failed === 0 && disagreements === 0;
  if (!ok) {
    /*
     * "disagreement(s)", not "asset(s)": one of them can be the summary counts,
     * which are not an asset, and a sentence that miscounts what it found is the
     * same class of error as not checking.
     */
    say(
      `verdict   this bundle does not check out: ${checked.failed} record(s) failed ` +
        `verification, ${disagreements} disagreement(s) with the recorded report.`,
    );
  } else {
    say("verdict   every record verified, and the recomputed answer matches the recorded one.");
  }

  return {
    ok,
    failedRecords: checked.failed,
    disagreements,
    droppedForKeys: dropped.length,
    recomputedSummary: recomputed.summary,
    coverage: recomputed.coverage,
    lines: [...collected],
  };
}

/**
 * Enough of the bundle's shape to tell a bundle from any other JSON file, before
 * a single field of it is read. Same reasoning as `describeShapeProblem` in
 * `attestation.ts`: reaching into a field that is not there gives a stack trace
 * rather than an answer, and a stack trace tells the reader nothing about what
 * was wrong with their file.
 */
export function shapeProblem(bundle) {
  if (typeof bundle !== "object" || bundle === null || Array.isArray(bundle)) {
    return "the file is not a JSON object";
  }
  if (bundle.formatVersion !== 1) {
    return `formatVersion is ${JSON.stringify(bundle.formatVersion)}, and this script reads 1`;
  }
  for (const field of ["reachable", "keys", "challenges", "attestations"]) {
    if (!Array.isArray(bundle[field])) return `${field} is missing or is not an array`;
  }
  for (const field of ["request", "upstreamOf", "report"]) {
    if (typeof bundle[field] !== "object" || bundle[field] === null) {
      return `${field} is missing or is not an object`;
    }
  }
  if (!Array.isArray(bundle.request.identifierDigests)) {
    return "request.identifierDigests is missing or is not an array";
  }
  /*
   * `request.seeds` is counted in the header, ahead of every record, so a bundle
   * without it cannot be reported on record by record: the count throws before
   * the first one is read. It belongs here rather than beside the records for
   * that reason, and the caller's exit 2 is the honest code for it.
   */
  if (!Array.isArray(bundle.request.seeds)) {
    return "request.seeds is missing or is not an array";
  }
  if (!Array.isArray(bundle.report.coverage) || typeof bundle.report.summary !== "object") {
    return "report.coverage or report.summary is missing";
  }
  return null;
}

/**
 * Verify every record, in the ledger's own order, and print one line each.
 *
 * Order matters for exactly one check. A challenge is single use, and a replay is
 * only detectable as a replay if the record that used the nonce first is seen
 * first, so records are walked asset by asset and then by sequence, which is the
 * order they were appended in. Every nonce already spent is marked `consumed`
 * before the next record is verified, and `verifyAttestation` refuses it.
 */
function checkRecords(bundle) {
  const accepted = [];
  const spent = new Set();
  let failed = 0;

  /*
   * Every entry is examined before any field of it is read.
   *
   * `shapeProblem` above says the attestations list is a list; it says nothing
   * about what is in it, and reaching into an entry that is not a record threw
   * out of the whole check. The CLI ended mid-run with a stack trace and no
   * verdict, and the page's render threw on its first line, leaving whatever
   * verdict was already on screen standing beside a bundle nobody verified. A
   * refusal naming the entry is the answer in both places.
   *
   * Malformed entries are reported after the sound ones, in the order the ledger
   * lists them: they take no part in the replay check below, which is the only
   * thing the sort order exists for.
   */
  const malformed = [];
  const sound = [];
  bundle.attestations.forEach((record, index) => {
    const problem = recordShapeProblem(record);
    if (problem) malformed.push({ index, problem });
    else sound.push(record);
  });

  say("attestations");
  for (const record of [...sound].sort(order)) {
    /*
     * The URN, not the readable label. Two rows reading `customers` are ordinary
     * on a real estate — a warehouse table and the dbt model built from it share
     * a name — and a finding that cannot be pinned to one of them is not a
     * finding. The label does its job inside the kernel's sentences, where the
     * URN is on the line above.
     */
    const name = `${record.asset} #${record.sequence}`;
    const failures = recordedFieldProblems(record);

    const challenges = bundle.challenges.map((challenge) =>
      spent.has(challenge.nonce) ? { ...challenge, consumed: true } : challenge,
    );
    const result = verifyAttestation(record.body.envelope, {
      keys: bundle.keys,
      challenges,
      now: record.at,
    });
    if (!result.ok) failures.push(...result.failures.map(describeFailure));
    else {
      failures.push(...beforeItsChallenge(record, bundle.challenges));
      spent.add(record.body.nonce);
    }

    if (failures.length === 0) {
      accepted.push({ attestation: result.attestation, keyId: result.keyId });
      say(`  ok      ${name}`);
      say(
        `            ${result.attestation.attestor} signed for version ` +
          `${result.attestation.version} at ${record.at}`,
      );
      continue;
    }

    failed += 1;
    say(`  FAILED  ${name}, dated ${record.at}`);
    for (const failure of failures) say(`            ${failure}`);
  }

  for (const entry of malformed) {
    failed += 1;
    say(`  FAILED  attestations[${entry.index}]`);
    say(`            malformed-record: ${entry.problem}`);
  }

  if (bundle.attestations.length === 0) say("  none. every asset below is unattested.");
  return { accepted, failed };
}

/**
 * The fields this file reads off a ledger entry before `verifyAttestation` is
 * asked anything, checked against what actually arrived.
 *
 * Only what is read here, and no more. The payload's own shape is
 * `attestation.ts`'s `describeShapeProblem` and stays there, so the two do not
 * end up as two opinions about one record.
 */
function recordShapeProblem(record) {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return "the entry is not an object";
  }
  if (typeof record.asset !== "string" || record.asset === "") return "the entry names no asset";
  if (typeof record.sequence !== "number") return "the entry carries no sequence number";
  if (typeof record.at !== "string" || record.at === "") return "the entry carries no timestamp";

  const body = record.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "the record carries no body";
  }
  const envelope = body.envelope;
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    return "the record carries no envelope";
  }
  // `Buffer.from(x, "base64")` throws on anything that is not a string, and it
  // is reached both here and inside `verifyAttestation`.
  if (typeof envelope.payload !== "string") return "the envelope's payload is not a string";
  return null;
}

/**
 * Ledger order: by asset, and then by the sequence within an asset.
 *
 * Compared by code unit rather than with `localeCompare`, because the same code
 * runs in the CLI and in a browser whose locale obsel does not choose. A
 * locale-aware comparison puts 'å' beside 'a' for one reader and after 'z' for
 * another, so two readers of one bundle would see the same lines in different
 * orders and neither could reproduce the other's output.
 */
function order(a, b) {
  if (a.asset !== b.asset) return a.asset < b.asset ? -1 : 1;
  return a.sequence - b.sequence;
}

/**
 * The two fields the ledger records beside the envelope, checked against the
 * envelope itself.
 *
 * `keyId` and `nonce` are stored next to the DSSE envelope so a reader does not
 * have to decode base64 to know what a record is about, and a copy is a thing
 * that can disagree with its original. `verifyAttestation` reads neither — it
 * takes the keyid off the signature and the nonce out of the signed payload — so
 * a bundle whose copies were edited would verify while describing itself wrongly,
 * and the description is what a person reads.
 */
function recordedFieldProblems(record) {
  // Called only for records `recordShapeProblem` passed, so the body, the
  // envelope and a string payload are all there to be read.
  const problems = [];
  const envelope = record.body.envelope;

  const signed = envelope.signatures?.[0]?.keyid;
  if (signed !== record.body.keyId) {
    problems.push(
      `recorded-keyid-mismatch: the record says ${record.body.keyId}, ` +
        `the signature says ${signed}`,
    );
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(envelope.payload ?? "", "base64").toString("utf8"));
  } catch {
    return [...problems, "malformed-envelope: the payload is not base64 JSON"];
  }
  if (payload?.nonce !== record.body.nonce) {
    problems.push(
      `recorded-nonce-mismatch: the record says ${record.body.nonce}, ` +
        `the signed payload says ${payload?.nonce}`,
    );
  }
  if (payload?.asset !== record.asset) {
    problems.push(
      `recorded-asset-mismatch: the ledger filed this under ${record.asset}, ` +
        `the signed payload answers for ${payload?.asset}`,
    );
  }
  return problems;
}

/**
 * The lower half of the challenge window, which `verifyAttestation` does not
 * check.
 *
 * It checks that `now` has not passed `expiresAt`, and with `now` set to the
 * record's own `at` that is the upper bound: the record was signed before the
 * challenge died. The other end has no meaning on a live server, where a record
 * cannot arrive before the nonce it quotes was minted, and every meaning in a
 * file: a record dated before its own challenge was issued is a record whose
 * timestamp was moved.
 *
 * Moved timestamps are not cosmetic. `at` is what `keyUsable` compares against a
 * key's `notBefore` and against the date it was retired, so a record backdated
 * far enough is a retired key's signature standing again. The nonce binding does
 * not catch that on its own: the attestor genuinely held a fresh nonce, and only
 * lied about when it signed.
 *
 * The cost is a record signed on a machine whose clock is behind obsel's, which
 * fails here by however many milliseconds the two disagree. No tolerance is
 * allowed for it, because a tolerance is a number nobody can justify; both
 * timestamps are printed instead, so a reader can see at once whether they are
 * looking at a skewed clock or a moved date.
 */
function beforeItsChallenge(record, challenges) {
  const challenge = challenges.find((entry) => entry.nonce === record.body.nonce);
  if (!challenge) return [];
  if (Date.parse(record.at) >= Date.parse(challenge.issuedAt)) return [];
  return [
    `at-before-challenge-issued: the record is dated ${record.at}, and the challenge ` +
      `it answers was issued at ${challenge.issuedAt}`,
  ];
}

function describeFailure(failure) {
  const detail = Object.entries(failure)
    .filter(([field]) => field !== "kind")
    .map(([field, value]) => `${field}=${value}`)
    .join(", ");
  return detail ? `${failure.kind}: ${detail}` : failure.kind;
}

function reportDropped(dropped) {
  if (dropped.length === 0) return;
  say();
  say("attestations dropped for their key, though the signature over the bytes stands");
  for (const entry of dropped) {
    say(
      `  ${assetLabel(entry.attestation.asset)}: ${entry.attestation.attestor}, ` +
        `${describeFailure(entry.reason)}`,
    );
  }
}

/**
 * Coverage, from the evidence in this file and nothing else.
 *
 * `bundle.report` is never read here. It is the answer being checked, and a
 * verifier that let the answer inform the working would agree with anything.
 */
function recompute(bundle, accepted, dropped) {
  const survived = new Set(accepted.map((entry) => entry.attestation));
  for (const entry of dropped) survived.delete(entry.attestation);

  /*
   * The subject's identifiers are digests here, so each attestation's predicate
   * is mapped through the same digest before the kernel sees it.
   *
   * `coverageFor` asks one thing of an identifier: was it among those searched
   * for. That is set membership, and a digest is injective enough for it, so the
   * check is reproduced exactly without the bundle having to carry the subject's
   * key values. Labels rather than raw digests, so an uncovered identifier reads
   * as `identifier#2` in a sentence instead of sixty-four hex characters.
   */
  const labelOf = new Map(
    bundle.request.identifierDigests.map((digest, index) => [digest, `identifier#${index + 1}`]),
  );
  const relabel = (attestation) =>
    attestation.kind !== "direct"
      ? attestation
      : {
          ...attestation,
          predicate: {
            ...attestation.predicate,
            identifiers: attestation.predicate.identifiers.map(
              (identifier) =>
                labelOf.get(createHash("sha256").update(identifier, "utf8").digest("hex")) ??
                "identifier-this-request-does-not-cover",
            ),
          },
        };

  const attestations = [...survived].map(relabel);

  /*
   * The version standing for an asset is the one the newest attestation about it
   * names. Ten lines, restated here rather than imported, because it lives in
   * `erasure-engine.ts`, which is `server-only` and holds DataHub clients. That
   * it agrees with the server's `versionOf` is not left to a reading of both:
   * `tests/live/erasure.live.test.ts` runs this script over a bundle captured
   * from a live server and compares every version it reports.
   */
  const currentVersion = {};
  for (const asset of bundle.reachable) {
    const forAsset = attestations
      .filter((entry) => entry.asset === asset)
      .sort((a, b) => a.at.localeCompare(b.at));
    currentVersion[asset] = forAsset.at(-1)?.version ?? "unknown";
  }

  const coverage = coverageFor({
    request: bundle.request.request,
    identifiers: [...labelOf.values()],
    currentVersion,
    recordedUpstream: bundle.upstreamOf,
    attestations,
  });

  say();
  say("coverage, recomputed here from the evidence above");
  for (const row of coverage) {
    say(`  ${row.state.padEnd(12)} ${row.asset}`);
    say(`               ${row.explanation}`);
  }

  const summary = summarize(coverage);
  say();
  say(
    `recomputed  ${summary.attested} of ${summary.total} assets covered, ` +
      `${summary.unproven} unattested, ${summary.contradicted} contradicted`,
  );
  return { coverage, summary };
}

/** obsel's answer against this script's: the counts, and then asset by asset. */
function compare(bundle, recomputed) {
  const recorded = bundle.report.summary;
  say(
    `recorded    ${recorded.attested} of ${recorded.total} assets covered, ` +
      `${recorded.unproven} unattested, ${recorded.contradicted} contradicted`,
  );

  const claimed = new Map(bundle.report.coverage.map((row) => [row.asset, row]));
  const differences = [];

  /*
   * The counts are compared, not merely printed beside each other.
   *
   * `report.summary` is a stored field of its own, so an edit to it leaves every
   * row intact and a check that walked only rows found nothing to say. The
   * summary is the figure a reader quotes onward, which made that the one number
   * this file endorsed without ever having checked it.
   */
  const totals = recomputed.summary;
  const counted = ["total", "attested", "unproven", "contradicted"];
  if (counted.some((field) => recorded[field] !== totals[field])) {
    differences.push(
      `the recorded summary counts ${recorded.attested} of ${recorded.total} covered, ` +
        `${recorded.unproven} unattested, ${recorded.contradicted} contradicted; ` +
        `this recomputation counts ${totals.attested} of ${totals.total} covered, ` +
        `${totals.unproven} unattested, ${totals.contradicted} contradicted`,
    );
  }
  for (const row of recomputed.coverage) {
    const other = claimed.get(row.asset);
    if (!other) {
      differences.push(`${row.asset}: the recorded report has no row for it`);
      continue;
    }
    if (other.state !== row.state) {
      differences.push(
        `${row.asset}: recorded ${other.state}, the evidence here supports ${row.state}`,
      );
    } else if (other.version !== row.version) {
      differences.push(
        `${row.asset}: recorded version ${other.version}, the evidence here names ${row.version}`,
      );
    }
  }
  for (const row of bundle.report.coverage) {
    if (!recomputed.coverage.some((entry) => entry.asset === row.asset)) {
      differences.push(`${row.asset}: recorded, and not among the assets this bundle reaches`);
    }
  }

  if (differences.length > 0) {
    say();
    say("where obsel's recorded answer and this recomputation disagree");
    for (const difference of differences) say(`  ${difference}`);
  }
  return differences.length;
}
