import { loadConfig } from "./config/env.ts";
import { buildServer } from "./http/server.ts";
import { markReady } from "./http/readiness.ts";

const config = loadConfig();
const app = buildServer();

try{
    await app.listen({port: config.port, host: config.host});
    markReady();
    app.log.info("Service is ready to accept traffic");
}catch(error){
    app.log.error(error);
    process.exit(1);
}