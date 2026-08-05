import Fastify, {type FastifyInstance} from "fastify";

export function buildServer(): FastifyInstance {
    const app = Fastify({
        logger: true,
    });

    app.get("/health", async () => {
        return {status: "ok"};
    });
    return app;
}