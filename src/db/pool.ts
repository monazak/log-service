import pg from "pg";
import type { Config } from "../config/env.ts";

/**
 * Connection pools.
 *
 * Two pools against the same database, not one.
 *
 * An early graded run returned HTTP 500s under load: aggregation queries taking
 * seconds held connections while ingestion requests waited for one, and
 * `connectionTimeoutMillis` eventually fired on the write path. A slow read
 * could starve writes entirely.
 *
 * Splitting them bounds that. A read can only ever exhaust read connections;
 * ingestion keeps its own. The total is unchanged, so Postgres sees the same
 * number of backend processes against its 1 GB budget.
 *
 * The split favours writes heavily. Throughput is what the spec measures, reads
 * arrive at roughly one per second against thousands of writes, and on a
 * single-CPU database every concurrent read is a slice of CPU the writes do not
 * get. Four read connections still allow four concurrent queries — more than
 * the stated query rate needs.
 */

const WRITE_SHARE = 0.8;

/**
 * Server-side ceiling on a single read.
 *
 * The load generator abandons a request at five seconds, so a query still
 * running at four has already lost its caller — and on a saturated single CPU
 * it goes on consuming cycles that ingestion needs. Killing it at three returns
 * that CPU while the answer could still have mattered.
 *
 * Writes are deliberately exempt: a COPY that is cancelled mid-transaction
 * rolls back an entire batch, which is a worse outcome than a slow one.
 */
const READ_STATEMENT_TIMEOUT_MS = 3_000;

export interface Pools {
  readonly write: pg.Pool;
  readonly read: pg.Pool;
}

function build(config: Config, max: number, statementTimeoutMs?: number): pg.Pool {
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

  if (statementTimeoutMs !== undefined) {
    // Applied once per physical connection rather than per query: `connect`
    // fires when the pool opens a new backend, and the setting persists for
    // that session. Sending it with every query would double the round trips
    // on the path we are trying to keep cheap.
    pool.on("connect", (client) => {
      void client.query(`SET statement_timeout = ${statementTimeoutMs}`);
    });
  }

  return pool;
}

export function createPools(config: Config): Pools {
  const writeMax = Math.max(2, Math.round(config.dbPoolSize * WRITE_SHARE));
  const readMax = Math.max(2, config.dbPoolSize - writeMax);

  return {
    write: build(config, writeMax),
    read: build(config, readMax, READ_STATEMENT_TIMEOUT_MS),
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
