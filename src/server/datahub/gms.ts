import "server-only";

/**
 * HTTP transport to DataHub's GMS, and the read-back that confirms a write.
 *
 * Failures throw. Nothing here degrades to an empty array, because in this
 * product an empty result means "nothing is affected" and that is the one wrong
 * answer nobody would question.
 */

import { DataHubError } from "./errors";

const DEFAULT_TIMEOUT_MS = 20_000;

/** Read lazily so a script or test can set the variable after importing this module. */
export function gmsUrl(): string {
  return process.env.DATAHUB_GMS_URL ?? "http://localhost:8080";
}

function headers(): Record<string, string> {
  const base: Record<string, string> = { "Content-Type": "application/json" };
  // Optional: the local quickstart disables auth entirely and issues no token.
  const token = process.env.DATAHUB_GMS_TOKEN;
  if (token) base.Authorization = `Bearer ${token}`;
  return base;
}

export async function gmsFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = `${gmsUrl()}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { ...headers(), ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (cause) {
    // Name the endpoint: "fetch failed" alone sends people to the wrong port.
    throw new DataHubError(
      `DataHub request to ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        `GMS is port 8080; port 9002 is the frontend proxy and will not answer this.`,
    );
  }
  return response;
}

export async function gmsJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await gmsFetch(path, init);
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new DataHubError(`DataHub ${response.status} on ${path}: ${body}`, response.status);
  }
  return (await response.json()) as T;
}

/**
 * Poll until `predicate` returns something, or fail with a named timeout.
 *
 * DataHub writes propagate asynchronously. A single immediate read-back reports
 * failures that are only delays, and retrying the write on that false failure
 * writes twice. Measured on this instance: a `remove_tags` issued immediately
 * after an `add_tags` errored, and the identical call seconds later succeeded.
 */
export async function confirmWrite<T>(
  predicate: () => Promise<T | null>,
  timeoutMs = 10_000,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  for (;;) {
    try {
      const result = await predicate();
      if (result !== null && result !== undefined) return result;
    } catch (cause) {
      // A read can fail while a write is still settling; keep the last reason so
      // the timeout says what actually went wrong rather than just "timed out".
      lastError = cause;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new DataHubError(`DataHub write was not confirmed within ${timeoutMs} ms${detail}`);
}
