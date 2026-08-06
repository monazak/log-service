import type { FastifyInstance } from "fastify";
import { markNotReady } from "./readiness.ts";

const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] as const;

/**
 * Stops the server without dropping in-flight requests.
 *
 * Docker sends SIGTERM and waits before killing the process. That window is
 * used to stop accepting new connections, finish requests already in progress,
 * and (from Phase 9 onward) flush any buffered rows that have not yet been
 * written to PostgreSQL.
 */

export function registerShutdownHandlers(
    app:FastifyInstance,
    timeoutMs = 10_000,
) : void {
    let shuttingDown = false;

    async function shutdown(signal: string) : Promise<void> {
        if(shuttingDown){
            return;
        }
        shuttingDown = true;
        app.log.warn({signal}, "Shutdown signal received, closing gracefully");
        // Stop reporting healthy so load balancers stop sending new traffic.
        markNotReady();

        const forceExit = setTimeout(()=>{
            app.log.error("Graceful shutdown timed out, forcing exit");
            process.exit(1);
        },timeoutMs);

        forceExit.unref();

        try{
            await app.close();
            app.log.warn("Shutsown complete");
            process.exit(0);
        } catch(error) {
            app.log.error(error, "Error during shutdown");
            process.exit(1);
        }
    }

    for (const signal of SHUTDOWN_SIGNALS){
        process.on(signal, () => {
            void shutdown(signal);
        });
    }
}
