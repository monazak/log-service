import { loadConfig } from "./config/env.ts";
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
const app = buildServer(config, pool);

let partitionTimer: NodeJS.Timeout | undefined;
let retentionTimer: NodeJS.Timeout | undefined;
let rollupTimer: NodeJS.Timeout | undefined;

app.addHook("onClose", async () => {
  if (partitionTimer !== undefined) {
    clearInterval(partitionTimer);
  }
  if (retentionTimer !== undefined) {
    clearInterval(partitionTimer);
  }
  if (rollupTimer !== undefined) {
    clearInterval(rollupTimer);
  }
  app.log.warn("Closing database pool");
  await pool.end();
});

registerShutdownHandlers(app);

try {
  await app.listen({ port: config.port, host: config.host });

  await verifyConnection(pool);
  app.log.info({ poolSize: config.dbPoolSize }, "Database connection verified");

  const migrations = await runMigrations(pool);
  app.log.info(migrations, "Migrations complete");

  const partitions = await ensurePartitions(pool);
  app.log.info({ created: partitions }, "Partitions ensured");

  partitionTimer = startPartitionScheduler(app, pool);
  const expired = await dropExpiredPartitions(pool, config.retentionDays);
  if (expired.length > 0) {
    app.log.warn(
      { dropped: expired, retentionDays: config.retentionDays },
      "Retention dropped expired partitions at startup",
    );
  }

  retentionTimer = startRetentionScheduler(app, pool, config.retentionDays);
  markReady();
  rollupTimer = startRollupScheduler(app, pool);
  app.log.info("Service is ready to accept traffic");
} catch (error) {
  app.log.error(error, "Failed to start service");
  await pool.end().catch(() => {});
  process.exit(1);
}
