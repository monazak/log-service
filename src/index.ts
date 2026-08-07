import { loadConfig } from "./config/env.ts";
import { buildServer } from "./http/server.ts";
import { markReady } from "./http/readiness.ts";
import { registerShutdownHandlers } from "./http/shutdown.ts";
import { createPool, verifyConnection } from "./db/pool.ts";
import { runMigrations } from "./db/migrate.ts";

const config = loadConfig();
const app = buildServer(config);
const pool = createPool(config);

app.addHook("onClose", async () => {
    app.log.warn("Closing database pool");
    await pool.end();
});

registerShutdownHandlers(app);

try{
    await app.listen({port: config.port, host: config.host});
    
    await verifyConnection(pool);
    app.log.info({ poolSize: config.dbPoolSize}, "Database connection verified" )
   
    const migrations = await runMigrations(pool);
    app.log.info(migrations, "Migrations complete");
    
    markReady();
    app.log.info("Service is ready to accept traffic");
}catch(error){
    app.log.error(error, "Failed to start service");
    await pool.end().catch(()=>{});
    process.exit(1);
}