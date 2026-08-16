import type pg from "pg";

/**
 * Readiness state for GET /health.
 *
 * The load generator polls this endpoint continuously and starts sending
 * sustained load the moment it sees a 200, so the answer must be both honest
 * and cheap. Honest: a live database check, because a stale in-memory flag
 * would keep reporting healthy after the database dropped. Cheap: results are
 * cached for a few seconds, because querying on every poll would compete with
 * ingestion for the same connection pool.
 */

const CACHE_TTL_MS = 5_000;

let startupComplete = false;
let lastCheckAt = 0;
let lastCheckHealthy = false;
let inFlight: Promise<boolean> | undefined;

export function markReady(): void {
  startupComplete = true;
}

export function markNotReady(): void {
  startupComplete = false;
}

export interface ReadinessState {
  readonly ready: boolean;
  readonly reason?: string;
}

async function probe(pool: pg.Pool): Promise<boolean> {
  try {
    const client = await pool.connect();
    try {
      await client.query("SELECT 1");
      return true;
    } finally {
      client.release();
    }
  } catch {
    return false;
  }
}

export async function checkReadiness(pool: pg.Pool): Promise<ReadinessState> {
  if (!startupComplete) {
    return { ready: false, reason: "starting" };
  }

  const now = Date.now();

  if (now - lastCheckAt < CACHE_TTL_MS) {
    return lastCheckHealthy
      ? { ready: true }
      : { ready: false, reason: "database unavailable" };
  }

  // A probe can take up to connectionTimeoutMillis when the database is down.
  // Two details matter during that window:
  //
  // Sharing one in-flight promise means concurrent polls wait on a single
  // probe rather than each consuming a pool slot — otherwise a database outage
  // fills the pool with health checks, which is what the cache exists to avoid.
  //
  // Stamping lastCheckAt on completion rather than on start means the cache
  // window begins when the answer is known. Stamping it first would let polls
  // during a slow probe read the previous result, reporting healthy for seconds
  // after the database had already gone.
  inFlight ??= probe(pool).finally(() => {
    lastCheckAt = Date.now();
    inFlight = undefined;
  });

  lastCheckHealthy = await inFlight;

  return lastCheckHealthy
    ? { ready: true }
    : { ready: false, reason: "database unavailable" };
}

export function isReady(): boolean {
  return startupComplete;
}
