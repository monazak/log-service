import type pg from "pg";
import type { AggregateParams } from "../../domain/aggregate.ts";
import { canUseRollup } from "../../domain/aggregate.ts";
import type { CursorPosition } from "../../domain/cursor.ts";
import type { ValidLogEntry } from "../../domain/log.ts";
import type { LogFilters } from "../../domain/query.ts";
import {
  buildAggregateQuery,
  buildRollupAggregateQuery,
} from "../queries/aggregateQuery.ts";
import { buildWhereClause } from "../queries/whereClause.ts";

/**
 * Persistence for log entries.
 *
 * Uses a single multi-row INSERT per batch rather than one statement per entry:
 * each round trip to Postgres costs more than the insert itself, so batching
 * turns N round trips into one.
 *
 * This is the correct-but-unoptimized version. The performance phase will
 * measure it against COPY and replace the implementation if warranted — the
 * function signature is the boundary that makes that swap invisible to callers.
 */

/** Postgres caps a statement at 65535 parameters; 5 columns means 13107 rows. */

const MAX_ROWS_PER_STATEMENT = 5000;

export interface LogRow {
  readonly id: string;
  readonly timestamp: Date;
  readonly level: string;
  readonly service: string;
  readonly message: string;
  readonly attributes: Record<string, string>;
}

export interface AggregateRow {
  readonly bucket_start: Date;
  readonly grp: string | null;
  readonly cnt: string;
}

export async function insertLogs(
  pool: pg.Pool,
  entries: readonly ValidLogEntry[],
): Promise<number> {
  if (entries.length === 0) {
    return 0;
  }
  let inserted = 0;

  for (let start = 0; start < entries.length; start += MAX_ROWS_PER_STATEMENT) {
    const chunk = entries.slice(start, start + MAX_ROWS_PER_STATEMENT);
    inserted += await insertChunk(pool, chunk);
  }
  return inserted;
}

async function insertChunk(
  pool: pg.Pool,
  entries: readonly ValidLogEntry[],
): Promise<number> {
  const values: unknown[] = [];
  const placeholders: string[] = [];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry === undefined) {
      continue;
    }
    const base = i * 5;
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`,
    );
    values.push(
      entry.timestamp,
      entry.level,
      entry.service,
      entry.message,
      JSON.stringify(entry.attributes),
    );
  }
  if (placeholders.length === 0) {
    return 0;
  }

  const sql = `
        INSERT INTO logs ("timestamp", level, service, message, attributes)
        VALUES ${placeholders.join(", ")}
    `;

  const result = await pool.query(sql, values);

  return result.rowCount ?? 0;
}

export async function queryLogs(
  pool: pg.Pool,
  filters: LogFilters,
  cursor?: CursorPosition,
): Promise<{ rows: LogRow[]; hasMore: boolean }> {
  const where = buildWhereClause(filters, cursor);

  const sql = `
    SELECT id, "timestamp", level, service, message, attributes
    FROM logs
    ${where.sql}
    ORDER BY "timestamp" DESC, id DESC
    LIMIT $${where.values.length + 1}
  `;

  const values = [...where.values, filters.limit + 1];

  const result = await pool.query<LogRow>(sql, values);

  const hasMore = result.rows.length > filters.limit;

  const rows = hasMore ? result.rows.slice(0, filters.limit) : result.rows;

  return { rows, hasMore };
}

export async function aggregateLogs(
  pool: pg.Pool,
  params: AggregateParams,
): Promise<AggregateRow[]> {
  const query = canUseRollup(params)
    ? buildRollupAggregateQuery(params)
    : buildAggregateQuery(params);
  const result = await pool.query<AggregateRow>(query.sql, query.values);
  return result.rows;
}
