import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { insertLogs } from "../../db/repositories/logRepository.ts";
import { validateBatch } from "../../domain/batch.ts";
import { parseLogsEnvelope } from "../../domain/request.ts";

/**
 * POST /logs — batch ingestion.
 *
 * The handler only orchestrates: parse the envelope, validate the batch,
 * persist what passed, shape the response. Validation rules live in domain/
 * and SQL lives in db/, so neither is reachable from here.
 */

export function registerLogRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.post("/logs", async (request, reply) => {
    const envelope = parseLogsEnvelope(request.body);

    if (!envelope.ok) {
      return reply.code(400).send({ error: envelope.error });
    }
    const { valid, rejected } = validateBatch(envelope.logs);
    if (valid.length === 0) {
      return reply.status(400).send({ accepted: 0, rejected });
    }
    await insertLogs(pool, valid);
    return reply.code(200).send({
      accepted: valid.length,
      rejected,
    });
  });
}
