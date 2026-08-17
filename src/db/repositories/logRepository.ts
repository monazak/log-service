import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type pg from "pg";
import { from as copyFrom } from "pg-copy-streams";
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
 * Writes go through `copyLogs`, which also maintains the 1-minute rollup in the
 * same transaction. `insertLogs` is the earlier multi-row INSERT, retained as a
 * reference implementation and fallback; it is not on the hot path.
 */

/** Postgres caps a statement at 65535 parameters; 5 columns means 13107 rows. */
const MAX_ROWS_PER_STATEMENT = 5000;

/**
 * Bytes of COPY payload accumulated before handing a chunk to the stream.
 *
 * CPU profiling under load put `writeBuffer` at 51% of application time: a
 * generator yielding one row at a time produces one socket write per row, and
 * the syscall costs far more than formatting the row did. Batching amortises it
 * across hundreds of rows.
 *
 * 64 KB sits near a typical socket buffer, so a chunk usually leaves in one
 * write without the stream fragmenting it again — and a single chunk is a
 * trivial allocation against a 256 MB budget.
 */
const COPY_CHUNK_BYTES = 64 * 1024;

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

/**
 * Escapes a value for Postgres text-format COPY.
 *
 * Text-format COPY delimits fields with tabs and rows with newlines, so an
 * unescaped message containing either would shift data into the wrong column or
 * split one row into several — with no error raised. Backslash is escaped
 * first, or the escapes introduced below would themselves be escaped.
 *
 * Null bytes need no handling: validation rejects them, because Postgres cannot
 * store them in a TEXT column at all.
 */
const COPY_ESCAPES: Record<string, string> = {
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

const NEEDS_ESCAPE = /[\\\n\r\t]/;

function escapeCopyField(value: string): string {
  // Most fields contain none of these. Testing first is markedly cheaper than
  // running the replace machinery on every field of every entry, and this runs
  // four times per row on the hot path.
  return NEEDS_ESCAPE.test(value)
    ? value.replace(/[\\\n\r\t]/g, (char) => COPY_ESCAPES[char] ?? char)
    : value;
}

/** Formats one entry as a text-format COPY row, including its terminator. */
function copyRow(entry: ValidLogEntry): string {
  return `${entry.timestamp.toISOString()}\t${entry.level}\t${escapeCopyField(entry.service)}\t${escapeCopyField(entry.message)}\t${escapeCopyField(JSON.stringify(entry.attributes))}\n`;
}

/** Floors a timestamp to its minute, matching the rollup's bucket granularity. */
function minuteBucket(timestamp: Date): number {
  return Math.floor(timestamp.getTime() / 60_000) * 60_000;
}

interface RollupDelta {
  readonly bucket: Date;
  readonly service: string;
  readonly level: string;
  readonly count: number;
}

/**
 * Counts a batch by (minute, service, level).
 *
 * A batch of several thousand entries collapses to at most
 * (minutes x services x levels) rows — typically around twenty. That is the
 * whole point: the rollup update becomes proportional to the batch's
 * *cardinality* rather than its size, and independent of how much data is
 * already stored.
 */
function computeRollupDeltas(entries: readonly ValidLogEntry[]): RollupDelta[] {
  const counts = new Map<string, RollupDelta & { count: number }>();

  for (const entry of entries) {
    const bucketMs = minuteBucket(entry.timestamp);
    const key = `${bucketMs}\u0000${entry.service}\u0000${entry.level}`;

    const existing = counts.get(key);

    if (existing === undefined) {
      counts.set(key, {
        bucket: new Date(bucketMs),
        service: entry.service,
        level: entry.level,
        count: 1,
      });
    } else {
      existing.count += 1;
    }
  }

  return [...counts.values()];
}

/**
 * Applies a batch's counters to the rollup.
 *
 * `ON CONFLICT ... DO UPDATE SET count = count + EXCLUDED.count` is what makes
 * this incremental: concurrent batches touching the same minute serialise on
 * the row and add rather than overwrite.
 *
 * Ordered by the primary key before insertion. Two concurrent batches updating
 * the same rows in different orders would deadlock; a consistent order makes
 * one wait instead.
 */
async function applyRollupDeltas(
  client: pg.PoolClient,
  deltas: readonly RollupDelta[],
): Promise<void> {
  if (deltas.length === 0) {
    return;
  }

  const ordered = [...deltas].sort((a, b) => {
    const byBucket = a.bucket.getTime() - b.bucket.getTime();
    if (byBucket !== 0) {
      return byBucket;
    }
    const byService = a.service.localeCompare(b.service);
    return byService !== 0 ? byService : a.level.localeCompare(b.level);
  });

  const values: unknown[] = [];
  const rows: string[] = [];

  for (const delta of ordered) {
    const base = values.length;
    rows.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
    values.push(delta.bucket, delta.service, delta.level, delta.count);
  }

  await client.query(
    `
      INSERT INTO log_rollup_1m (bucket, service, level, count)
      VALUES ${rows.join(", ")}
      ON CONFLICT (bucket, service, level)
      DO UPDATE SET count = log_rollup_1m.count + EXCLUDED.count
    `,
    values,
  );
}

/**
 * Bulk-inserts entries using COPY, and updates the rollup in the same
 * transaction.
 *
 * COPY bypasses the query parser and planner entirely: no SQL text to parse, no
 * plan to build, no bind parameters. The formatting work moves to the
 * application, which had spare capacity on exactly the side that had none.
 *
 * Text format rather than binary: binary is marginally faster but requires
 * encoding every type by hand, and a single encoding bug corrupts data
 * silently. Text format's escaping rules are small enough to implement
 * correctly and verify by test.
 *
 * The rollup upsert shares the transaction, so `logs` and `log_rollup_1m` can
 * never disagree: either both changes commit or neither does. That is what
 * removes the watermark, the raw-tail merge, and the recent-range fallback the
 * previous design needed to paper over a lagging rollup.
 *
 * Rows stream in 64 KB chunks rather than as one concatenated string, so a
 * 5000-row batch never materialises whole in a 256 MB process — and rather than
 * one row at a time, which profiling showed spends most of its time in socket
 * writes.
 */
export async function copyLogs(
  pool: pg.Pool,
  entries: readonly ValidLogEntry[],
): Promise<number> {
  if (entries.length === 0) {
    return 0;
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const stream = client.query(
      copyFrom(
        `COPY logs ("timestamp", level, service, message, attributes) FROM STDIN`,
      ),
    );

    const source = Readable.from(
      (function* () {
        let chunk = "";

        for (const entry of entries) {
          chunk += copyRow(entry);

          if (chunk.length >= COPY_CHUNK_BYTES) {
            yield chunk;
            chunk = "";
          }
        }

        if (chunk.length > 0) {
          yield chunk;
        }
      })(),
    );

    await pipeline(source, stream);

    await applyRollupDeltas(client, computeRollupDeltas(entries));

    await client.query("COMMIT");
    client.release();

    return entries.length;
  } catch (error) {
    // Destroy rather than return: a connection abandoned mid-COPY is left in a
    // protocol state the next borrower cannot recover from. ROLLBACK is
    // implicit in destroying the connection.
    client.release(error as Error);
    throw error;
  }
}

/**
 * Multi-row INSERT. Superseded by copyLogs on the ingestion path.
 *
 * Kept as a reference implementation. Note that it does not maintain the
 * rollup — `reconcile_log_rollup` would be needed after using it.
 */
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

  // limit + 1 detects whether another page exists without a second COUNT query.
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
