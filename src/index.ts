import { loadConfig } from "./config/env.ts";
import { ensurePartitions, runMigrations } from "./db/migrate.ts";
import { startPartitionScheduler } from "./db/partitionScheduler.ts";
import { createPool, verifyConnection } from "./db/pool.ts";
import { markReady } from "./http/readiness.ts";
import { buildServer } from "./http/server.ts";
import { registerShutdownHandlers } from "./http/shutdown.ts";

const config = loadConfig();
const app = buildServer(config);
const pool = createPool(config);

let partitionTimer: NodeJS.Timeout | undefined;

app.addHook("onClose", async () => {
  if (partitionTimer !== undefined) {
    clearInterval(partitionTimer);
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
  startPartitionScheduler(app, pool);

  markReady();
  app.log.info("Service is ready to accept traffic");
} catch (error) {
  app.log.error(error, "Failed to start service");
  await pool.end().catch(() => {});
  process.exit(1);
}
