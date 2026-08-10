/**
 * `node:fs/promises` is imported by the verifier's CLI half, which the browser
 * never runs: `main()` is only reached when the file is the script Node was
 * started with. The bundler still has to resolve the import, so this stub
 * exists to be resolved and to refuse loudly if the unreachable path is ever
 * reached anyway.
 */
export function readFile() {
  throw new Error("there is no filesystem in the browser; pass a parsed bundle to verifyBundle");
}
