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
const SECOND_MS = 1_000;

/**
 * The two pre-aggregated sources, coarse first.
 *
 * A range's whole minutes come from `log_rollup_1m`; the partial minute at each
 * end is decomposed into `log_rollup_1s` rows. Both are maintained inside the
 * same transaction as the COPY that writes the raw rows, so both are exactly
 * consistent with `logs` at every commit.
 */
type RollupTable = "log_rollup_1m" | "log_rollup_1s";

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
export function buildRollupAggregateQuery(
  params: AggregateParams,
  secondRollupFrom: number = Number.POSITIVE_INFINITY,
): AggregateQuery {
  const values: unknown[] = [];

  const param = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };

  const bucketExpr = ROLLUP_BUCKET_EXPRESSIONS[params.bucket];
  const groupExpr =
    params.groupBy !== undefined ? GROUP_COLUMNS[params.groupBy] : "NULL";

  /**
   * `service` and `level` restrictions, which every source carries verbatim.
   *
   * Both rollups keep both columns, so the same predicate is valid against any
   * of the three tables — and the probes below must carry it too, or they would
   * look for rows the query does not count.
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

  /**
   * Every source reports a minute-granular bucket.
   *
   * The bucket expressions above are written against a minute column, so a
   * source reading per-second rows has to round before the union rather than
   * after it — otherwise a `1m` request would group by second.
   */
  const minuteBucketOf: Record<RollupTable, string> = {
    log_rollup_1m: "bucket",
    log_rollup_1s: "date_trunc('minute', bucket)",
  };

  /** Rollup rows for whole buckets in `[from, to)`. */
  const rollupSpan = (table: RollupTable, from: number, to: number): string => {
    const conditions = [
      `bucket >= ${param(new Date(from))}`,
      `bucket < ${param(new Date(to))}`,
      ...filterConditions(),
    ];

    return `
      SELECT ${minuteBucketOf[table]} AS bucket, service, level, count
      FROM ${table}
      WHERE ${conditions.join(" AND ")}
    `;
  };

  /** Raw rows in `[from, to)`, counted one at a time, under a one-time guard. */
  const rawSpan = (from: number, to: number, guard: string): string => {
    const conditions = [
      `"timestamp" >= ${param(new Date(from))}`,
      `"timestamp" < ${param(new Date(to))}`,
      ...filterConditions(),
      guard,
    ];

    return `
      SELECT date_trunc('minute', "timestamp") AS bucket,
             service, level, 1::bigint AS count
      FROM logs
      WHERE ${conditions.join(" AND ")}
    `;
  };

  /**
   * "At least one row lies in a part of the bucket the request excludes."
   *
   * Written as `min(...) IS NOT NULL` rather than `EXISTS (...)`, and the
   * difference is 394 ms.
   *
   * `EXISTS` tells the planner it may stop at the first matching row, and the
   * planner concludes a sequential scan will reach one almost immediately — so
   * it picks the sequential scan. But the answer this probe wants is usually
   * *no*, and proving a range empty by sequential scan means reading the whole
   * partition: measured at 78,231 buffers to clear one minute. `ORDER BY ...
   * LIMIT 1` does not help, because ordering is meaningless to `EXISTS` and the
   * planner discards it.
   *
   * `min()` over an indexed column is rewritten into "walk the index forward,
   * take the first row" — a plan with no sequential-scan form to fall back to.
   * Same answer, and the empty case costs an index descent: 0.17 ms, or 0.05 ms
   * when a `service` filter lets it use the service index instead.
   */
  const gapProbe = (gaps: ReadonlyArray<readonly [number, number]>): string =>
    gaps
      .map(([gapFrom, gapTo]) => {
        const conditions = [
          `"timestamp" >= ${param(new Date(gapFrom))}`,
          `"timestamp" < ${param(new Date(gapTo))}`,
          ...filterConditions(),
        ];

        return `(SELECT min("timestamp") FROM logs WHERE ${conditions.join(" AND ")}) IS NOT NULL`;
      })
      .join(" OR ");

  /**
   * Sources for `[from, to)`, a range lying inside one bucket of `table`.
   *
   * Emits both branches — the rollup row and the raw scan — under complementary
   * one-time conditions, so exactly one of them produces rows. The condition is
   * "the bucket holds a row outside `[from, to)`": if it does not, the rollup
   * row for that bucket *is* the answer for `[from, to)`.
   */
  const partialBucket = (
    table: RollupTable,
    grainMs: number,
    bucketStart: number,
    from: number,
    to: number,
  ): string[] => {
    const bucketEnd = bucketStart + grainMs;

    // The parts of the bucket the request does not ask for. Each is at most one
    // bucket wide, and each is probed rather than scanned.
    const gaps: Array<readonly [number, number]> = [];
    if (from > bucketStart) {
      gaps.push([bucketStart, from]);
    }
    if (to < bucketEnd) {
      gaps.push([to, bucketEnd]);
    }

    if (gaps.length === 0) {
      // The request covers the whole bucket after all.
      return [rollupSpan(table, bucketStart, bucketEnd)];
    }

    const rollupConditions = [
      `bucket = ${param(new Date(bucketStart))}`,
      ...filterConditions(),
      `NOT (${gapProbe(gaps)})`,
    ];

    return [
      `
      SELECT ${minuteBucketOf[table]} AS bucket, service, level, count
      FROM ${table}
      WHERE ${rollupConditions.join(" AND ")}
    `,
      rawSpan(from, to, `(${gapProbe(gaps)})`),
    ];
  };

  /**
   * Sources for `[from, to)`, a range lying inside a single minute.
   *
   * Where the second rollup reaches, the minute is decomposed into whole
   * seconds plus at most one partial second at each end — so the raw fallback,
   * when a probe does fail, covers under a second of ingestion rather than up
   * to a full minute. That is the leading edge of every range a client computes
   * as `Date.now() - N`: the minute holding `since` nearly always has rows
   * before it, so its probe fails by construction. Older minutes predate the
   * second rollup and are answered from the minute rollup exactly as before.
   */
  const partialMinute = (minuteStart: number, from: number, to: number): string[] => {
    if (minuteStart < secondRollupFrom) {
      return partialBucket("log_rollup_1m", MINUTE_MS, minuteStart, from, to);
    }

    const firstWholeSecond = Math.ceil(from / SECOND_MS) * SECOND_MS;
    const lastWholeSecond = Math.floor(to / SECOND_MS) * SECOND_MS;

    if (lastWholeSecond <= firstWholeSecond) {
      // The range does not span a whole second, so it is one partial second.
      const secondStart = Math.floor(from / SECOND_MS) * SECOND_MS;

      return partialBucket("log_rollup_1s", SECOND_MS, secondStart, from, to);
    }

    const sources: string[] = [];

    if (from < firstWholeSecond) {
      sources.push(
        ...partialBucket(
          "log_rollup_1s",
          SECOND_MS,
          firstWholeSecond - SECOND_MS,
          from,
          firstWholeSecond,
        ),
      );
    }

    sources.push(rollupSpan("log_rollup_1s", firstWholeSecond, lastWholeSecond));

    if (to > lastWholeSecond) {
      sources.push(
        ...partialBucket(
          "log_rollup_1s",
          SECOND_MS,
          lastWholeSecond,
          lastWholeSecond,
          to,
        ),
      );
    }

    return sources;
  };

  const sinceMs = params.since.getTime();
  const untilMs = params.until.getTime();
  const firstMinute = Math.floor(sinceMs / MINUTE_MS) * MINUTE_MS;
  const lastMinute = Math.floor(untilMs / MINUTE_MS) * MINUTE_MS;

  const sources: string[] = [];

  if (firstMinute === lastMinute) {
    // The whole range lies inside one minute, so there is one partial section
    // rather than a leading and a trailing one.
    sources.push(...partialMinute(firstMinute, sinceMs, untilMs));
  } else {
    if (sinceMs > firstMinute) {
      sources.push(...partialMinute(firstMinute, sinceMs, firstMinute + MINUTE_MS));
    }

    const wholeFrom = sinceMs > firstMinute ? firstMinute + MINUTE_MS : firstMinute;

    if (lastMinute > wholeFrom) {
      sources.push(rollupSpan("log_rollup_1m", wholeFrom, lastMinute));
    }

    if (untilMs > lastMinute) {
      sources.push(...partialMinute(lastMinute, lastMinute, untilMs));
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
