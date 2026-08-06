import Fastify, {type FastifyInstance} from "fastify";
import { isReady  } from "./readiness.ts";

export function buildServer(): FastifyInstance {
    const app = Fastify({
        logger: true,
    });

    app.get("/health", async (_request, reply) => {
        if (!isReady()){
            return reply.code(503).send({status: "starting" });
        }
        return reply.code(200).send({status: "ok"});
    });
    return app;
}