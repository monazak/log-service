import Fastify, {
  type FastifyError,
  type FastifyInstance,
  LogController,
} from "fastify";

import type { Config } from "../config/env.ts";
import type { LogBatcher } from "../db/batcher.ts";
import type { Pools } from "../db/pool.ts";
import { checkReadiness } from "./readiness.ts";
import { registerDashboardRoutes } from "./routes/dashboard.ts";
import { registerLogRoutes } from "./routes/logs.ts";
import { registerMetricsRoutes } from "./routes/metrics.ts";

/**
 * Builds the server without starting it.
 *
 * Separate from listen() so integration tests can use Fastify's inject() — the
 * same routing, parsing, and error handling without binding a port.
 *
 * Takes both pools. Reads go through `pools.read` and writes through the
 * batcher, which holds `pools.write`. A slow aggregation can therefore only
 * exhaust read connections; ingestion keeps its own.
 */
export function buildServer(
  config: Config,
  pools: Pools,
  batcher: LogBatcher,
): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.logLevel,
    },
    logController: new LogController({
      disableRequestLogging: config.isProduction,
    }),
    bodyLimit: 10 * 1024 * 1024,
  });

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.statusCode === 400 || error.code === "FST_ERR_CTP_INVALID_JSON") {
      return reply.code(400).send({ error: "malformed JSON in request body" });
    }
    if (error.statusCode === 413) {
      return reply.code(413).send({ error: "request body too large" });
    }
    app.log.error(error, "Unhandled error");
    return reply.code(500).send({ error: "internal server error" });
  });

  app.setNotFoundHandler((request, reply) => {
    return reply
      .code(404)
      .send({ error: `route ${request.method} ${request.url} not found` });
  });

  // Health checks the write pool: that is the one ingestion depends on, and a
  // service that cannot write is not ready regardless of whether it can read.
  app.get("/health", async (_request, reply) => {
    const state = await checkReadiness(pools.write);

    if (!state.ready) {
      return reply.code(503).send({ status: state.reason ?? "unavailable" });
    }
    return reply.code(200).send({ status: "ok" });
  });

  registerLogRoutes(app, pools.read, batcher);

  // Additive only: new paths that change nothing about the four required
  // endpoints, need no configuration, and are safe to leave always on.
  registerMetricsRoutes(app);
  registerDashboardRoutes(app);

  return app;
}
