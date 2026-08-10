/**
 * Everything the hosted page computes, with no DOM in it.
 *
 * This module is built twice by `scripts/build-site.mjs`: once into the page's
 * bundle, and once as `site/dist/core.js`, which `tests/site-verify.test.ts`
 * imports under Node and holds equal to the CLI verifier over the same
 * bundles, tampered and not. The page's own DOM wiring lives in `main.js` and
 * stays out of here so the tested artifact is the one that computes.
 */

export { shapeProblem, verifyBundle } from "../scripts/verify-bundle.mjs";
export { TAMPERS } from "./tampers.js";
