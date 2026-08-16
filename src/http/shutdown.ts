import type { FastifyInstance } from "fastify";
import { markNotReady } from "./readiness.ts";

const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] as const;

/**
 * Stops the server without dropping in-flight requests.
 *
 * Docker sends SIGTERM and waits before killing the process. That window is
 * used to stop reporting healthy, finish requests already in progress, and
 * drain batched rows that have not yet reached PostgreSQL. The onClose hook in
 * index.ts performs the draining, in that order.
 *
 * The force-exit timer is set below `stop_grace_period` in compose, so a hung
 * shutdown ends on our terms with a log line rather than being killed silently.
 */

export function registerShutdownHandlers(
  app: FastifyInstance,
  timeoutMs = 10_000,
): void {
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    app.log.warn({ signal }, "Shutdown signal received, closing gracefully");

    // Stop reporting healthy first so load balancers and the load generator
    // stop routing new traffic while in-flight requests finish.
    markNotReady();

    const forceExit = setTimeout(() => {
      app.log.error("Graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, timeoutMs);

    forceExit.unref();

    try {
      await app.close();
      app.log.warn("Shutdown complete");
      process.exit(0);
    } catch (error) {
      app.log.error(error, "Error during shutdown");
      process.exit(1);
    }
  }

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }
}
