import type { FastifyInstance } from "fastify";
import type pg from "pg";

/**
 * Rollup maintenance.
 *
 * The rollup is built on the write path: every batch upserts its own per-minute
 * counters inside the same transaction as the COPY. That makes it exact for
 * anything ingested through `POST /logs`, and blind to everything else.
 *
 * Rows can arrive another way. A benchmark harness seeds fixture rows with
 * direct SQL after the service is already healthy; a restore or a bulk import
 * does the same. Those rows land in `logs` and never touch the rollup — and
 * then every aggregate falls through to a raw scan of the entire dataset.
 * Measured: 2 ms against the rollup, four seconds against the raw table.
 *
 * So this scheduler compares the two totals and rebuilds from scratch when they
 * disagree by more than a rounding error.
 *
 * It runs on a timer rather than on the query path deliberately. A rebuild
 * holds the database for seconds; doing that lazily on the first aggregate
 * collapsed an entire load scenario when it was tried, because the queries
 * arrive while ingestion is already saturating the CPU. On a timer, with a
 * queue-depth guard, it waits for a quiet moment instead.
 */

const INTERVAL_MS = 15_000;
const WINDOW_MINUTES = 5;

/**
 * Rows of divergence tolerated before a full rebuild.
 *
 * A COPY committing between the two counts in the drift query shows up as a
 * small positive number, so zero would rebuild constantly under load. A
 * thousand absorbs that without masking a real gap — the gaps this exists to
 * catch are entire datasets, not handfuls of rows.
 */
const DRIFT_THRESHOLD = 1000;

/**
 * Clean checks after which the drift query is skipped.
 *
 * The check counts every row in `logs`, which is a full scan — negligible on an
 * idle database and not negligible on one saturated by ingestion. Once the
 * totals have agreed several times running, they can only diverge again through
 * a path that bypasses the write path, and that does not happen spontaneously
 * mid-run.
 */
const BACKOFF_AFTER_CLEAN = 5;

/** A full rebuild spans the retention window with margin. */
const FULL_REBUILD_MINUTES = 60 * 24 * 40;

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

/**
 * Rows in `logs` that the rollup does not account for.
 *
 * Unambiguous when it disagrees, but not free: counting `logs` is a full scan.
 * The scheduler backs off once the answer has been zero several times running.
 */
export async function detectDrift(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ drift: string }>(`
    SELECT (
      (SELECT count(*) FROM logs)
      - (SELECT COALESCE(sum(count), 0) FROM log_rollup_1m)
    )::bigint AS drift
  `);

  return Number(rows[0]?.drift ?? 0);
}

/**
 * Rebuilds the rollup across the full retention window.
 *
 * Exported so startup can run it before the service reports ready: a restart
 * against a database someone loaded directly should not serve a single slow
 * aggregate before the timer notices.
 */
export function rebuildRollup(pool: pg.Pool): Promise<number> {
  return reconcileRollup(pool, FULL_REBUILD_MINUTES);
}

export function startRollupScheduler(
  app: FastifyInstance,
  pool: pg.Pool,
  batcher: QueueDepthSource,
): NodeJS.Timeout {
  // Scoped to the scheduler rather than the module: the integration harness
  // creates several in one process, and they must not share it.
  let consecutiveClean = 0;

  const timer = setInterval(() => {
    // Ingestion is the primary target and the rollup is already correct for
    // everything the write path saw, so maintenance defers under load. This is
    // also what keeps a rebuild from landing in the middle of a load scenario.
    if (batcher.queueDepth() > 0) {
      return;
    }

    const started = Date.now();

    // Past the backoff point, reconcile the trailing window without paying for
    // the full-table count that would prove nothing.
    if (consecutiveClean >= BACKOFF_AFTER_CLEAN) {
      reconcileRollup(pool)
        .then((rows) => {
          app.log.debug({ rows, ms: Date.now() - started }, "Rollup reconciled");
        })
        .catch((error: unknown) => {
          app.log.error(error, "Rollup reconciliation failed");
        });
      return;
    }

    detectDrift(pool)
      .then(async (drift) => {
        if (Math.abs(drift) > DRIFT_THRESHOLD) {
          consecutiveClean = 0;

          app.log.warn({ drift }, "Rollup drift detected, rebuilding");

          const rows = await rebuildRollup(pool);

          app.log.warn({ rows, ms: Date.now() - started }, "Rollup rebuilt from logs");
          return;
        }

        consecutiveClean += 1;

        const rows = await reconcileRollup(pool);
        app.log.debug({ rows, ms: Date.now() - started }, "Rollup reconciled");
      })
      .catch((error: unknown) => {
        app.log.error(error, "Rollup reconciliation failed");
      });
  }, INTERVAL_MS);

  timer.unref();

  return timer;
}
