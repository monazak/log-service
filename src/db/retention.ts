import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { pruneRollup } from "./rollup.ts";

const INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Retention enforcement.
 *
 * Drops whole partitions rather than deleting rows, so expiry is a metadata
 * operation that neither locks writers nor bloats the table. See
 * migrations/005_retention.sql for why DELETE was rejected.
 *
 * Dropped partition names are logged: expiry is irreversible, and without a
 * record there is no answer to "where did last week's data go?".
 */

export async function dropExpiredPartitions(
  pool: pg.Pool,
  retentionDays: number,
): Promise<string[]> {
  const result = await pool.query<{ dropped_partition: string }>(
    "SELECT dropped_partition FROM drop_expired_log_partitions($1)",
    [retentionDays],
  );
  return result.rows.map((row) => row.dropped_partition);
}

/**
 * Applies retention to both the raw partitions and the rollup.
 *
 * The rollup summarises rows that partition drops remove, so pruning it is not
 * housekeeping — without it, aggregation would keep counting data that no
 * longer exists, and a query spanning the retention boundary would return
 * totals the raw table could not reproduce.
 *
 * Partitions drop first. If pruning then fails, the rollup is briefly ahead of
 * the raw table, which the next run corrects. The reverse order would leave the
 * rollup undercounting live data instead.
 */
export async function enforceRetention(
  pool: pg.Pool,
  retentionDays: number,
): Promise<{ dropped: string[]; prunedBuckets: number }> {
  const dropped = await dropExpiredPartitions(pool, retentionDays);

  if (dropped.length === 0) {
    return { dropped, prunedBuckets: 0 };
  }

  const prunedBuckets = await pruneRollup(pool, retentionDays);

  return { dropped, prunedBuckets };
}

/**
 * Runs retention every six hours.
 *
 * Partitions are daily, so a partition can only become expired once per day.
 * Six hours bounds worst-case lag well below that while keeping catalog scans
 * infrequent.
 *
 * Returns the timer so the caller owns teardown — Fastify rejects addHook once
 * listen() has been called.
 */
export function startRetentionScheduler(
  app: FastifyInstance,
  pool: pg.Pool,
  retentionDays: number,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    enforceRetention(pool, retentionDays)
      .then(({ dropped, prunedBuckets }) => {
        if (dropped.length > 0) {
          app.log.warn(
            { dropped, prunedBuckets, retentionDays },
            "Retention dropped expired partitions",
          );
        }
      })
      .catch((error: unknown) => {
        app.log.error(error, "Retention run failed");
      });
  }, INTERVAL_MS);

  timer.unref();

  return timer;
}
