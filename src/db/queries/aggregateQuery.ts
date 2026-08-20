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

/** Rollup bucket width, and therefore the width of a partial-minute section. */
const MINUTE_MS = 60_000;

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
 * The query unions one source per section of the range:
 *
 *   - the leading partial minute, when `since` is not on a minute boundary
 *   - rollup rows for every whole minute inside the range
 *   - the trailing partial minute, when `until` is not on a minute boundary
 *
 * A partial minute is where this used to become expensive. Reading it from the
 * raw table costs one row per log in that minute — at 15,000 logs/sec, up to
 * 900,000 rows for a single aggregate request, on the same CPU that is
 * accepting the writes. Measured at 658,515 rows and 438 ms for one such
 * request, against 0.95 ms for the same request without the raw edge. That is
 * the whole reason aggregate latency and ingest throughput collapsed together:
 * they were competing for one CPU, and the reader was winning.
 *
 * `partialMinuteSources` removes that cost in the case that actually occurs.
 * The rollup row for a minute counts the whole minute, so it answers a partial
 * request exactly when the minute holds no rows outside the requested range —
 * and for `until = now`, the part beyond `until` is the future, which is empty.
 * The condition is checked in the same statement, by an uncorrelated subquery
 * that Postgres evaluates once as an InitPlan: when it holds, the raw branch is
 * planned but never executed. When it does not, the raw branch runs and the
 * result is what it always was. Keeping it in one statement is what keeps the
 * answer atomic — a separate probe would be answered from a different snapshot
 * than the counts it guards.
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

  /**
   * `service` and `level` restrictions, which both sources carry verbatim.
   *
   * The rollup keeps both columns, so the same predicate is valid against
   * either table — and the probes below must carry it too, or they would look
   * for rows the query does not count.
   */
  const filterConditions = (): string[] => {
    const conditions: string[] = [];

    if (params.filters.service !== undefined) {
      conditions.push(`service = ${param(params.filters.service)}`);
    }
    if (params.filters.level !== undefined) {
      conditions.push(`level = ${param(params.filters.level)}`);
    }

    return conditions;
  };

  /** Rollup rows for whole minutes in `[from, to)`. */
  const rollupSpan = (from: number, to: number): string => {
    const conditions = [
      `bucket >= ${param(new Date(from))}`,
      `bucket < ${param(new Date(to))}`,
      ...filterConditions(),
    ];

    return `
      SELECT bucket, service, level, count
      FROM log_rollup_1m
      WHERE ${conditions.join(" AND ")}
    `;
  };

  /**
   * Sources for `[from, to)`, a range lying inside the single minute that
   * starts at `minuteStart`.
   *
   * Emits both branches — the rollup row and the raw scan — under complementary
   * one-time conditions, so exactly one of them produces rows. The condition is
   * "the minute holds a row outside `[from, to)`": if it does not, the rollup
   * row for that minute *is* the answer for `[from, to)`.
   */
  const partialMinuteSources = (
    minuteStart: number,
    from: number,
    to: number,
  ): string[] => {
    const minuteEnd = minuteStart + MINUTE_MS;

    // The parts of the minute the request does not ask for. Each is at most a
    // minute wide, and each is probed rather than scanned.
    const gaps: Array<readonly [number, number]> = [];
    if (from > minuteStart) {
      gaps.push([minuteStart, from]);
    }
    if (to < minuteEnd) {
      gaps.push([to, minuteEnd]);
    }

    const outsideRow = (): string =>
      gaps
        .map(([gapFrom, gapTo]) => {
          const conditions = [
            `"timestamp" >= ${param(new Date(gapFrom))}`,
            `"timestamp" < ${param(new Date(gapTo))}`,
            ...filterConditions(),
          ];

          // Written as `min(...) IS NOT NULL` rather than `EXISTS (...)`, and
          // the difference is 394 ms.
          //
          // `EXISTS` tells the planner it may stop at the first matching row,
          // and the planner concludes a sequential scan will reach one almost
          // immediately — so it picks the sequential scan. But the answer this
          // probe wants is usually *no*, and proving a range empty by
          // sequential scan means reading the whole partition: measured at
          // 78,231 buffers to clear one minute. `ORDER BY ... LIMIT 1` does not
          // help, because ordering is meaningless to `EXISTS` and the planner
          // discards it.
          //
          // `min()` over an indexed column is rewritten into "walk the index
          // forward, take the first row" — a plan that has no sequential-scan
          // form to fall back to. Same answer, and the empty case costs an index
          // descent: 0.17 ms, or 0.05 ms when a `service` filter lets it use the
          // service index instead.
          return `(SELECT min("timestamp") FROM logs WHERE ${conditions.join(" AND ")}) IS NOT NULL`;
        })
        .join(" OR ");

    if (gaps.length === 0) {
      // The request covers the whole minute after all.
      return [rollupSpan(minuteStart, minuteEnd)];
    }

    const rollupConditions = [
      `bucket = ${param(new Date(minuteStart))}`,
      ...filterConditions(),
      `NOT (${outsideRow()})`,
    ];

    const rawConditions = [
      `"timestamp" >= ${param(new Date(from))}`,
      `"timestamp" < ${param(new Date(to))}`,
      ...filterConditions(),
      `(${outsideRow()})`,
    ];

    return [
      `
      SELECT bucket, service, level, count
      FROM log_rollup_1m
      WHERE ${rollupConditions.join(" AND ")}
    `,
      `
      SELECT date_trunc('minute', "timestamp") AS bucket,
             service, level, 1::bigint AS count
      FROM logs
      WHERE ${rawConditions.join(" AND ")}
    `,
    ];
  };

  const sinceMs = params.since.getTime();
  const untilMs = params.until.getTime();
  const firstMinute = Math.floor(sinceMs / MINUTE_MS) * MINUTE_MS;
  const lastMinute = Math.floor(untilMs / MINUTE_MS) * MINUTE_MS;

  const sources: string[] = [];

  if (firstMinute === lastMinute) {
    // The whole range lies inside one minute, so there is one partial section
    // rather than a leading and a trailing one.
    sources.push(...partialMinuteSources(firstMinute, sinceMs, untilMs));
  } else {
    if (sinceMs > firstMinute) {
      sources.push(
        ...partialMinuteSources(firstMinute, sinceMs, firstMinute + MINUTE_MS),
      );
    }

    const wholeFrom = sinceMs > firstMinute ? firstMinute + MINUTE_MS : firstMinute;

    if (lastMinute > wholeFrom) {
      sources.push(rollupSpan(wholeFrom, lastMinute));
    }

    if (untilMs > lastMinute) {
      sources.push(...partialMinuteSources(lastMinute, lastMinute, untilMs));
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
