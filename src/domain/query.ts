import { isLogLevel, type LogLevel } from "./log.ts";

/**
 * Query parameter parsing for GET /logs and GET /logs/aggregate.
 *
 * Produces a validated filter object or a spec-shaped error message. No SQL is
 * built here — that belongs in db/queries, so this stays a pure function and is
 * unit-testable without a database.
 */

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const ATTR_PREFIX = "attr.";

export interface LogFilters {
  readonly service?: string;
  readonly level?: LogLevel;
  readonly since?: Date;
  readonly until?: Date;
  readonly attributes: Readonly<Record<string, string>>;
  readonly q?: string;
  readonly limit: number;
  readonly cursor?: string;
}

export type FilterResult =
  | { readonly ok: true; readonly filters: LogFilters }
  | { readonly ok: false; readonly error: string };

function parseTimestamp(raw: string, field: string): Date | string {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return `invalid ${field}: '${raw}' is not a valid ISO 8601 timestamp`;
  }
  return parsed;
}

function parseLimit(raw: string): number | string {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    return `invalid limit: '${raw}' is not an integer`;
  }
  if (parsed < 1 || parsed > MAX_LIMIT) {
    return `invalid limit: must be between 1 and ${MAX_LIMIT}`;
  }
  return parsed;
}

function firstValue(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw) && typeof raw[0] === "string") {
    return raw[0];
  }
  return undefined;
}

export function parseLogFilters(query: Record<string, unknown>): FilterResult {
  const filters: {
    service?: string;
    level?: LogLevel;
    since?: Date;
    until?: Date;
    attributes: Record<string, string>;
    q?: string;
    limit: number;
    cursor?: string;
  } = {
    attributes: {},
    limit: DEFAULT_LIMIT,
  };
  for (const [key, rawValue] of Object.entries(query)) {
    const value = firstValue(rawValue);
    if (value === undefined) {
      continue;
    }
    if (key.startsWith(ATTR_PREFIX)) {
      const attrKey = key.slice(ATTR_PREFIX.length);

      if (attrKey.length === 0) {
        return { ok: false, error: "invalid attribute filter: empty key" };
      }
      filters.attributes[attrKey] = value;
      continue;
    }
    switch (key) {
      case "service": {
        if (value.length === 0) {
          return { ok: false, error: "service must be a non-empty string" };
        }
        filters.service = value;
        break;
      }
      case "level": {
        if (!isLogLevel(value)) {
          return { ok: false, error: `invalid level: '${value}'` };
        }
        filters.level = value;
        break;
      }
      case "since": {
        const parsed = parseTimestamp(value, "since");
        if (typeof parsed === "string") {
          return { ok: false, error: parsed };
        }
        filters.since = parsed;
        break;
      }
      case "until": {
        const parsed = parseTimestamp(value, "until");
        if (typeof parsed === "string") {
          return { ok: false, error: parsed };
        }
        filters.until = parsed;
        break;
      }
      case "q": {
        if (value.length > 0) {
          filters.q = value;
        }
        break;
      }
      case "limit": {
        const parsed = parseLimit(value);
        if (typeof parsed === "string") {
          return { ok: false, error: parsed };
        }
        filters.limit = parsed;
        break;
      }
      case "cursor": {
        if (value.length > 0) {
          filters.cursor = value;
        }
        break;
      }
      default:
        break;
    }
  }
  if (
    filters.since !== undefined &&
    filters.until !== undefined &&
    filters.until.getTime() <= filters.since.getTime()
  ) {
    return { ok: false, error: "until must be later than since" };
  }
  return { ok: true, filters };
}
