import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

/**
 * Migration runner.
 *
 * Numbered .sql files applied in filename order, each in its own transaction,
 * before the service reports healthy.
 *
 * Off-the-shelf tools were rejected because daily partition creation needs
 * dynamic DDL they model poorly, and because every line has to be explicable.
 *
 * Resolved relative to this module, so it finds src/db/migrations in the dev
 * loop and dist/db/migrations in production. tsc does not copy .sql files —
 * the build script does that explicitly.
 */
const MIGRATION_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Arbitrary but fixed. Two containers starting at once would otherwise both see
 * an empty schema_migrations table and both try to apply the same file.
 * Advisory locks are session-scoped, so this is held on one dedicated client
 * for the whole run and released even if the connection dies.
 */
const MIGRATION_LOCK_ID = 4_819_233_017;

export interface MigrationResult {
  readonly applied: string[];
  readonly skipped: number;
}

export async function runMigrations(pool: pg.Pool): Promise<MigrationResult> {
  const files = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ version: string }>(
      "SELECT version FROM schema_migrations",
    );
    const done = new Set(rows.map((row) => row.version));

    const applied: string[] = [];

    for (const file of files) {
      if (done.has(file)) {
        continue;
      }

      const sql = await readFile(join(MIGRATION_DIR, file), "utf8");

      await client.query("BEGIN");

      try {
        // The server sets statement_timeout for query safety, but a migration
        // that rewrites a large table legitimately exceeds it — and being
        // cancelled turns a slow migration into a failed boot. SET LOCAL
        // reverts at COMMIT, so this does not leak into the session.
        await client.query("SET LOCAL statement_timeout = 0");

        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [
          file,
        ]);
        await client.query("COMMIT");

        applied.push(file);
      } catch (error) {
        // Per-file transaction: a failure leaves no partial schema and no
        // recorded version, so the next start retries this file cleanly.
        await client.query("ROLLBACK");
        throw new Error(`Migration failed: ${file}`, { cause: error });
      }
    }

    return { applied, skipped: files.length - applied.length };
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID])
      .catch(() => {});
    client.release();
  }
}

export async function ensurePartitions(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ ensure_log_partitions: number }>(
    "SELECT ensure_log_partitions($1)",
    [3],
  );

  return rows[0]?.ensure_log_partitions ?? 0;
}
