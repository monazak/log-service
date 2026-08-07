import Fastify, { type FastifyInstance, LogController } from "fastify";
import type { Config } from "../config/env.ts";
import { isReady } from "./readiness.ts";

export function buildServer(config: Config): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.logLevel,
    },
    logController: new LogController({
      disableRequestLogging: config.isProduction,
    }),
  });

  app.get("/health", (_request, reply) => {
    if (!isReady()) {
      return reply.code(503).send({ status: "starting" });
    }
    return reply.code(200).send({ status: "ok" });
  });

  return app;
}
