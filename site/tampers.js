/**
 * The edits the hosted page offers, each one field of a copied bundle.
 *
 * Every entry is a pure function from a bundle to an edited copy plus a plain
 * record of what changed: which field, the value before, the value after. The
 * page shows that record verbatim next to the re-run, so a reader is never
 * asked to take "we tampered with it" on faith - they can see the edit and
 * they can see the refusal, and the two name the same field.
 *
 * `expect` is the failure the verifier should report for that edit, stated up
 * front so a reader can check the outcome against the promise. These strings
 * appear in the re-run's output lines; `tests/site-verify.test.ts` asserts
 * each one actually does.
 */

function copy(bundle) {
  return structuredClone(bundle);
}

/**
 * The record the verifier prints first, picked the same way it picks it: by code
 * unit, never `localeCompare`. A locale-aware comparison would hand a Swedish
 * browser a different record to edit than the one this page's own output names
 * first, so the edit and the refusal would stop pointing at each other.
 */
function firstAttested(bundle) {
  return [...bundle.attestations].sort((a, b) =>
    a.asset === b.asset ? a.sequence - b.sequence : a.asset < b.asset ? -1 : 1,
  )[0];
}

export const TAMPERS = [
  {
    id: "flip-signature-byte",
    title: "change one character of a signature",
    does: "Replaces one character in the first record's base64 signature.",
    expect: "bad-signature",
    means:
      "The signature no longer matches the signed bytes, so the record is refused. " +
      "Nothing else about the record changed.",
    apply(bundle) {
      const edited = copy(bundle);
      const record = firstAttested(edited);
      const sig = record.body.envelope.signatures[0];
      const before = sig.sig;
      const at = Math.floor(before.length / 2);
      const replacement = before[at] === "A" ? "B" : "A";
      sig.sig = before.slice(0, at) + replacement + before.slice(at + 1);
      return {
        bundle: edited,
        change: {
          field: `attestations[${record.asset} #${record.sequence}].body.envelope.signatures[0].sig`,
          before: `...${before.slice(at - 6, at + 7)}...`,
          after: `...${sig.sig.slice(at - 6, at + 7)}...`,
        },
      };
    },
  },
  {
    id: "edit-signed-payload",
    title: "change the version inside a signed payload",
    does:
      "Decodes the first record's payload, changes the version the attestor signed for, and " +
      "encodes it back. The signature is left as it was.",
    expect: "bad-signature",
    means:
      "The claim now names a different version, but the signature covers the bytes that were " +
      "actually signed, so the altered record is refused. An attestation cannot be stretched to " +
      "cover a version the attestor never looked at.",
    apply(bundle) {
      const edited = copy(bundle);
      const record = firstAttested(edited);
      const decoded = JSON.parse(atob(record.body.envelope.payload));
      const before = decoded.version;
      decoded.version = `${before}-edited`;
      record.body.envelope.payload = btoa(JSON.stringify(decoded));
      return {
        bundle: edited,
        change: {
          field: `attestations[${record.asset} #${record.sequence}].body.envelope.payload version`,
          before,
          after: decoded.version,
        },
      };
    },
  },
  {
    id: "report-key-compromised",
    title: "report the signing key compromised",
    does: "Sets the registered key's status to compromised. No record, no signature and no data changes.",
    expect: "key-compromised",
    means:
      "Every attestation this key ever signed is refused, whenever it was signed, and the " +
      "recomputed coverage no longer matches the recorded report. This is the one way coverage " +
      "is lost without anybody touching data, and it is why coverage is recomputed on every " +
      "read instead of stored.",
    apply(bundle) {
      const edited = copy(bundle);
      const key = edited.keys[0];
      const before = JSON.stringify(key.status);
      key.status = { state: "compromised", at: edited.capturedAt };
      return {
        bundle: edited,
        change: {
          field: `keys[${key.keyId}].status`,
          before,
          after: JSON.stringify(key.status),
        },
      };
    },
  },
  {
    id: "retire-key",
    title: "retire the signing key instead",
    does: "Sets the same key's status to retired, dated after every signature in the bundle.",
    expect: "verdict   every record verified",
    means:
      "Everything still checks out. A retired key's past signatures stand, because retirement " +
      "says only that the key is no longer in use; a compromised key's do not, because nobody " +
      "can say how long somebody else held it. Same-looking edit as the one above, opposite " +
      "outcome, and keeping those two apart is a correctness rule in the kernel.",
    apply(bundle) {
      const edited = copy(bundle);
      const key = edited.keys[0];
      const before = JSON.stringify(key.status);
      key.status = { state: "retired", at: edited.capturedAt };
      return {
        bundle: edited,
        change: {
          field: `keys[${key.keyId}].status`,
          before,
          after: JSON.stringify(key.status),
        },
      };
    },
  },
  {
    id: "replay-envelope",
    title: "submit the same signed record twice",
    does: "Appends a copy of the first record as the next sequence number, envelope and all.",
    expect: "challenge-replayed",
    means:
      "The signature on the copy is genuine, and it is refused anyway: the challenge it answers " +
      "was already used by the original. A challenge is single use so one signed answer cannot " +
      "be made to cover two versions.",
    apply(bundle) {
      const edited = copy(bundle);
      const record = firstAttested(edited);
      const duplicate = structuredClone(record);
      duplicate.sequence =
        Math.max(
          ...edited.attestations
            .filter((entry) => entry.asset === record.asset)
            .map((entry) => entry.sequence),
        ) + 1;
      edited.attestations.push(duplicate);
      return {
        bundle: edited,
        change: {
          field: "attestations",
          before: `${bundle.attestations.length} record(s)`,
          after: `${edited.attestations.length} record(s), the last a copy of ${record.asset} #${record.sequence}`,
        },
      };
    },
  },
  {
    id: "edit-recorded-answer",
    title: "edit obsel's recorded answer",
    does: "Changes one UNPROVEN row of the recorded report to ATTESTED. The evidence is untouched.",
    expect: "the evidence here supports UNPROVEN",
    means:
      "The recomputation disagrees with the recorded report, row by row. A report edited after " +
      "the fact does not survive a re-derivation from the evidence, which is why the bundle " +
      "carries the evidence and not just the answer.",
    apply(bundle) {
      const edited = copy(bundle);
      const row = edited.report.coverage.find((entry) => entry.state === "UNPROVEN");
      const before = row.state;
      row.state = "ATTESTED";
      edited.report.summary = {
        ...edited.report.summary,
        attested: edited.report.summary.attested + 1,
        unproven: edited.report.summary.unproven - 1,
      };
      return {
        bundle: edited,
        change: {
          field: `report.coverage[${row.asset}].state`,
          before,
          after: row.state,
        },
      };
    },
  },
  {
    id: "drop-challenge",
    title: "remove the challenge a record answers",
    does: "Deletes the challenge whose nonce the first record's signed payload quotes.",
    expect: "unknown-challenge",
    means:
      "A record whose challenge obsel never issued is refused, however good its signature. The " +
      "challenge is what ties a signature to a question obsel actually asked, at a time obsel " +
      "chose.",
    apply(bundle) {
      const edited = copy(bundle);
      const record = firstAttested(edited);
      const nonce = record.body.nonce;
      const before = edited.challenges.length;
      edited.challenges = edited.challenges.filter((entry) => entry.nonce !== nonce);
      return {
        bundle: edited,
        change: {
          field: "challenges",
          before: `${before} challenge(s), one with nonce ${nonce}`,
          after: `${edited.challenges.length} challenge(s), nonce ${nonce} removed`,
        },
      };
    },
  },
];
