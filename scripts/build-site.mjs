#!/usr/bin/env node
/**
 * Build the hosted verifier page into `site/dist/`.
 *
 *     node scripts/build-site.mjs
 *
 * Two bundles come out of one source tree:
 *
 * - `dist/main.js`, the page: `site/main.js` plus everything it imports, which
 *   is the repository's own `attestation.ts`, `erasure.ts` and
 *   `verify-erasure-evidence.mjs`, unchanged.
 * - `dist/core.js`, the same computation with no DOM, which
 *   `tests/site-verify.test.ts` imports under Node and holds equal to the CLI
 *   verifier. Testing `dist/main.js` directly is impossible without a browser,
 *   and testing `site/core.js` unbundled would test the wrong artifact: the
 *   thing that ships is the bundle, shims and all.
 *
 * Substitutions, all three of them named here because this list is the whole
 * difference between the page and the CLI:
 *
 * - `node:crypto` becomes `site/node-crypto.js` (Ed25519 and SHA-256 from
 *   @noble, synchronous, because WebCrypto is not).
 * - `node:fs/promises` becomes a stub; only the CLI's unreachable `main()`
 *   imports it.
 * - Free `Buffer` references resolve to the feross/buffer polyfill.
 *
 * Not minified. A judge reading view-source should find the same sentences the
 * repository holds.
 */

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "site", "dist");
mkdirSync(dist, { recursive: true });

const shared = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: false,
  alias: {
    "node:crypto": join(root, "site", "node-crypto.js"),
    "node:fs/promises": join(root, "site", "fs-promises-stub.js"),
  },
  inject: [join(root, "site", "buffer-shim.js")],
  logLevel: "info",
};

await build({
  ...shared,
  entryPoints: [join(root, "site", "main.js")],
  outfile: join(dist, "main.js"),
});

await build({
  ...shared,
  entryPoints: [join(root, "site", "core.js")],
  outfile: join(dist, "core.js"),
});

const commit =
  process.env.GITHUB_SHA ??
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

const html = readFileSync(join(root, "site", "index.html"), "utf8").replace(
  "__COMMIT__",
  commit.slice(0, 12),
);
writeFileSync(join(dist, "index.html"), html);

copyFileSync(join(root, "site", "style.css"), join(dist, "style.css"));
copyFileSync(join(root, "examples", "erasure-evidence", "bundle.json"), join(dist, "bundle.json"));

// obsel's mark, copied rather than redrawn: `app/icon.svg` is what the app
// already serves as its icon, and a second drawing of it would drift.
copyFileSync(join(root, "app", "icon.svg"), join(dist, "icon.svg"));

/*
 * The same two faces the app self-hosts, out of the `geist` package and served
 * from this origin. Not a font CDN: the page tells a reader it makes no network
 * request after loading, and a webfont fetched from someone else would make
 * that sentence false.
 */
const faces = [
  ["geist-mono", "GeistMono-Regular.woff2"],
  ["geist-mono", "GeistMono-Medium.woff2"],
  ["geist-sans", "Geist-Regular.woff2"],
  ["geist-sans", "Geist-Medium.woff2"],
];
for (const [family, face] of faces) {
  copyFileSync(
    join(root, "node_modules", "geist", "dist", "fonts", family, face),
    join(dist, face),
  );
}

console.log(`built site/dist at commit ${commit.slice(0, 12)}`);
