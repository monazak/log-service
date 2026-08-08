import Fastify, { type FastifyInstance, LogController } from "fastify";
import type pg from "pg";
import type { Config } from "../config/env.ts";
import { checkReadiness } from "./readiness.ts";

export function buildServer(config: Config, pool: pg.Pool): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.logLevel,
    },
    logController: new LogController({
      disableRequestLogging: config.isProduction,
    }),
  });

  app.get("/health", async (_request, reply) => {
    const state = await checkReadiness(pool);

    if (!state.ready) {
      return reply.code(503).send({ status: state.reason ?? "unavailable" });
    }
    return reply.code(200).send({ status: "ok" });
  });

  return app;
}
