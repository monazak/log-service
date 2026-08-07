import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const MIGRATION_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

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
            CREATE table IF NOT EXISTS schema_migrations(
                version TEXT PRIMARY KEY,
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
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [
          file,
        ]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (error) {
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
