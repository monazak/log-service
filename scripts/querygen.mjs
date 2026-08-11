/**
 * Query load generator — runs alongside ingestion.
 *
 * The spec requires aggregation to stay under 1s at p95 *while* ingestion is
 * running. Measuring the two separately does not prove that: both compete for
 * the same single database CPU.
 *
 * Sends one aggregate request per second, matching the spec's stated rate.
 *
 * Run: node scripts/querygen.mjs [seconds]
 */

const BASE = process.env.TARGET ?? "http://localhost:8080";
const DURATION_S = Number(process.argv[2] ?? 30);
const INTERVAL_MS = 1000;

const latencies = [];
let errors = 0;
let buckets = 0;

function aggregateUrl() {
  const until = new Date();
  const since = new Date(until.getTime() - 7 * 24 * 60 * 60 * 1000);

  const params = new URLSearchParams({
    since: since.toISOString(),
    until: until.toISOString(),
    bucket: "1h",
  });

  return `${BASE}/logs/aggregate?${params.toString()}`;
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

console.log(`Querying for ${DURATION_S}s — 1 aggregate/sec, 7-day range, 1h buckets`);

while (Date.now() < deadline) {
  const start = performance.now();

  try {
    const res = await fetch(aggregateUrl());
    const elapsed = performance.now() - start;

    if (res.ok) {
      const json = await res.json();
      latencies.push(elapsed);
      buckets += json.buckets?.length ?? 0;
    } else {
      errors += 1;
      await res.text();
    }
  } catch {
    errors += 1;
  }

  const remaining = INTERVAL_MS - (performance.now() - start);
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

const sorted = latencies.slice().sort((a, b) => a - b);

console.log("");
console.log(`Requests:      ${latencies.length}`);
console.log(`Errors:        ${errors}`);
console.log(`Buckets/req:   ${Math.round(buckets / Math.max(1, latencies.length))}`);
console.log(`Latency p50:   ${percentile(sorted, 50).toFixed(1)} ms`);
console.log(`Latency p95:   ${percentile(sorted, 95).toFixed(1)} ms`);
console.log(`Latency p99:   ${percentile(sorted, 99).toFixed(1)} ms`);
console.log(`Latency max:   ${sorted[sorted.length - 1]?.toFixed(1) ?? 0} ms`);