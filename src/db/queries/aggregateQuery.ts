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
 * SQL text at plan time and cannot be passed as `$1`. The user's value chooses
 * between fragments we wrote; it never becomes one.
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
 * Combines two sources: pre-aggregated minute buckets for everything up to the
 * rollup watermark, and raw rows for the minutes after it. The rollup lags by
 * ~2-3 minutes (a bucket is only counted once complete), while the spec requires
 * newly ingested data to be queryable within 20 seconds — so the raw tail is
 * what keeps the endpoint compliant.
 *
 * The boundary is `log_rollup_state.last_bucket`, the exact point the rollup has
 * been computed to, which guarantees neither double-counting nor gaps.
 */
export function buildRollupAggregateQuery(params: AggregateParams): AggregateQuery {
  const values: unknown[] = [];

  const param = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };

  const bucketExpr = BUCKET_EXPRESSIONS[params.bucket].replace(/"timestamp"/g, "ts");

  const groupExpr =
    params.groupBy !== undefined ? GROUP_COLUMNS[params.groupBy] : "NULL";

  const conditions: string[] = [];

  if (params.filters.service !== undefined) {
    conditions.push(`service = ${param(params.filters.service)}`);
  }

  if (params.filters.level !== undefined) {
    conditions.push(`level = ${param(params.filters.level)}`);
  }

  const filterSql = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";

  const since = param(params.since);
  const until = param(params.until);

  const sql = `
    WITH watermark AS (
      SELECT last_bucket FROM log_rollup_state WHERE id
    ),
    combined AS (
      SELECT bucket AS ts, service, level, count AS cnt
      FROM log_rollup_1m, watermark
      WHERE bucket >= ${since}
        AND bucket < LEAST(${until}, watermark.last_bucket)
        ${filterSql}

      UNION ALL

      SELECT "timestamp" AS ts, service, level, 1::bigint AS cnt
      FROM logs, watermark
      WHERE "timestamp" >= GREATEST(${since}, watermark.last_bucket)
        AND "timestamp" < ${until}
        ${filterSql}
    )
    SELECT
      ${bucketExpr} AS bucket_start,
      ${groupExpr} AS grp,
      sum(cnt)::bigint AS cnt
    FROM combined
    GROUP BY bucket_start, grp
    ORDER BY bucket_start ASC, grp ASC NULLS FIRST
  `;

  return { sql, values };
}
