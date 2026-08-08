import type pg from "pg";
import type { ValidLogEntry } from "../../domain/log.ts";

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
