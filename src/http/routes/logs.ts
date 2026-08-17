import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { type LogBatcher, QueueFullError } from "../../db/batcher.ts";
import { aggregateLogs, queryLogs } from "../../db/repositories/logRepository.ts";
import { canUseRollup, parseAggregateParams } from "../../domain/aggregate.ts";
import { validateBatch } from "../../domain/batch.ts";
import {
  type CursorPosition,
  decodeCursor,
  encodeCursor,
} from "../../domain/cursor.ts";
import { parseLogFilters } from "../../domain/query.ts";
import { parseLogsEnvelope } from "../../domain/request.ts";
import {
  recordAggregate,
  recordIngest,
  recordIngestError,
  recordQuery,
} from "../metrics.ts";

/**
 * The four required endpoints.
 *
 * The handlers only orchestrate: parse, validate, persist or query, shape the
 * response. Validation rules live in domain/ and SQL lives in db/, so neither
 * is reachable from here.
 *
 * Writes go through the batcher rather than straight to the repository:
 * entries from concurrent requests are combined into one COPY. The await still
 * resolves only after that COPY commits, so no batch is acknowledged before
 * Postgres has accepted it.
 *
 * Reads use the read pool. The batcher holds the write pool, so a slow
 * aggregation can only ever exhaust read connections — ingestion keeps its own.
 *
 * Metrics are recorded around each path. The counters are plain integers and
 * cost nothing against the work of parsing a batch, which is what lets them be
 * always-on rather than a flag.
 */
export function registerLogRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  batcher: LogBatcher,
): void {
  app.post("/logs", async (request, reply) => {
    const started = Date.now();

    const envelope = parseLogsEnvelope(request.body);

    if (!envelope.ok) {
      recordIngestError();
      return reply.code(400).send({ error: envelope.error });
    }

    const { valid, rejected } = validateBatch(envelope.logs);

    if (valid.length === 0) {
      recordIngest(0, rejected.length, Date.now() - started);
      return reply.status(400).send({ accepted: 0, rejected });
    }

    try {
      await batcher.submit(valid);
    } catch (error) {
      recordIngestError();

      // Shedding load beats crashing, and the spec forbids acknowledging a
      // batch that was not written. 503 with Retry-After tells the client this
      // is transient and safe to retry.
      if (error instanceof QueueFullError) {
        return reply
          .code(503)
          .header("retry-after", "1")
          .send({ error: "ingestion queue is full, retry shortly" });
      }
      throw error;
    }

    // Recorded after the await, so the latency includes the flush wait — which
    // is what the caller actually experienced.
    recordIngest(valid.length, rejected.length, Date.now() - started);

    return reply.code(200).send({
      accepted: valid.length,
      rejected,
    });
  });

  app.get("/logs", async (request, reply) => {
    const started = Date.now();

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

    recordQuery(Date.now() - started);

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
    const started = Date.now();

    const parsed = parseAggregateParams(request.query as Record<string, unknown>);
    if (!parsed.ok) {
      return reply.code(400).send({ error: parsed.error });
    }

    const rows = await aggregateLogs(pool, parsed.params);

    // Which source served the query is the single most useful thing to know
    // about this endpoint. A rollup that is built but never read costs write
    // throughput and returns nothing — a failure mode that is invisible from
    // latency alone, and one this project hit before it was measured.
    recordAggregate(canUseRollup(parsed.params), Date.now() - started);

    return reply.code(200).send({
      buckets: rows.map((row) => ({
        start: row.bucket_start.toISOString(),
        group: row.grp,
        count: Number(row.cnt),
      })),
    });
  });
}
