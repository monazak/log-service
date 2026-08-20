import type pg from "pg";

/**
 * How far back the second-granularity rollup can be trusted.
 *
 * `log_rollup_1s` is only complete for the period it has been maintained over:
 * rows written before migration 021 created it are absent, and pruning
 * deliberately removes old seconds. Reading it outside that window would
 * silently undercount, so the aggregate query consults this watermark and falls
 * back to the minute rollup for anything older.
 *
 * Held in the process rather than joined into every query. It changes only when
 * the pruner moves it — once a minute at most — while the aggregate path reads
 * it on every request, and a subquery against it would add a scan of a second
 * table to a query whose entire purpose is to avoid scans.
 *
 * The default is "trust nothing". A process that has not yet read the watermark
 * behaves exactly like one running against a database without the table, which
 * is the conservative direction: the minute path is slower, never wrong.
 */
let authoritativeFrom = Number.POSITIVE_INFINITY;

/** Epoch milliseconds from which `log_rollup_1s` is complete. */
export function secondRollupFrom(): number {
  return authoritativeFrom;
}

/**
 * Records a new watermark.
 *
 * Postgres returns `-infinity` for a table that has never been pruned, which
 * `pg` hands back as the JavaScript `-Infinity` rather than a Date. Both forms
 * mean the same thing here, so both are accepted.
 */
export function setSecondRollupFrom(value: Date | number | null): void {
  if (value === null || value === undefined) {
    authoritativeFrom = Number.POSITIVE_INFINITY;
    return;
  }

  const ms = value instanceof Date ? value.getTime() : value;

  authoritativeFrom = Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/** Reads the watermark from the database into the process. */
export async function loadSecondRollupWindow(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ authoritative_from: Date | number }>(
    "SELECT authoritative_from FROM log_rollup_1s_state WHERE id",
  );

  setSecondRollupFrom(rows[0]?.authoritative_from ?? null);

  return authoritativeFrom;
}

/**
 * Drops seconds older than the retention window and advances the watermark.
 *
 * Retention is short because the table only exists to answer the partial minute
 * at each end of a requested range, and those ends are derived from "now". Two
 * hours covers any `since` a caller is realistically computing while bounding
 * the table at roughly 144,000 rows.
 */
export async function pruneSecondRollup(
  pool: pg.Pool,
  retentionMinutes: number,
): Promise<number> {
  const { rows } = await pool.query<{ prune_log_rollup_1s: Date | number }>(
    "SELECT prune_log_rollup_1s($1)",
    [retentionMinutes],
  );

  setSecondRollupFrom(rows[0]?.prune_log_rollup_1s ?? null);

  return authoritativeFrom;
}

/** Retention for the second rollup, in minutes. */
export const SECOND_ROLLUP_RETENTION_MINUTES = 120;
