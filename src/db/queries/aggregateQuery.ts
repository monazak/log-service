import type {
  AggregateParams,
  BucketSize,
  GroupByField,
} from "../../domain/aggregate.ts";
import { rollupRange } from "../../domain/aggregate.ts";
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
 * the raw rows, so it is exactly consistent with `logs` at every commit. What
 * remains is a granularity mismatch, not a freshness one: rollup rows are whole
 * minutes, and a caller may ask for a range that starts or ends mid-minute.
 *
 * The query therefore unions three sources:
 *
 *   - raw rows from `since` up to the first whole minute
 *   - rollup rows for every whole minute inside the range
 *   - raw rows from the last whole minute up to `until`
 *
 * Each raw edge spans under a minute, so its cost is bounded by the ingest rate
 * rather than by how much data is stored — while the rollup span, which is
 * almost the entire range, costs about twenty rows per minute regardless.
 *
 * This matters because a client computing `since` as `Date.now() - N` never
 * produces an aligned boundary. Requiring alignment would have sent every such
 * query to the raw table and wasted the rollup entirely.
 *
 * Only `service` and `level` filters are applied. Attribute and message filters
 * cannot be served from the rollup, and `canUseRollup` is the guard that keeps
 * them out of this function — if that guard is ever loosened, this query will
 * silently ignore them.
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

  const { rollupSince, rollupUntil, hasRollupSpan } = rollupRange(params);

  const filterOn = (column: string): string[] => {
    const conditions: string[] = [];

    if (params.filters.service !== undefined) {
      conditions.push(
        `${column === "bucket" ? "" : ""}service = ${param(params.filters.service)}`,
      );
    }
    if (params.filters.level !== undefined) {
      conditions.push(`level = ${param(params.filters.level)}`);
    }

    return conditions;
  };

  const sources: string[] = [];

  // Leading partial minute, when `since` is not on a minute boundary.
  if (!hasRollupSpan || rollupSince.getTime() > params.since.getTime()) {
    const upper = hasRollupSpan ? rollupSince : params.until;
    const conditions = [
      `"timestamp" >= ${param(params.since)}`,
      `"timestamp" < ${param(upper)}`,
      ...filterOn("timestamp"),
    ];

    sources.push(`
      SELECT date_trunc('minute', "timestamp") AS bucket,
             service, level, 1::bigint AS count
      FROM logs
      WHERE ${conditions.join(" AND ")}
    `);
  }

  if (hasRollupSpan) {
    const conditions = [
      `bucket >= ${param(rollupSince)}`,
      `bucket < ${param(rollupUntil)}`,
      ...filterOn("bucket"),
    ];

    sources.push(`
      SELECT bucket, service, level, count
      FROM log_rollup_1m
      WHERE ${conditions.join(" AND ")}
    `);

    // Trailing partial minute.
    if (rollupUntil.getTime() < params.until.getTime()) {
      const conditions = [
        `"timestamp" >= ${param(rollupUntil)}`,
        `"timestamp" < ${param(params.until)}`,
        ...filterOn("timestamp"),
      ];

      sources.push(`
        SELECT date_trunc('minute', "timestamp") AS bucket,
               service, level, 1::bigint AS count
        FROM logs
        WHERE ${conditions.join(" AND ")}
      `);
    }
  }

  const sql = `
    WITH combined AS (
      ${sources.join("\n      UNION ALL\n")}
    )
    SELECT
      ${bucketExpr} AS bucket_start,
      ${groupExpr} AS grp,
      sum(count)::bigint AS cnt
    FROM combined
    GROUP BY bucket_start, grp
    ORDER BY bucket_start ASC, grp ASC NULLS FIRST
  `;

  return { sql, values };
}
