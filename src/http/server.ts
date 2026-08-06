import Fastify, {LogController, type FastifyInstance} from "fastify";
import { isReady  } from "./readiness.ts";
import type { Config } from "../config/env.ts";

export function buildServer(config: Config): FastifyInstance {
    const app = Fastify({
        logger: {
            level: config.logLevel,
        },
        logController:new LogController({
          disableRequestLogging: config.isProduction,
        })
    });

    app.get("/health", async (_request, reply) => {
        if (!isReady()){
            return reply.code(503).send({status: "starting" });
        }
        return reply.code(200).send({status: "ok"});
    });
    return app;
}