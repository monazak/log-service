import { type Attributes, isLogLevel, LOG_LEVELS, type ValidLogEntry } from "./log.ts";

/**
 * Per-entry validation for ingestion.
 *
 * Hand-written rather than schema-library based: this runs ~15,000 times per
 * second on 0.5 CPU, and it needs exact control over the rejection reason
 * strings the spec requires in the response.
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
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") {
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
  return raw;
}

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
