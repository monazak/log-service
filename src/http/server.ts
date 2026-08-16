import Fastify, {
  type FastifyError,
  type FastifyInstance,
  LogController,
} from "fastify";

import type pg from "pg";
import type { Config } from "../config/env.ts";
import type { LogBatcher } from "../db/batcher.ts";
import { checkReadiness } from "./readiness.ts";
import { registerLogRoutes } from "./routes/logs.ts";

export function buildServer(
  config: Config,
  pool: pg.Pool,
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

  app.get("/health", async (_request, reply) => {
    const state = await checkReadiness(pool);

    if (!state.ready) {
      return reply.code(503).send({ status: state.reason ?? "unavailable" });
    }
    return reply.code(200).send({ status: "ok" });
  });
  registerLogRoutes(app, pool, batcher);
  return app;
}
