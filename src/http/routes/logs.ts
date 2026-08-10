import type { FastifyInstance } from "fastify";
import type pg from "pg";
import {
  aggregateLogs,
  insertLogs,
  queryLogs,
} from "../../db/repositories/logRepository.ts";
import { parseAggregateParams } from "../../domain/aggregate.ts";
import { validateBatch } from "../../domain/batch.ts";
import {
  type CursorPosition,
  decodeCursor,
  encodeCursor,
} from "../../domain/cursor.ts";
import { parseLogFilters } from "../../domain/query.ts";
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

  app.get("/logs", async (request, reply) => {
    const parsed = parseLogFilters(request.query as Record<string, unknown>);
    if (!parsed.ok) {
      return reply.code(400).send({ error: parsed.error });
    }
    const filters = parsed.filters;
    let cursor: CursorPosition | undefined;

    if (filters.cursor !== undefined) {
      const decoded = decodeCursor(filters.cursor);

      if (!decoded.ok) {
        return reply.code(400).send({ error: decoded.error });
      }
      cursor = decoded.position;
    }

    const { rows, hasMore } = await queryLogs(pool, filters, cursor);
    const last = rows[rows.length - 1];

    const nextCursor =
      hasMore && last !== undefined ? encodeCursor(last.timestamp, last.id) : null;

    return reply.code(200).send({
      logs: rows.map((row) => ({
        id: row.id,
        timestamp: row.timestamp.toISOString(),
        level: row.level,
        service: row.service,
        message: row.message,
        attributes: row.attributes,
      })),
      next_cursor: nextCursor,
    });
  });

  app.get("/logs/aggregate", async (request, reply) => {
    const parsed = parseAggregateParams(request.query as Record<string, unknown>);
    if (!parsed.ok) {
      return reply.code(400).send({ error: parsed.error });
    }

    const rows = await aggregateLogs(pool, parsed.params);

    return reply.code(200).send({
      buckets: rows.map((row) => ({
        start: row.bucket_start.toISOString(),
        group: row.grp,
        count: Number(row.cnt),
      })),
    });
  });
}
