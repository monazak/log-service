import type {
  AggregateParams,
  BucketSize,
  GroupByField,
} from "../../domain/aggregate.ts";
import { buildWhereClause } from "./whereClause.ts";

/**
 * Builds the time-bucketed aggregation query.
 *
 * Bucket expressions and the group-by column are selected from closed
 * allow-lists rather than interpolated. Postgres plans a statement before
 * binding parameters, so an interval unit or column name must be present in the
 * SQL text at plan time and cannot be passed as `$1` — `GROUP BY $1` groups by
 * a constant string, which is a silently wrong result rather than an error. The
 * user's value chooses between fragments we wrote; it never becomes one.
 */

export interface AggregateQuery {
  readonly sql: string;
  readonly values: unknown[];
}

/** 5m has no date_trunc unit, so it is computed by epoch arithmetic. */
const BUCKET_EXPRESSIONS: Record<BucketSize, string> = {
  "1m": `date_trunc('minute', "timestamp")`,
  "5m": `to_timestamp(floor(extract(epoch FROM "timestamp") / 300) * 300)`,
  "1h": `date_trunc('hour', "timestamp")`,
  "1d": `date_trunc('day', "timestamp")`,
};

/**
 * The same expressions against the rollup's `bucket` column.
 *
 * Written out rather than string-replaced from the definitions above. The
 * previous implementation rewrote the column name with a regex, which worked
 * but broke silently if a bucket expression ever stopped mentioning the column
 * literally. Two short maps are cheaper to trust than one clever substitution.
 *
 * `1m` is the identity: rollup rows are already minute buckets.
 */
const ROLLUP_BUCKET_EXPRESSIONS: Record<BucketSize, string> = {
  "1m": `bucket`,
  "5m": `to_timestamp(floor(extract(epoch FROM bucket) / 300) * 300)`,
  "1h": `date_trunc('hour', bucket)`,
  "1d": `date_trunc('day', bucket)`,
};

const GROUP_COLUMNS: Record<GroupByField, string> = {
  service: "service",
  level: "level",
};

export function buildAggregateQuery(params: AggregateParams): AggregateQuery {
  const where = buildWhereClause(params.filters);

  const bucketExpr = BUCKET_EXPRESSIONS[params.bucket];

  const groupExpr =
    params.groupBy !== undefined ? GROUP_COLUMNS[params.groupBy] : "NULL";

  const sql = `
    SELECT
      ${bucketExpr} AS bucket_start,
      ${groupExpr} AS grp,
      count(*)::bigint AS cnt
    FROM logs
    ${where.sql}
    GROUP BY bucket_start, grp
    ORDER BY bucket_start ASC, grp ASC NULLS FIRST
  `;

  return { sql, values: where.values };
}

/**
 * Builds the rollup-backed aggregation query.
 *
 * The rollup is maintained inside the same transaction as the COPY that writes
 * the raw rows, so it is exactly consistent with `logs` at every commit. That
 * removes everything the previous design needed to compensate for a lagging
 * rollup: no watermark, no UNION ALL against a raw tail, no recent-range
 * fallback. A single scan of one small table answers the query.
 *
 * Scale is the point. The rollup holds one row per (minute, service, level) —
 * about twenty rows per minute regardless of ingest rate — where the raw table
 * holds one row per log entry. Aggregating a day is thousands of rows instead
 * of millions, and that cost does not grow as ingestion continues.
 *
 * Only `service` and `level` filters are applied here. Attribute and message
 * filters cannot be served from the rollup at all — those dimensions were
 * collapsed away when the rows were built — and `canUseRollup` is the guard
 * that keeps them out of this function. If that guard is ever loosened, this
 * query will silently ignore them.
 */
export function buildRollupAggregateQuery(params: AggregateParams): AggregateQuery {
  const values: unknown[] = [];

  const param = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };

  const bucketExpr = ROLLUP_BUCKET_EXPRESSIONS[params.bucket];

  const groupExpr =
    params.groupBy !== undefined ? GROUP_COLUMNS[params.groupBy] : "NULL";

  const conditions: string[] = [
    `bucket >= ${param(params.since)}`,
    `bucket < ${param(params.until)}`,
  ];

  if (params.filters.service !== undefined) {
    conditions.push(`service = ${param(params.filters.service)}`);
  }

  if (params.filters.level !== undefined) {
    conditions.push(`level = ${param(params.filters.level)}`);
  }

  const sql = `
    SELECT
      ${bucketExpr} AS bucket_start,
      ${groupExpr} AS grp,
      sum(count)::bigint AS cnt
    FROM log_rollup_1m
    WHERE ${conditions.join(" AND ")}
    GROUP BY bucket_start, grp
    ORDER BY bucket_start ASC, grp ASC NULLS FIRST
  `;

  return { sql, values };
}
