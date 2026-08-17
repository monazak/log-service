/**
 * In-process operational counters.
 *
 * Deliberately not a metrics library. The counters are plain integers updated
 * on the request path, and the cost of incrementing one is nothing against the
 * work of parsing a batch — which is what lets this be always-on rather than a
 * flag.
 *
 * Everything here is process-local and resets on restart. That is the honest
 * scope: this answers "what is this instance doing right now", not "what did
 * the system do last week". A durable answer to the second question is what
 * `logs` itself is for.
 *
 * Latency is tracked as a fixed-size ring rather than a full histogram. A
 * thousand samples is enough for a stable p95 at these rates and costs a
 * constant 8 KB, where an unbounded array would grow with traffic — the exact
 * failure mode the bounded ingestion queue exists to avoid elsewhere.
 */

const LATENCY_SAMPLES = 1000;

interface Ring {
  readonly values: Float64Array;
  index: number;
  count: number;
}

function createRing(): Ring {
  return { values: new Float64Array(LATENCY_SAMPLES), index: 0, count: 0 };
}

function record(ring: Ring, value: number): void {
  ring.values[ring.index] = value;
  ring.index = (ring.index + 1) % LATENCY_SAMPLES;
  ring.count = Math.min(ring.count + 1, LATENCY_SAMPLES);
}

function percentile(ring: Ring, p: number): number {
  if (ring.count === 0) {
    return 0;
  }

  const sorted = Array.from(ring.values.slice(0, ring.count)).sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p));

  return Math.round(sorted[index] ?? 0);
}

const startedAt = Date.now();

const counters = {
  logsAccepted: 0,
  logsRejected: 0,
  ingestRequests: 0,
  ingestErrors: 0,
  queryRequests: 0,
  aggregateRequests: 0,
  aggregateFromRollup: 0,
  aggregateFromRaw: 0,
};

const ingestLatency = createRing();
const queryLatency = createRing();
const aggregateLatency = createRing();

export function recordIngest(
  accepted: number,
  rejected: number,
  durationMs: number,
): void {
  counters.ingestRequests += 1;
  counters.logsAccepted += accepted;
  counters.logsRejected += rejected;
  record(ingestLatency, durationMs);
}

export function recordIngestError(): void {
  counters.ingestErrors += 1;
}

export function recordQuery(durationMs: number): void {
  counters.queryRequests += 1;
  record(queryLatency, durationMs);
}

export function recordAggregate(usedRollup: boolean, durationMs: number): void {
  counters.aggregateRequests += 1;

  if (usedRollup) {
    counters.aggregateFromRollup += 1;
  } else {
    counters.aggregateFromRaw += 1;
  }

  record(aggregateLatency, durationMs);
}

export interface MetricsSnapshot {
  readonly uptime_seconds: number;
  readonly ingestion: {
    readonly requests: number;
    readonly logs_accepted: number;
    readonly logs_rejected: number;
    readonly errors: number;
    readonly logs_per_second: number;
    readonly latency_ms: { p50: number; p95: number; p99: number };
  };
  readonly queries: {
    readonly requests: number;
    readonly latency_ms: { p50: number; p95: number; p99: number };
  };
  readonly aggregations: {
    readonly requests: number;
    readonly served_from_rollup: number;
    readonly served_from_raw: number;
    readonly latency_ms: { p50: number; p95: number; p99: number };
  };
  readonly memory: {
    readonly heap_used_mb: number;
    readonly rss_mb: number;
  };
}

export function snapshot(): MetricsSnapshot {
  const uptimeSeconds = (Date.now() - startedAt) / 1000;
  const memory = process.memoryUsage();

  const toMb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;

  return {
    uptime_seconds: Math.round(uptimeSeconds),

    ingestion: {
      requests: counters.ingestRequests,
      logs_accepted: counters.logsAccepted,
      logs_rejected: counters.logsRejected,
      errors: counters.ingestErrors,
      // Average since start, not a windowed rate: a windowed rate needs a
      // second timer, and this is enough to see whether ingestion is moving.
      logs_per_second:
        uptimeSeconds > 0 ? Math.round(counters.logsAccepted / uptimeSeconds) : 0,
      latency_ms: {
        p50: percentile(ingestLatency, 0.5),
        p95: percentile(ingestLatency, 0.95),
        p99: percentile(ingestLatency, 0.99),
      },
    },

    queries: {
      requests: counters.queryRequests,
      latency_ms: {
        p50: percentile(queryLatency, 0.5),
        p95: percentile(queryLatency, 0.95),
        p99: percentile(queryLatency, 0.99),
      },
    },

    aggregations: {
      requests: counters.aggregateRequests,
      served_from_rollup: counters.aggregateFromRollup,
      served_from_raw: counters.aggregateFromRaw,
      latency_ms: {
        p50: percentile(aggregateLatency, 0.5),
        p95: percentile(aggregateLatency, 0.95),
        p99: percentile(aggregateLatency, 0.99),
      },
    },

    memory: {
      heap_used_mb: toMb(memory.heapUsed),
      rss_mb: toMb(memory.rss),
    },
  };
}
