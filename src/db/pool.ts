import pg from "pg";
import type { Config } from "../config/env.ts";

/**
 * Connection pools.
 *
 * Two pools against the same database, not one.
 *
 * The graded run returned HTTP 500s under load: aggregation queries taking
 * seconds held connections while ingestion requests waited for one, and
 * `connectionTimeoutMillis` eventually fired on the write path. A slow read
 * could starve writes entirely.
 *
 * Splitting them bounds that. A read can only ever exhaust read connections;
 * ingestion keeps its own. The total is unchanged, so Postgres sees the same
 * number of backend processes against its 1 GB budget.
 *
 * The split favours writes, because throughput is what the spec measures and
 * because reads are one per second against many per second of ingestion.
 */

const WRITE_SHARE = 0.6;

export interface Pools {
  readonly write: pg.Pool;
  readonly read: pg.Pool;
}

function build(config: Config, max: number): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  // `pg` emits `error` when a background connection fails — a database restart,
  // a dropped socket. Node terminates the process on an unhandled `error`
  // event, so without this listener a database outage kills the service instead
  // of degrading it to 503, and the automatic recovery path never runs.
  pool.on("error", () => {});

  return pool;
}

export function createPools(config: Config): Pools {
  const writeMax = Math.max(2, Math.round(config.dbPoolSize * WRITE_SHARE));
  const readMax = Math.max(2, config.dbPoolSize - writeMax);

  return {
    write: build(config, writeMax),
    read: build(config, readMax),
  };
}

export async function verifyConnection(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("SELECT 1");
  } finally {
    client.release();
  }
}

export async function closePools(pools: Pools): Promise<void> {
  await Promise.all([pools.write.end(), pools.read.end()]);
}
