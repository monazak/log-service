import { type LogFilters, parseLogFilters } from "./query.ts";

/**
 * Query parameters for GET /logs/aggregate.
 *
 * Shares the filter parser with GET /logs, then layers the aggregate-specific
 * contract on top: since, until, and bucket are required here even though the
 * first two are optional on GET /logs.
 *
 * `bucket` and `groupBy` are closed allow-lists. Neither can be passed as a
 * bind parameter — Postgres plans a statement before binding values, so a
 * column name or interval must be present in the SQL text at plan time. Both
 * are therefore used to select a fragment we wrote, never to build one.
 */

export const BUCKET_SIZES = ["1m", "5m", "1h", "1d"] as const;
export type BucketSize = (typeof BUCKET_SIZES)[number];

export const GROUP_BY_FIELDS = ["service", "level"] as const;
export type GroupByField = (typeof GROUP_BY_FIELDS)[number];

const MINUTE_MS = 60_000;

export interface AggregateParams {
  readonly filters: LogFilters;
  readonly since: Date;
  readonly until: Date;
  readonly bucket: BucketSize;
  readonly groupBy?: GroupByField;
}

export type AggregateResult =
  | { readonly ok: true; readonly params: AggregateParams }
  | { readonly ok: false; readonly error: string };

function isBucketSize(value: string): value is BucketSize {
  return (BUCKET_SIZES as readonly string[]).includes(value);
}

function isGroupByField(value: string): value is GroupByField {
  return (GROUP_BY_FIELDS as readonly string[]).includes(value);
}

export function parseAggregateParams(query: Record<string, unknown>): AggregateResult {
  const base = parseLogFilters(query);
  if (!base.ok) {
    return { ok: false, error: base.error };
  }
  const { filters } = base;

  if (filters.since === undefined) {
    return { ok: false, error: "missing required parameter: since" };
  }

  if (filters.until === undefined) {
    return { ok: false, error: "missing required parameter: until" };
  }

  const rawBucket = query["bucket"];
  if (typeof rawBucket !== "string" || rawBucket.length === 0) {
    return { ok: false, error: "missing required parameter: bucket" };
  }

  if (!isBucketSize(rawBucket)) {
    return {
      ok: false,
      error: `invalid bucket: '${rawBucket}', expected one of ${BUCKET_SIZES.join(", ")}`,
    };
  }

  const rawGroupBy = query["group_by"];
  let groupBy: GroupByField | undefined;

  if (rawGroupBy !== undefined) {
    if (typeof rawGroupBy !== "string" || !isGroupByField(rawGroupBy)) {
      return {
        ok: false,
        error: `invalid group_by: expected one of ${GROUP_BY_FIELDS.join(", ")}`,
      };
    }
    groupBy = rawGroupBy;
  }

  return {
    ok: true,
    params: {
      filters,
      since: filters.since,
      until: filters.until,
      bucket: rawBucket,
      ...(groupBy !== undefined ? { groupBy } : {}),
    },
  };
}

/**
 * Whether a query can be answered from the rollup.
 *
 * The rollup stores (bucket, service, level, count) and is maintained in the
 * same transaction as the writes it summarises, so it is exactly consistent
 * with `logs` at every commit. There is no lag to compensate for and therefore
 * no time-based fallback: the only question is whether the query needs a column
 * the rollup does not have.
 *
 * Two cases it cannot serve:
 *
 * Attribute filters and message search. Both dimensions were collapsed away
 * when the rows were built, and messages are not stored at all.
 *
 * Range bounds that fall inside a minute. Rollup rows are whole minutes, so a
 * range starting at 10:00:30 would either drop the 10:00 bucket entirely or
 * include the thirty seconds before the requested start. Neither is correct, so
 * unaligned ranges read the raw table. This costs little in practice: the load
 * generator and dashboard-style clients use aligned boundaries, and a
 * mid-minute range is by nature a narrow one.
 */
export function canUseRollup(params: AggregateParams): boolean {
  const hasAttributeFilter = Object.keys(params.filters.attributes).length > 0;

  if (hasAttributeFilter || params.filters.q !== undefined) {
    return false;
  }

  const sinceAligned = params.since.getTime() % MINUTE_MS === 0;
  const untilAligned = params.until.getTime() % MINUTE_MS === 0;

  return sinceAligned && untilAligned;
}
