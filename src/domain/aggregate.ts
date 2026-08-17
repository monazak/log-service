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
 * Whether a query can be answered using the rollup at all.
 *
 * The rollup stores (bucket, service, level, count) and is maintained in the
 * same transaction as the writes it summarises, so it is exactly consistent
 * with `logs` at every commit. There is no lag to compensate for — the only
 * question is whether the query needs a column the rollup does not have.
 *
 * Attribute filters and message search are the two it cannot serve: both
 * dimensions were collapsed away when the rows were built, and messages are not
 * stored at all.
 *
 * Range alignment is *not* a condition. Rollup rows are whole minutes, so a
 * range with a mid-minute boundary is split: the partial minutes at each end
 * read the raw table and the whole minutes in between read the rollup. See
 * `rollupRange`.
 */
export function canUseRollup(params: AggregateParams): boolean {
  const hasAttributeFilter = Object.keys(params.filters.attributes).length > 0;

  return !hasAttributeFilter && params.filters.q === undefined;
}

export interface RollupRange {
  /** First whole minute the rollup covers, inclusive. */
  readonly rollupSince: Date;
  /** End of rollup coverage, exclusive. */
  readonly rollupUntil: Date;
  /** True when at least one whole minute falls inside the range. */
  readonly hasRollupSpan: boolean;
}

/**
 * Splits a requested range at minute boundaries.
 *
 * `since` rounds *up* and `until` rounds *down*, so the rollup covers only
 * minutes wholly inside the request. Whatever falls outside — at most one
 * partial minute at each end — is counted from the raw table.
 *
 * A range shorter than a minute, or one that spans no whole minute, has no
 * rollup span at all and is answered entirely from raw rows. That is cheap by
 * construction: such a range is under two minutes wide.
 */
export function rollupRange(params: AggregateParams): RollupRange {
  const sinceMs = params.since.getTime();
  const untilMs = params.until.getTime();

  const rollupSinceMs = Math.ceil(sinceMs / MINUTE_MS) * MINUTE_MS;
  const rollupUntilMs = Math.floor(untilMs / MINUTE_MS) * MINUTE_MS;

  return {
    rollupSince: new Date(rollupSinceMs),
    rollupUntil: new Date(rollupUntilMs),
    hasRollupSpan: rollupUntilMs > rollupSinceMs,
  };
}
