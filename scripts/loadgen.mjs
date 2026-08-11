/**
 * Ingestion load generator.
 *
 * Sends batches to POST /logs over HTTP, which is the path the grader measures.
 * Maintains a fixed number of in-flight requests rather than a fixed rate, so
 * throughput is bounded by the service rather than by the generator.
 *
 * Run: node scripts/loadgen.mjs [seconds] [batchSize] [concurrency]
 */

const URL = process.env.TARGET ?? "http://localhost:8080/logs";
const DURATION_S = Number(process.argv[2] ?? 30);
const BATCH_SIZE = Number(process.argv[3] ?? 500);
const CONCURRENCY = Number(process.argv[4] ?? 8);

const SERVICES = ["checkout", "api", "auth", "payments", "search"];
const LEVELS = ["debug", "info", "info", "info", "warn", "error"];
const MESSAGES = [
  "request completed",
  "payment declined",
  "user logged in",
  "cache miss",
  "connection timeout",
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function makeBatch(size) {
  const logs = new Array(size);
  const now = Date.now();

  for (let i = 0; i < size; i += 1) {
    logs[i] = {
      timestamp: new Date(now - Math.floor(Math.random() * 86_400_000)).toISOString(),
      level: pick(LEVELS),
      service: pick(SERVICES),
      message: `${pick(MESSAGES)} ${Math.floor(Math.random() * 1e6)}`,
      attributes: {
        user_id: String(Math.floor(Math.random() * 10000)),
        region: pick(["eu-west", "us-east", "ap-south"]),
      },
    };
  }

  return JSON.stringify({ logs });
}

const stats = {
  accepted: 0,
  requests: 0,
  errors: 0,
  latencies: [],
};

async function worker(deadline) {
  while (Date.now() < deadline) {
    const body = makeBatch(BATCH_SIZE);
    const start = performance.now();

    try {
      const res = await fetch(URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });

      const elapsed = performance.now() - start;
      stats.latencies.push(elapsed);
      stats.requests += 1;

      if (res.ok) {
        const json = await res.json();
        stats.accepted += json.accepted ?? 0;
      } else {
        stats.errors += 1;
        await res.text();
      }
    } catch {
      stats.errors += 1;
    }
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[index];
}

const deadline = Date.now() + DURATION_S * 1000;
const started = performance.now();

console.log(
  `Ingesting for ${DURATION_S}s — batch=${BATCH_SIZE}, concurrency=${CONCURRENCY}`,
);

await Promise.all(
  Array.from({ length: CONCURRENCY }, () => worker(deadline)),
);

const wallSeconds = (performance.now() - started) / 1000;
const sorted = stats.latencies.slice().sort((a, b) => a - b);

console.log("");
console.log(`Duration:        ${wallSeconds.toFixed(1)} s`);
console.log(`Requests:        ${stats.requests}`);
console.log(`Errors:          ${stats.errors}`);
console.log(`Logs accepted:   ${stats.accepted}`);
console.log(
  `Throughput:      ${Math.round(stats.accepted / wallSeconds)} logs/sec`,
);
console.log(`Latency p50:     ${percentile(sorted, 50).toFixed(1)} ms`);
console.log(`Latency p95:     ${percentile(sorted, 95).toFixed(1)} ms`);
console.log(`Latency p99:     ${percentile(sorted, 99).toFixed(1)} ms`);