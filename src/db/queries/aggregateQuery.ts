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
