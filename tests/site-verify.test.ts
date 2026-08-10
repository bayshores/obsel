/**
 * The hosted page's computation, tested as the artifact that ships.
 *
 * `scripts/build-site.mjs` is run for real, and what is imported below is
 * `site/dist/core.js`: the bundled kernel with the browser's substitutions in
 * it, @noble arithmetic and the Buffer polyfill included. Testing the
 * unbundled sources instead would test none of the substitutions, and the
 * substitutions are the only thing that can differ from the CLI.
 *
 * Two properties are held, and they are different claims:
 *
 * 1. **The browser core and the CLI agree**, verdict for verdict, over the
 *    committed real bundle and over every tampered copy the page offers. The
 *    CLI is spawned as a real process on the same JSON the core is given, so
 *    a drift between `node:crypto` and the @noble substitution in either
 *    direction fails here by name.
 * 2. **Each tamper produces the refusal its button promises.** The page prints
 *    `expect` next to the result; this is where that sentence is made true.
 *
 * The committed bundle is a real capture from a live server against a real
 * DataHub (`examples/erasure-evidence/`), and the signatures in it are real
 * Ed25519 signatures. Nothing here generates a stand-in for one.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname;
const BUILD = join(ROOT, "scripts", "build-site.mjs");
const CLI = join(ROOT, "scripts", "verify-erasure-evidence.mjs");
const BUNDLE = join(ROOT, "examples", "erasure-evidence", "bundle.json");

/** The vocabulary rule the whole project keeps; the page is not exempt. */
const FORBIDDEN = /\b(proof|proven|proves|complete|completely)\b/i;

const scratch = mkdtempSync(join(tmpdir(), "obsel-site-verify-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Core = {
  verifyBundle: (
    bundle: unknown,
    options?: { print?: boolean; source?: string },
  ) => Promise<{
    ok: boolean;
    failedRecords: number;
    disagreements: number;
    lines: string[];
  }>;
  shapeProblem: (bundle: unknown) => string | null;
  TAMPERS: {
    id: string;
    title: string;
    expect: string;
    apply: (bundle: unknown) => { bundle: unknown; change: { field: string } };
  }[];
};

let core: Core;
let bundle: unknown;

beforeAll(async () => {
  const build = spawnSync(process.execPath, [BUILD], { encoding: "utf8" });
  expect(build.status, build.stderr).toBe(0);
  core = (await import(join(ROOT, "site", "dist", "core.js"))) as Core;
  bundle = JSON.parse(readFileSync(BUNDLE, "utf8"));
}, 60_000);

/** The CLI, run as a judge runs it, over the exact JSON the core was given. */
function cliVerdict(edited: unknown, name: string) {
  const path = join(scratch, `${name}.json`);
  writeFileSync(path, JSON.stringify(edited));
  const run = spawnSync(process.execPath, [CLI, path], { encoding: "utf8" });
  return { status: run.status, stdout: run.stdout };
}

describe("the built browser core against the committed real bundle", () => {
  it("verifies the bundle and agrees with the CLI", async () => {
    const inBrowserBundle = await core.verifyBundle(bundle);
    expect(inBrowserBundle.ok).toBe(true);
    expect(inBrowserBundle.failedRecords).toBe(0);
    expect(inBrowserBundle.disagreements).toBe(0);

    const cli = cliVerdict(bundle, "clean");
    expect(cli.status).toBe(0);
  });

  it("prints the same lines the CLI prints, minus the CLI's bundle-path line", async () => {
    const { lines } = await core.verifyBundle(bundle);
    const cli = cliVerdict(bundle, "clean-lines");
    const cliLines = cli.stdout.split("\n").filter((line) => !line.startsWith("bundle    "));
    // trailing newline from console.log
    if (cliLines.at(-1) === "") cliLines.pop();
    expect(lines).toEqual(cliLines);
  });

  it("keeps the forbidden vocabulary out of everything it prints", async () => {
    const { lines } = await core.verifyBundle(bundle);
    expect(lines.join("\n")).not.toMatch(FORBIDDEN);
  });

  it("refuses a file that is not a bundle, by shape", () => {
    expect(core.shapeProblem({ formatVersion: 2 })).toMatch(/formatVersion/);
    expect(core.shapeProblem([])).toMatch(/not a JSON object/);
    expect(core.shapeProblem(JSON.parse(JSON.stringify(bundle)))).toBeNull();
  });
});

describe("bundles the CLI refuses, over the committed real bundle", () => {
  /**
   * One edit to the real bundle, written to a real file, run both ways.
   *
   * The page and the CLI are the same code apart from `site/node-crypto.js`, so
   * the only bundles on which they can differ are the ones that reach it, and a
   * bundle the browser accepts while the CLI refuses is the worst of the two
   * directions: the hosted page is what a judge is likelier to use.
   */
  function bothWays(name: string, edit: (bundle: Bundle) => void) {
    const edited = structuredClone(bundle) as Bundle;
    edit(edited);
    return { edited, cli: cliVerdict(edited, name) };
  }

  type Bundle = {
    keys: { publicKeyPem: string }[];
    attestations: { body?: { envelope?: { payload?: unknown } } }[];
  };

  it("refuses a public key whose base64 body lost its padding, as node does", async () => {
    /*
     * `createPublicKey` in node refuses an unpadded base64 body outright, and
     * `attestation.ts` turns that refusal into `bad-signature`. The browser's
     * `atob` is more forgiving than node and recovers the same 32 key bytes from
     * the shortened text, which would make one file check out on the page and
     * fail at the command line.
     */
    const { edited, cli } = bothWays("unpadded-pem", (target) => {
      const pem = target.keys[0].publicKeyPem;
      target.keys[0].publicKeyPem = pem
        .split("\n")
        .map((line) => (line.startsWith("-----") || line === "" ? line : line.replace(/=+$/, "")))
        .join("\n");
    });

    const inBrowser = await core.verifyBundle(edited);
    expect(cli.status, cli.stdout).toBe(1);
    expect(cli.stdout).toContain("bad-signature");
    expect(inBrowser.ok).toBe(false);
    expect(inBrowser.failedRecords).toBe(
      cli.stdout.split("\n").filter((l) => /^ {2}FAILED /.test(l)).length,
    );
  });

  it("names an attestation entry with no body, on both sides, instead of throwing", async () => {
    const { edited, cli } = bothWays("no-body", (target) => {
      delete target.attestations[0].body;
    });

    const inBrowser = await core.verifyBundle(edited);
    expect(cli.status, cli.stdout).toBe(1);
    expect(cli.stdout).toContain("the record carries no body");
    expect(inBrowser.ok).toBe(false);
    expect(inBrowser.lines.some((line) => line.includes("the record carries no body"))).toBe(true);
  });
});

describe("every tamper the page offers", () => {
  it("has a distinct id and an expectation string", () => {
    const ids = new Set(core.TAMPERS.map((tamper) => tamper.id));
    expect(ids.size).toBe(core.TAMPERS.length);
    for (const tamper of core.TAMPERS) expect(tamper.expect.length).toBeGreaterThan(0);
  });

  it("produces the refusal its button promises, and the CLI agrees", async () => {
    for (const tamper of core.TAMPERS) {
      const { bundle: edited } = tamper.apply(bundle);
      const result = await core.verifyBundle(edited);

      // The promise printed on the page, held against the output.
      const found = result.lines.some((line) => line.includes(tamper.expect));
      expect(found, `${tamper.id}: expected "${tamper.expect}" in the output`).toBe(true);

      // The one edit that should still check out is the retired key.
      expect(result.ok, tamper.id).toBe(tamper.id === "retire-key");

      // The CLI over the same edited JSON: same verdict, same refusal.
      const cli = cliVerdict(edited, tamper.id);
      expect(cli.status, tamper.id).toBe(tamper.id === "retire-key" ? 0 : 1);
      expect(cli.stdout.includes(tamper.expect), `${tamper.id} in CLI output`).toBe(true);
    }
  }, 60_000);

  it("never modifies the bundle it was given", async () => {
    const before = JSON.stringify(bundle);
    for (const tamper of core.TAMPERS) tamper.apply(bundle);
    expect(JSON.stringify(bundle)).toBe(before);
  });
});
