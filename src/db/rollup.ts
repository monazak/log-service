import type { FastifyInstance } from "fastify";
import type pg from "pg";

/**
 * Rollup maintenance.
 *
 * The rollup is no longer built here. It is maintained incrementally inside the
 * same transaction as each COPY, so it is exactly consistent with `logs` at
 * every commit — see `copyLogs`.
 *
 * What remains is reconciliation: a periodic recompute of a recent window that
 * corrects drift from any transaction that committed the COPY but failed the
 * upsert, and covers rows written by paths that do not maintain the rollup.
 *
 * It is deliberately infrequent and skipped under load. The previous design ran
 * a ten-minute recompute every ten seconds, which is what put Postgres at 76%
 * average CPU while the application idled at 6.6%. Correctness no longer
 * depends on this timer, so it yields freely.
 */

const INTERVAL_MS = 120_000;
const WINDOW_MINUTES = 5;

export interface QueueDepthSource {
  queueDepth(): number;
}

/** Recomputes a window from scratch. Idempotent: safe to run repeatedly. */
export async function reconcileRollup(
  pool: pg.Pool,
  windowMinutes: number = WINDOW_MINUTES,
): Promise<number> {
  const result = await pool.query<{ reconcile_log_rollup: number }>(
    `SELECT reconcile_log_rollup(now() - ($1 || ' minutes')::interval,
                                 now() + interval '1 minute')`,
    [windowMinutes],
  );

  return result.rows[0]?.reconcile_log_rollup ?? 0;
}

/** Drops rollup rows past the retention cutoff, matching partition retention. */
export async function pruneRollup(
  pool: pg.Pool,
  retentionDays: number,
): Promise<number> {
  const result = await pool.query<{ prune_log_rollup: number }>(
    "SELECT prune_log_rollup($1)",
    [retentionDays],
  );

  return result.rows[0]?.prune_log_rollup ?? 0;
}

export function startRollupScheduler(
  app: FastifyInstance,
  pool: pg.Pool,
  batcher: QueueDepthSource,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    // Ingestion is the primary target and the rollup is already correct without
    // this pass, so maintenance defers whenever entries are waiting.
    if (batcher.queueDepth() > 0) {
      return;
    }

    const started = Date.now();

    reconcileRollup(pool)
      .then((rows) => {
        app.log.debug({ rows, ms: Date.now() - started }, "Rollup reconciled");
      })
      .catch((error: unknown) => {
        app.log.error(error, "Rollup reconciliation failed");
      });
  }, INTERVAL_MS);

  timer.unref();

  return timer;
}
