/**
 * The one error type obsel's DataHub layer raises.
 *
 * Its own module, without the `server-only` guard `client.ts` carries, for the
 * same reason `tags.ts` has none: the transport half and the pure parsing half
 * both raise it, and a guard here would put the parsers back behind an import
 * that throws under vitest.
 */
export class DataHubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DataHubError";
  }
}
