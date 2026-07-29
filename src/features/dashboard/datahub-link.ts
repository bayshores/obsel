/**
 * A link from obsel's board to the same entity's page in DataHub's own UI.
 *
 * Client-safe on purpose: it takes the base URL and the URN as arguments rather
 * than reading configuration, so nothing here imports from `src/server/`.
 *
 * **`encodeURIComponent` is the wrong function for this**, which is worth stating
 * because it is the obvious choice. DataHub's frontend escapes a URN with a
 * deliberately partial rule, read out of the bundle the running instance serves
 * (`assets/index-*.js`, `getEntityUrl` and its `vR` helper, DataHub as shipped by
 * `datahub docker quickstart`, checked 2026-07-23):
 *
 * ```js
 * e.replace(/%/g, "{{encoded_percent}}").replace(/\//g, "%2F")
 *  .replace(/\?/g, "%3F").replace(/#/g, "%23")
 *  .replace(/\[/g, "%5B").replace(/\]/g, "%5D")
 * ```
 *
 * Six characters, and `:` `(` `)` `,` are left raw. Percent-encoding a URN in full
 * would hand DataHub `%3A` sequences that its matching decoder turns back into
 * something else, so the safe-looking choice is the one that breaks the link.
 *
 * A percent sign becomes a literal `{{encoded_percent}}` rather than `%25`, which
 * looks like a bug and is not: it is how DataHub avoids double-decoding its own
 * escapes. obsel reproduces it because the goal is a link byte-identical to the one
 * DataHub's UI would generate, not a link obsel thinks is nicer.
 */
export function datahubTaskUrl(base: string, urn: string): string {
  return `${base.replace(/\/+$/, "")}/tasks/${encodeDataHubUrn(urn)}`;
}

/** DataHub's own partial escape, reproduced. See the note above. */
export function encodeDataHubUrn(urn: string): string {
  return urn
    .replace(/%/g, "{{encoded_percent}}")
    .replace(/\//g, "%2F")
    .replace(/\?/g, "%3F")
    .replace(/#/g, "%23")
    .replace(/\[/g, "%5B")
    .replace(/\]/g, "%5D");
}
