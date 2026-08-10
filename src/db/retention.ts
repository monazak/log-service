import type { FastifyInstance } from "fastify";
import type pg from "pg";

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
    dropExpiredPartitions(pool, retentionDays)
      .then((dropped) => {
        if (dropped.length > 0) {
          app.log.warn(
            { dropped, retentionDays },
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
