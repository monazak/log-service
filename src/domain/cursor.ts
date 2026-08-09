/**
 * Keyset pagination cursors.
 *
 * A cursor encodes the (timestamp, id) of the last row returned. The next page
 * asks for rows strictly before that point, so the index seeks directly to the
 * position instead of counting past skipped rows.
 *
 * OFFSET was rejected: it forces Postgres to read and discard every skipped
 * row, so page latency grows linearly with depth against a 1M-row target. It is
 * also unstable under concurrent ingestion — a row inserted between requests
 * shifts every offset, duplicating or skipping results.
 *
 * The spec calls the cursor opaque, so the format is internal. It is signed
 * only by validation, not cryptographically: a tampered cursor can shift the
 * read position but cannot reach data a plain query could not.
 */

export interface CursorPosition {
  readonly timestamp: Date;
  readonly id: string;
}
export type CursorResult =
  | { readonly ok: true; readonly position: CursorPosition }
  | { readonly ok: false; readonly error: string };

export function encodeCursor(timestamp: Date, id: string): string {
  const payload = JSON.stringify({ t: timestamp.toISOString(), i: id });
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeCursor(raw: string): CursorResult {
  let decoded: string;

  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return { ok: false, error: "invalid cursor" };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(decoded);
  } catch {
    return { ok: false, error: "invalid cursor" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "invalid cursor" };
  }
  const record = parsed as Record<string, unknown>;
  const t = record["t"];
  const i = record["i"];

  if (typeof t !== "string" || typeof i !== "string") {
    return { ok: false, error: "invalid cursor" };
  }
  const timestamp = new Date(t);

  if (Number.isNaN(timestamp.getTime())) {
    return { ok: false, error: "invalid cursor" };
  }
  if (!/^\d+$/.test(i)) {
    return { ok: false, error: "invalid cursor" };
  }
  return { ok: true, position: { timestamp, id: i } };
}
