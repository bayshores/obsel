/**
 * DOM wiring for the hosted verifier. All computation is in `core.js`.
 */

import { shapeProblem, TAMPERS, verifyBundle } from "./core.js";

const el = (id) => document.getElementById(id);

let original = null;

/**
 * The verdict on screen is cleared before the next bundle is verified.
 *
 * Verifying is asynchronous, and the previous run's verdict and lines are still
 * on the page while it happens. If this throws — a bundle shaped past
 * `shapeProblem` but hostile beyond it — nothing further writes to the DOM, and
 * the reader is left looking at a green verdict belonging to a different file.
 * So the surfaces that could be read as an answer are emptied first, and a throw
 * is reported here rather than escaping into an unhandled rejection.
 */
async function render(bundle, { heading, change = null, expect = null } = {}) {
  el("run-heading").textContent = heading;
  const cleared = el("verdict");
  cleared.classList.remove("refused", "ok");
  cleared.textContent = "Verifying this bundle.";
  el("output").textContent = "";
  el("run").hidden = false;

  // The edit box describes the argument, not the result, so it is written with
  // the rest of the clearing: leaving the last edit on screen beside a bundle
  // that has not been checked yet is the same fault as leaving the verdict.
  const changeBox = el("change");
  if (change) {
    changeBox.hidden = false;
    el("change-field").textContent = change.field;
    el("change-before").textContent = change.before;
    el("change-after").textContent = change.after;
    el("change-expect").textContent = expect;
  } else {
    changeBox.hidden = true;
  }

  let result;
  try {
    result = await verifyBundle(bundle);
  } catch (error) {
    cleared.classList.add("refused");
    cleared.textContent = `Refused: this bundle could not be checked. ${error.message}`;
    return;
  }

  const verdict = el("verdict");
  verdict.classList.toggle("refused", !result.ok);
  verdict.classList.toggle("ok", result.ok);
  verdict.textContent = result.ok
    ? "Checks out: every record verified, and the recomputed answer matches the recorded one."
    : `Refused: ${result.failedRecords} record(s) failed verification, ` +
      `${result.unreadableEntries} unreadable evidence entry(s), ` +
      `${result.disagreements} disagreement(s) with the recorded report.`;

  const output = el("output");
  for (const line of result.lines) {
    const row = document.createElement("span");
    row.textContent = line + "\n";
    if (/^  FAILED /.test(line)) row.className = "line-failed";
    else if (/^verdict {3}this bundle does not check out/.test(line)) row.className = "line-failed";
    else if (/^  ok {6}/.test(line) || /^verdict {3}every record verified/.test(line)) {
      row.className = "line-ok";
    } else if (/^(where obsel's recorded answer|attestations dropped)/.test(line)) {
      row.className = "line-failed";
    }
    output.append(row);
  }
  el("run").scrollIntoView({ behavior: "smooth", block: "start" });
}

function describeBundle(bundle) {
  el("bundle-facts").textContent =
    `Captured ${bundle.capturedAt}. Request ${bundle.request.request}: ` +
    `${bundle.request.hops} hops of lineage from ${bundle.request.seeds.length} seed asset(s), ` +
    `${bundle.reachable.length} assets reached, ${bundle.attestations.length} signed ` +
    `attestation(s), ${bundle.challenges.length} challenge(s), ${bundle.keys.length} registered key(s).`;
  el("bundle-json").textContent = JSON.stringify(bundle, null, 2);
}

function buildTamperList() {
  const list = el("tampers");
  for (const tamper of TAMPERS) {
    const item = document.createElement("div");
    item.className = "tamper";

    const button = document.createElement("button");
    button.textContent = tamper.title;
    button.addEventListener("click", async () => {
      const { bundle, change } = tamper.apply(original);
      await render(bundle, {
        heading: `After the edit: ${tamper.title.toLowerCase()}`,
        change,
        expect: tamper.expect,
      });
      el("explain").textContent = tamper.means;
      el("explain").hidden = false;
    });

    const does = document.createElement("p");
    does.textContent = tamper.does;

    item.append(button, does);
    list.append(item);
  }

  el("reset").addEventListener("click", async () => {
    el("explain").hidden = true;
    await render(original, { heading: "The bundle as captured" });
  });
}

function wireOwnBundle() {
  el("own-bundle").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (error) {
      el("own-bundle-problem").textContent = `Not JSON: ${error.message}`;
      return;
    }
    const problem = shapeProblem(parsed);
    if (problem) {
      el("own-bundle-problem").textContent = `Not an obsel evidence bundle: ${problem}`;
      return;
    }
    el("own-bundle-problem").textContent = "";
    original = parsed;
    describeBundle(parsed);
    el("explain").hidden = true;
    await render(parsed, { heading: `Your bundle: ${file.name}` });
  });
}

async function start() {
  const response = await fetch("./bundle.json");
  original = await response.json();
  describeBundle(original);
  buildTamperList();
  wireOwnBundle();
  await render(original, { heading: "The bundle as captured" });
}

start().catch((error) => {
  el("verdict").textContent = `The page failed to start: ${error.message}`;
  el("verdict").classList.add("refused");
  el("run").hidden = false;
});
