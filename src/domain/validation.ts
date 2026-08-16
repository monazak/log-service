import { type Attributes, isLogLevel, LOG_LEVELS, type ValidLogEntry } from "./log.ts";

/**
 * Per-entry validation for ingestion.
 *
 * Hand-written rather than schema-library based: this runs tens of thousands of
 * times per second on 0.5 CPU, and it needs exact control over the rejection
 * reason strings the spec requires in the response.
 *
 * Input is `unknown` throughout. TypeScript types are erased at compile time
 * and guarantee nothing about data arriving over the network.
 */

const MAX_FUTURE_MS = 5 * 60 * 1000;

export type ValidationResult =
  | { readonly ok: true; readonly entry: ValidLogEntry }
  | { readonly ok: false; readonly reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTimestamp(raw: unknown, now: number): Date | string {
  if (raw === undefined || raw === null) {
    return "missing required field: timestamp";
  }
  if (typeof raw !== "string") {
    return "timestamp must be an ISO 8601 string";
  }

  const parsed = new Date(raw);

  if (Number.isNaN(parsed.getTime())) {
    return `invalid timestamp: '${raw}'`;
  }

  // The bound is inclusive: exactly five minutes ahead is accepted, which keeps
  // a client whose clock is at the limit from being rejected.
  if (parsed.getTime() > now + MAX_FUTURE_MS) {
    return "timestamp is more than 5 minutes in the future";
  }

  return parsed;
}

function validateAttributes(raw: unknown): Attributes | string {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (!isPlainObject(raw)) {
    return "attributes must be an object";
  }

  // Null prototype: assigning to `__proto__` on a normal object literal is a
  // silent no-op, so a caller sending {"__proto__": "x"} would have that key
  // vanish while the entry was still accepted. A prototype-less object treats
  // it as an ordinary key.
  const result: Record<string, string> = Object.create(null);

  for (const [key, value] of Object.entries(raw)) {
    if (key.includes("\u0000")) {
      return "attribute keys must not contain null bytes";
    }

    if (typeof value === "string") {
      if (value.includes("\u0000")) {
        return `attribute '${key}' must not contain null bytes`;
      }
      result[key] = value;
      continue;
    }

    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        return `attribute '${key}' must be a finite number`;
      }
      result[key] = String(value);
      continue;
    }

    if (typeof value === "boolean") {
      result[key] = String(value);
      continue;
    }

    return `attribute '${key}' must be a string, number, or boolean`;
  }

  return result;
}

/**
 * Returns the string on success, or `{ error }` on failure.
 *
 * The wrapper distinguishes a valid string from a failure message — returning a
 * bare string for both would make "service must be a string" indistinguishable
 * from a service actually named that.
 */
function validateNonEmptyString(
  raw: unknown,
  field: string,
): string | { error: string } {
  if (raw === undefined || raw === null) {
    return { error: `missing required field: ${field}` };
  }
  if (typeof raw !== "string") {
    return { error: `${field} must be a string` };
  }
  if (raw.length === 0) {
    return { error: `${field} must be a non-empty string` };
  }

  // Postgres cannot store a null byte in a TEXT column while JSON permits one.
  // Without this check the insert fails at the database and takes the whole
  // batch with it, breaking the partial-success contract.
  if (raw.includes("\u0000")) {
    return { error: `${field} must not contain null bytes` };
  }

  return raw;
}

/**
 * `now` is a parameter rather than a call to Date.now() inside, so the
 * five-minute future bound is testable without manipulating the system clock.
 * The batch validator captures it once per batch so every entry in a batch is
 * judged against the same instant.
 */
export function validateLogEntry(
  raw: unknown,
  now: number = Date.now(),
): ValidationResult {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: "entry must be an object" };
  }

  const timestamp = validateTimestamp(raw["timestamp"], now);
  if (typeof timestamp === "string") {
    return { ok: false, reason: timestamp };
  }

  if (raw["level"] === undefined || raw["level"] === null) {
    return { ok: false, reason: "missing required field: level" };
  }
  if (!isLogLevel(raw["level"])) {
    return {
      ok: false,
      reason: `invalid level: '${String(raw["level"])}', expected one of ${LOG_LEVELS.join(", ")}`,
    };
  }

  const service = validateNonEmptyString(raw["service"], "service");
  if (typeof service !== "string") {
    return { ok: false, reason: service.error };
  }

  const message = validateNonEmptyString(raw["message"], "message");
  if (typeof message !== "string") {
    return { ok: false, reason: message.error };
  }

  const attributes = validateAttributes(raw["attributes"]);
  if (typeof attributes === "string") {
    return { ok: false, reason: attributes };
  }

  return {
    ok: true,
    entry: {
      timestamp,
      level: raw["level"],
      service,
      message,
      attributes,
    },
  };
}
