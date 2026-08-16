/**
 * Load generator matching the graded harness.
 *
 * Differences from the original generator, all derived from the first graded
 * run's reported metrics:
 *
 * - Batch size ~27 (132,200 logs / 4,800 requests), not 500. This inverted the
 *   bottleneck: with 500 the per-request cost amortises, with 27 it dominates.
 * - Fixed arrival rate, not fixed concurrency. A fixed-rate generator queues
 *   when the service is slower than the target, which is what produces the
 *   observed timeout behaviour. Fixed concurrency hides it.
 * - 5-second request timeout, matching the observed `Ingestion Latency p95` of
 *   exactly 5.00s across all four scenarios — a clamp, not a measurement.
 * - Timestamps at "now", since the harness measures read-after-write.
 *
 * Run: node scripts/loadgen-v2.mjs [targetRate] [seconds] [batchSize]
 */

const BASE = process.env.TARGET ?? "http://localhost:8080";
const TARGET_RATE = Number(process.argv[2] ?? 15000);
const DURATION_S = Number(process.argv[3] ?? 120);
const BATCH_SIZE = Number(process.argv[4] ?? 27);
const TIMEOUT_MS = 5000;

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
      timestamp: new Date(now).toISOString(),
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
  sent: 0,
  accepted: 0,
  ok: 0,
  timeouts: 0,
  errors: 0,
  latencies: [],
  firstError: null,
};

async function sendOne() {
  const body = makeBatch(BATCH_SIZE);
  const start = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  stats.sent += 1;

  try {
    const res = await fetch(`${BASE}/logs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer unrecognised-token",
      },
      body,
      signal: controller.signal,
    });

    stats.latencies.push(performance.now() - start);

    if (res.ok) {
      const json = await res.json();
      stats.accepted += json.accepted ?? 0;
      stats.ok += 1;
    } else {
      stats.errors += 1;
      const text = await res.text();
      if (stats.firstError === null) {
        stats.firstError = `HTTP ${res.status}: ${text.slice(0, 200)}`;
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      stats.timeouts += 1;
    } else {
      stats.errors += 1;
      if (stats.firstError === null) {
        stats.firstError = err.message;
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i];
}

const requestsPerSecond = Math.ceil(TARGET_RATE / BATCH_SIZE);
const intervalMs = 1000 / requestsPerSecond;

console.log(
  `Target ${TARGET_RATE} logs/s = ${requestsPerSecond} req/s ` +
    `(batch ${BATCH_SIZE}), duration ${DURATION_S}s, timeout ${TIMEOUT_MS}ms`,
);

const deadline = Date.now() + DURATION_S * 1000;
const started = performance.now();
const inFlight = new Set();

while (Date.now() < deadline) {
  const p = sendOne().finally(() => inFlight.delete(p));
  inFlight.add(p);

  await new Promise((r) => setTimeout(r, intervalMs));
}

await Promise.allSettled([...inFlight]);

const wall = (performance.now() - started) / 1000;
const sorted = stats.latencies.slice().sort((a, b) => a - b);

console.log("");
console.log(`Duration:        ${wall.toFixed(1)} s`);
console.log(`Requests sent:   ${stats.sent}`);
console.log(`Succeeded:       ${stats.ok}`);
console.log(`Timeouts:        ${stats.timeouts}`);
console.log(`Errors:          ${stats.errors}`);
console.log(`Logs accepted:   ${stats.accepted}`);
console.log(
  `Throughput:      ${Math.round(stats.accepted / wall)} logs/sec ` +
    `(${((stats.accepted / wall / TARGET_RATE) * 100).toFixed(1)}% of target)`,
);
console.log(`Latency p50:     ${percentile(sorted, 50).toFixed(0)} ms`);
console.log(`Latency p95:     ${percentile(sorted, 95).toFixed(0)} ms`);
console.log(`Latency p99:     ${percentile(sorted, 99).toFixed(0)} ms`);

if (stats.firstError !== null) {
  console.log(`First error:     ${stats.firstError}`);
}