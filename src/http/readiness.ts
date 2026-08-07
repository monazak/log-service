let ready = false;

export function markReady(): void {
  ready = true;
}

export function markNotReady(): void {
  ready = false;
}

export function isReady(): boolean {
  return ready;
}

/**
 * Tracks whether the service is ready to accept traffic.
 *
 * The load generator polls GET /health and starts sending logs as soon as it
 * sees a 200. Reporting ready before the database is usable means ingestion
 * fails under the opening burst, so this flag is only set once startup is
 * genuinely complete.
 */
