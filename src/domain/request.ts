/**
 * Validates the top-level shape of POST /logs.
 *
 * The spec distinguishes this from per-entry failures: a malformed envelope is
 * a 400 for the whole request, while invalid entries inside a well-formed
 * envelope are reported individually.
 */

export type EnvelopeResult =
  | { readonly ok: true; readonly logs: readonly unknown[] }
  | { readonly ok: false; readonly error: string };

export function parseLogsEnvelope(body: unknown): EnvelopeResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "request body must be a JSON object" };
  }
  const logs = (body as Record<string, unknown>)["logs"];
  if (logs === undefined) {
    return { ok: false, error: "missing required field: logs" };
  }
  if (!Array.isArray(logs)) {
    return { ok: false, error: "logs must be an array" };
  }
  if (logs.length === 0) {
    return { ok: false, error: "logs must not be empty" };
  }
  return { ok: true, logs };
}
