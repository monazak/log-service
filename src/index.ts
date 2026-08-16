import { loadConfig } from "./config/env.ts";
import { LogBatcher } from "./db/batcher.ts";
import { ensurePartitions, runMigrations } from "./db/migrate.ts";
import { startPartitionScheduler } from "./db/partitionScheduler.ts";
import { createPool, verifyConnection } from "./db/pool.ts";
import { dropExpiredPartitions, startRetentionScheduler } from "./db/retention.ts";
import { startRollupScheduler } from "./db/rollup.ts";
import { markReady } from "./http/readiness.ts";
import { buildServer } from "./http/server.ts";
import { registerShutdownHandlers } from "./http/shutdown.ts";

const config = loadConfig();
const pool = createPool(config);
const batcher = new LogBatcher(pool);
const app = buildServer(config, pool, batcher);

let partitionTimer: NodeJS.Timeout | undefined;
let retentionTimer: NodeJS.Timeout | undefined;
let rollupTimer: NodeJS.Timeout | undefined;

/**
 * Teardown, in the order that matters.
 *
 * Timers first so no new work starts. Then drain queued batches — entries are
 * still owned by requests that have not been answered, and closing the pool
 * first would reject writes those callers were told nothing about. The pool
 * closes last.
 *
 * Registered before listen(): Fastify rejects addHook once the server is
 * listening, which is also why the background workers return their timer
 * handles rather than registering their own cleanup.
 */
app.addHook("onClose", async () => {
  if (partitionTimer !== undefined) {
    clearInterval(partitionTimer);
  }
  if (retentionTimer !== undefined) {
    clearInterval(retentionTimer);
  }
  if (rollupTimer !== undefined) {
    clearInterval(rollupTimer);
  }

  app.log.warn("Draining pending log batches");
  await batcher.drain();

  app.log.warn("Closing database pool");
  await pool.end();
});

registerShutdownHandlers(app);

/**
 * Startup, in the order that matters.
 *
 * listen() comes first so the port is open and /health answers 503 while the
 * database work happens — the load generator polls it and must see an honest
 * "not yet" rather than a refused connection.
 *
 * Everything up to markReady() is a correctness condition: without migrations
 * or today's partition, ingestion fails. The schedulers after it are
 * maintenance — the service is correct without them for a while.
 */
try {
  await app.listen({ port: config.port, host: config.host });

  await verifyConnection(pool);
  app.log.info({ poolSize: config.dbPoolSize }, "Database connection verified");

  const migrations = await runMigrations(pool);
  app.log.info(migrations, "Migrations complete");

  const partitions = await ensurePartitions(pool);
  app.log.info({ created: partitions }, "Partitions ensured");

  // Runs once at startup so a service that was down for a week does not wait
  // six hours before cleaning up.
  const expired = await dropExpiredPartitions(pool, config.retentionDays);
  if (expired.length > 0) {
    app.log.warn(
      { dropped: expired, retentionDays: config.retentionDays },
      "Retention dropped expired partitions at startup",
    );
  }

  markReady();
  app.log.info("Service is ready to accept traffic");

  partitionTimer = startPartitionScheduler(app, pool);
  retentionTimer = startRetentionScheduler(app, pool, config.retentionDays);
  rollupTimer = startRollupScheduler(app, pool);
} catch (error) {
  app.log.error(error, "Failed to start service");
  await pool.end().catch(() => {});
  process.exit(1);
}
