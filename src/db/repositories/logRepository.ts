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
import { secondRollupFrom } from "../rollupWindow.ts";

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

/** Floors a timestamp to a bucket width, in epoch milliseconds. */
function floorTo(timestamp: Date, widthMs: number): number {
  return Math.floor(timestamp.getTime() / widthMs) * widthMs;
}

const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;

interface RollupDelta {
  readonly bucket: Date;
  readonly service: string;
  readonly level: string;
  count: number;
}

/**
 * Counts a batch by (second, service, level).
 *
 * A batch of several thousand entries collapses to at most
 * (seconds x services x levels) rows, and a flush spans well under a second, so
 * in practice that is around twenty. That is the whole point: the rollup update
 * becomes proportional to the batch's *cardinality* rather than its size, and
 * independent of how much data is already stored.
 *
 * Seconds rather than minutes because the aggregate query reads this grain for
 * the partial minute at each end of a range — see migration 021. Minute
 * counters are folded out of these rather than accumulated separately, since
 * folding twenty rows is cheaper than walking five thousand entries twice.
 */
function computeSecondDeltas(entries: readonly ValidLogEntry[]): RollupDelta[] {
  const counts = new Map<string, RollupDelta>();

  for (const entry of entries) {
    const bucketMs = floorTo(entry.timestamp, SECOND_MS);
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

/** Folds per-second counters into per-minute counters. */
function foldToMinutes(seconds: readonly RollupDelta[]): RollupDelta[] {
  const counts = new Map<string, RollupDelta>();

  for (const delta of seconds) {
    const bucketMs = floorTo(delta.bucket, MINUTE_MS);
    const key = `${bucketMs}\u0000${delta.service}\u0000${delta.level}`;

    const existing = counts.get(key);

    if (existing === undefined) {
      counts.set(key, {
        bucket: new Date(bucketMs),
        service: delta.service,
        level: delta.level,
        count: delta.count,
      });
    } else {
      existing.count += delta.count;
    }
  }

  return [...counts.values()];
}

/**
 * Applies a batch's counters to one rollup table.
 *
 * `ON CONFLICT ... DO UPDATE SET count = count + EXCLUDED.count` is what makes
 * this incremental: concurrent batches touching the same bucket serialise on
 * the row and add rather than overwrite.
 *
 * `ORDER BY` inside the statement is what keeps them from deadlocking instead.
 * Two transactions that lock the same rows in opposite orders deadlock, and
 * sorting in JavaScript is not enough to prevent it: `localeCompare` does not
 * order strings the way the database's collation does, so two batches could
 * still disagree. Ordering in SQL hands the decision to Postgres, which applies
 * one collation to both.
 *
 * The counters arrive as four parallel arrays through `unnest` rather than as a
 * VALUES list, because that keeps the SQL text identical from one flush to the
 * next however many buckets a batch touched. A named statement with constant
 * text is parsed and planned once per connection and executed thereafter, which
 * matters here: the flush interval is short by design, so this runs hundreds of
 * times a second and its fixed cost is most of its cost.
 *
 * The table name is a literal chosen by the caller from the two below, never a
 * value derived from a request.
 */
async function applyRollupDeltas(
  client: pg.PoolClient,
  table: "log_rollup_1s" | "log_rollup_1m",
  deltas: readonly RollupDelta[],
): Promise<void> {
  if (deltas.length === 0) {
    return;
  }

  const buckets: Date[] = [];
  const services: string[] = [];
  const levels: string[] = [];
  const counts: number[] = [];

  for (const delta of deltas) {
    buckets.push(delta.bucket);
    services.push(delta.service);
    levels.push(delta.level);
    counts.push(delta.count);
  }

  await client.query(
    {
      name: `upsert_${table}`,
      text: `
      INSERT INTO ${table} (bucket, service, level, count)
      SELECT bucket, service, level, count
      FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::bigint[])
        AS batch (bucket, service, level, count)
      ORDER BY bucket, service, level
      ON CONFLICT (bucket, service, level)
      DO UPDATE SET count = ${table}.count + EXCLUDED.count
    `,
    },
    [buckets, services, levels, counts],
  );
}

/** Postgres reports a deadlock victim with SQLSTATE 40P01. */
const DEADLOCK = "40P01";

function isDeadlock(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === DEADLOCK
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
async function copyLogsOnce(
  pool: pg.Pool,
  entries: readonly ValidLogEntry[],
): Promise<number> {
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

    // Second counters first, then the minutes folded out of them. Both tables
    // are always written in this order, so two concurrent flushes queue behind
    // each other rather than each holding what the other needs next.
    const secondDeltas = computeSecondDeltas(entries);
    await applyRollupDeltas(client, "log_rollup_1s", secondDeltas);
    await applyRollupDeltas(client, "log_rollup_1m", foldToMinutes(secondDeltas));

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
 * Writes a batch, retrying if the rollup upsert is chosen as a deadlock victim.
 *
 * Ordering the upserts makes a deadlock unlikely, not impossible: Postgres also
 * takes speculative locks on keys that do not exist yet, and two batches
 * inserting the same new bucket can still cross. A deadlock is by definition
 * transient — the other transaction has already been allowed to finish — so the
 * work is simply redone.
 *
 * Retrying is safe because nothing was committed. The COPY and both upserts
 * share one transaction, so the victim's rows are gone from `logs` and from
 * both rollups before the retry starts, and no entry can be counted twice.
 *
 * The caller is still waiting on this promise, so a retry costs latency on one
 * batch rather than a rejected write. Two attempts is enough for contention
 * this narrow; past that, the error is real and the batch is failed honestly.
 */
const MAX_WRITE_ATTEMPTS = 3;

export async function copyLogs(
  pool: pg.Pool,
  entries: readonly ValidLogEntry[],
): Promise<number> {
  if (entries.length === 0) {
    return 0;
  }

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await copyLogsOnce(pool, entries);
    } catch (error) {
      if (attempt >= MAX_WRITE_ATTEMPTS || !isDeadlock(error)) {
        throw error;
      }
    }
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

/**
 * Time windows tried, newest first, before giving up on the ordered index scan.
 *
 * Only used for filters no index can order by. See `queryLogs`.
 */
const STAGED_WINDOWS_MS = [60 * 60 * 1000, 24 * 60 * 60 * 1000];

/** One page of `logs`, optionally floored in time or planned behind a fence. */
async function queryPage(
  pool: pg.Pool,
  filters: LogFilters,
  cursor: CursorPosition | undefined,
  floor: Date | undefined,
  fenced: boolean,
): Promise<LogRow[]> {
  const scoped = floor === undefined ? filters : { ...filters, since: floor };
  const where = buildWhereClause(scoped, cursor);

  // limit + 1 detects whether another page exists without a second COUNT query.
  const limitPlaceholder = `$${where.values.length + 1}`;

  // `OFFSET 0` blocks subquery pull-up, which is the whole point: it stops the
  // planner from satisfying the ORDER BY with a backward index scan and forces
  // it to select rows by the filter first — a bitmap scan over the GIN or
  // trigram index — and sort the few that match.
  const sql = fenced
    ? `
    SELECT * FROM (
      SELECT id, "timestamp", level, service, message, attributes
      FROM logs
      ${where.sql}
      OFFSET 0
    ) matched
    ORDER BY "timestamp" DESC, id DESC
    LIMIT ${limitPlaceholder}
  `
    : `
    SELECT id, "timestamp", level, service, message, attributes
    FROM logs
    ${where.sql}
    ORDER BY "timestamp" DESC, id DESC
    LIMIT ${limitPlaceholder}
  `;

  const result = await pool.query<LogRow>(sql, [...where.values, filters.limit + 1]);

  return result.rows;
}

/**
 * Reads one page of logs, newest first.
 *
 * Most filters are served directly: `service`, `level`, and time ranges all
 * narrow the same index the ORDER BY walks, so Postgres reads rows in order and
 * stops at the limit.
 *
 * `attr.<key>` and `q` are the two that cannot be. Neither the GIN index on
 * attributes nor the trigram index on messages carries any ordering, so the
 * planner has a choice: select by the filter and sort what matches, or walk the
 * time index backwards and test each row. It estimates `@>` and `ILIKE` at a
 * flat fraction of the table regardless of the value, so for a selective filter
 * it takes the second option expecting to fill the limit within a few thousand
 * rows — and then walks every row in the table instead. Measured: a filter
 * matching one row of three million took 3 s and hit the statement timeout,
 * which the caller sees as a 500.
 *
 * So those two are staged. Each window is tried newest-first with the ordinary
 * plan, and a window that fills the page is the answer — everything excluded is
 * strictly older than everything returned, which is exactly what the ordering
 * asks. A broad filter fills the first window immediately and pays a bounded
 * scan for it.
 *
 * Reaching the end of the windows is itself the evidence that the filter is
 * selective: nothing matched across a whole day. Only then is the full range
 * planned behind a fence, where sorting the matches is the cheap option
 * precisely because there are so few of them.
 */
export async function queryLogs(
  pool: pg.Pool,
  filters: LogFilters,
  cursor?: CursorPosition,
): Promise<{ rows: LogRow[]; hasMore: boolean }> {
  const page = (rows: LogRow[]): { rows: LogRow[]; hasMore: boolean } => {
    const hasMore = rows.length > filters.limit;

    return { rows: hasMore ? rows.slice(0, filters.limit) : rows, hasMore };
  };

  const unordered =
    filters.q !== undefined || Object.keys(filters.attributes).length > 0;

  if (!unordered) {
    return page(await queryPage(pool, filters, cursor, undefined, false));
  }

  // Newest row the page could contain: the cursor if paginating, else `until`.
  const upper = cursor?.timestamp ?? filters.until ?? new Date();

  for (const window of STAGED_WINDOWS_MS) {
    const floor = new Date(upper.getTime() - window);

    // The caller's own lower bound is already inside this window, so the
    // window is the whole range and there is nothing left to widen to.
    if (filters.since !== undefined && floor <= filters.since) {
      break;
    }

    const rows = await queryPage(pool, filters, cursor, floor, false);

    if (rows.length > filters.limit) {
      return page(rows);
    }
  }

  return page(await queryPage(pool, filters, cursor, undefined, true));
}

export async function aggregateLogs(
  pool: pg.Pool,
  params: AggregateParams,
): Promise<AggregateRow[]> {
  const query = canUseRollup(params)
    ? buildRollupAggregateQuery(params, secondRollupFrom())
    : buildAggregateQuery(params);

  const result = await pool.query<AggregateRow>(query.sql, query.values);

  return result.rows;
}
