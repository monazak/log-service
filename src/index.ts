import { loadConfig } from "./config/env.ts";
import { LogBatcher } from "./db/batcher.ts";
import { ensurePartitions, runMigrations } from "./db/migrate.ts";
import { startPartitionScheduler } from "./db/partitionScheduler.ts";
import { closePools, createPools, verifyConnection } from "./db/pool.ts";
import { enforceRetention, startRetentionScheduler } from "./db/retention.ts";
import { rebuildRollup, startRollupScheduler } from "./db/rollup.ts";
import { markReady } from "./http/readiness.ts";
import { buildServer } from "./http/server.ts";
import { registerShutdownHandlers } from "./http/shutdown.ts";

const config = loadConfig();
const pools = createPools(config);
const batcher = new LogBatcher(pools.write);
const app = buildServer(config, pools, batcher);

let partitionTimer: NodeJS.Timeout | undefined;
let retentionTimer: NodeJS.Timeout | undefined;
let rollupTimer: NodeJS.Timeout | undefined;

/**
 * Teardown, in the order that matters.
 *
 * Timers first so no new work starts. Then drain queued batches — entries are
 * still owned by requests that have not been answered, and closing the pools
 * first would reject writes those callers were told nothing about. Pools close
 * last.
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

  app.log.warn("Closing database pools");
  await closePools(pools);
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

  await verifyConnection(pools.write);
  app.log.info({ poolSize: config.dbPoolSize }, "Database connection verified");

  const migrations = await runMigrations(pools.write);
  app.log.info(migrations, "Migrations complete");

  const partitions = await ensurePartitions(pools.write);
  app.log.info({ created: partitions }, "Partitions ensured");

  // The rollup is blind to rows that did not come through the write path, and a
  // restart may be against a database someone loaded directly. Rebuilding
  // before reporting ready means the first aggregate is served from the rollup
  // rather than from a full scan. On an empty database this is instant.
  const rollupBuckets = await rebuildRollup(pools.write);
  app.log.info({ buckets: rollupBuckets }, "Rollup rebuilt at startup");

  // Runs once at startup so a service that was down for a week does not wait
  // six hours before cleaning up. Retention covers the rollup as well as the
  // raw partitions — see enforceRetention.
  const { dropped, prunedBuckets } = await enforceRetention(
    pools.write,
    config.retentionDays,
  );
  if (dropped.length > 0) {
    app.log.warn(
      { dropped, prunedBuckets, retentionDays: config.retentionDays },
      "Retention dropped expired partitions at startup",
    );
  }

  markReady();
  app.log.info("Service is ready to accept traffic");

  partitionTimer = startPartitionScheduler(app, pools.write);
  retentionTimer = startRetentionScheduler(app, pools.write, config.retentionDays);
  rollupTimer = startRollupScheduler(app, pools.write, batcher);
} catch (error) {
  app.log.error(error, "Failed to start service");

  // Timers may already be running, and the batcher may hold entries whose
  // flush is scheduled. Without clearing them the process spends its final
  // moments logging "cannot use a pool after end" once per flush interval,
  // burying the actual startup error under hundreds of lines.
  if (partitionTimer !== undefined) {
    clearInterval(partitionTimer);
  }
  if (retentionTimer !== undefined) {
    clearInterval(retentionTimer);
  }
  if (rollupTimer !== undefined) {
    clearInterval(rollupTimer);
  }

  await closePools(pools).catch(() => {});
  process.exit(1);
}
