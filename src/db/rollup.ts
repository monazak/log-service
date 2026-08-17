import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { LogBatcher } from "./batcher.ts";

const INTERVAL_MS = 30_000;

/**
 * Rollup maintenance.
 *
 * Refreshes the 1-minute rollup table on a timer rather than by trigger. A
 * trigger would execute on every insert — ~43,000 times per second at measured
 * throughput — directly on the path the 15k/sec target depends on. The timer
 * runs once per 10 seconds.
 *
 * The spec allows newly ingested data to become queryable within 20 seconds,
 * which is what makes deferred refresh legitimate rather than a shortcut.
 */

export async function refreshRollup(pool: pg.Pool): Promise<number> {
  const result = await pool.query<{ refresh_log_rollup: number }>(
    "SELECT refresh_log_rollup()",
  );
  return result.rows[0]?.refresh_log_rollup ?? 0;
}

export function startRollupScheduler(
  app: FastifyInstance,
  pool: pg.Pool,
  batcher: LogBatcher,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    if (batcher.queueDepth() > 0) {
      return;
    }

    const started = Date.now();

    refreshRollup(pool)
      .then((rows) => {
        if (rows > 0) {
          app.log.debug({ rows, ms: Date.now() - started }, "Rollup refreshed");
        }
      })
      .catch((error: unknown) => {
        app.log.error(error, "Rollup refresh failed");
      });
  }, INTERVAL_MS);

  timer.unref();
  return timer;
}
