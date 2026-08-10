#!/usr/bin/env node
/**
 * Check an obsel erasure evidence bundle offline, with Node and nothing else.
 *
 *     node scripts/verify-erasure-evidence.mjs examples/erasure-evidence/bundle.json
 *
 * A bundle comes from `GET /api/erasure/<id>/evidence`. It carries the signed
 * envelopes as they were signed, the attestor registry obsel was told to trust,
 * the challenges obsel issued, the lineage DataHub records, and obsel's own
 * answer. The check recomputes the answer from the evidence and reports every
 * asset where the two disagree.
 *
 * **This file is only the command line**: argv, reading the file, and the exit
 * codes. The check itself is `verify-bundle.mjs` beside it, which the hosted
 * page at `site/` bundles and runs unchanged. Splitting them is what lets that
 * page bundle real modules rather than stubs — nothing here that only Node can
 * do is in the shared half, so the browser build has nothing to stand in for.
 *
 * ## Exit codes
 *
 * - `0` every record verified, and the recomputed answer matches the bundle's.
 * - `1` it does not check out: a record failed, or an asset's recomputed state
 *   differs from the one recorded. Each failure is printed with the record it
 *   belongs to and the kind of failure it is.
 * - `2` the file could not be read, parsed, or is not shaped like a bundle.
 */

/*
 * Node prints MODULE_TYPELESS_PACKAGE_JSON when it type-strips a `.ts` file
 * under a package.json without `"type": "module"`. It is about this repository's
 * packaging and says nothing about the evidence, so it is dropped and every
 * other warning is still printed. Removing the default listener is how Node
 * documents replacing warning output; the import below is dynamic so this runs
 * before it resolves, since static imports are hoisted above everything.
 */
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  // `code`, not `name`. The name is the generic "Warning"; the code is what
  // identifies this one, and filtering on the name would silence every warning
  // Node has.
  if (warning.code === "MODULE_TYPELESS_PACKAGE_JSON") return;
  console.error(warning.stack ?? String(warning));
});

const { readFile } = await import("node:fs/promises");
const { shapeProblem, verifyBundle } = await import("./verify-bundle.mjs");

process.exitCode = await main(process.argv.slice(2));

async function main(argv) {
  const path = argv.find((entry) => !entry.startsWith("-"));
  if (!path) {
    console.log("usage: node scripts/verify-erasure-evidence.mjs <bundle.json>");
    return 2;
  }

  let bundle;
  try {
    bundle = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    console.log(`cannot read a bundle from ${path}: ${error.message}`);
    return 2;
  }

  const shape = shapeProblem(bundle);
  if (shape) {
    console.log(`${path} is not an obsel evidence bundle: ${shape}`);
    return 2;
  }

  const result = await verifyBundle(bundle, { print: true, source: path });
  return result.ok ? 0 : 1;
}
