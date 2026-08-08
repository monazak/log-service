import type pg from "pg";

/**
 * Readiness state for GET /health.
 *
 * The load generator polls this endpoint continuously and starts sending 15k
 * logs/sec the moment it sees a 200, so the answer must be both honest and
 * cheap. Honest: a live database check, because a stale in-memory flag would
 * keep reporting healthy after the database dropped. Cheap: results are cached
 * for a few seconds, because querying on every poll would compete with
 * ingestion for the same small connection pool.
 */

const CACHE_TTL_MS = 5_000;

let startupComplete = false;
let lastCheckAt = 0;
let lastCheckHealthy = false;

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

export async function checkReadiness(pool: pg.Pool): Promise<ReadinessState> {
  if (!startupComplete) {
    return {
      ready: false,
      reason: "starting",
    };
  }
  const now = Date.now();

  if (now - lastCheckAt < CACHE_TTL_MS) {
    return lastCheckHealthy
      ? { ready: true }
      : { ready: false, reason: "database unavailable" };
  }

  lastCheckAt = now;
  try {
    const client = await pool.connect();
    try {
      await client.query("SELECT 1");
      lastCheckHealthy = true;
      return { ready: true };
    } finally {
      client.release();
    }
  } catch {
    lastCheckHealthy = false;
    return { ready: false, reason: "database unavailable" };
  }
}

export function isReady(): boolean {
  return startupComplete;
}
