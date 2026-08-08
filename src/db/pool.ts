import pg from "pg";
import type { Config } from "../config/env.ts";

const { Pool } = pg;

/**
 * Creates the PostgreSQL connection pool.
 *
 * Pool size is deliberately small. Postgres runs one OS process per connection,
 * and the database container is limited to 1 CPU and 1 GB. Oversized pools cause
 * memory pressure and context-switch thrashing, reducing throughput rather than
 * increasing it.
 */
export function createPool(config: Config): pg.Pool {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolSize,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: "log-service",
  });
  pool.on("error", () => {});
  return pool;
}

/**
 * Verifies the database is reachable before the service reports ready.
 */
export async function verifyConnection(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
  } finally {
    client.release();
  }
}
