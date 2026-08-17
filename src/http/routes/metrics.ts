import type { FastifyInstance } from "fastify";
import { snapshot } from "../metrics.ts";

/**
 * Operational metrics endpoint.
 *
 * Additive: a new path that changes nothing about the four required endpoints.
 * Always on, because it needs no configuration and costs nothing to serve — the
 * counters are already being kept.
 *
 * JSON rather than Prometheus text format. Nothing here scrapes it, the
 * dashboard consumes it directly, and a second serialisation shape would be
 * code without a reader.
 */
export function registerMetricsRoutes(app: FastifyInstance): void {
  app.get("/metrics", (_request, reply) => {
    return reply.code(200).send(snapshot());
  });
}
