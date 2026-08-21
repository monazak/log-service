/**
 * Differential check on the aggregation endpoint.
 *
 * `GET /logs/aggregate` answers almost entirely from the two rollup tables, and
 * the whole point of that routing is that it is invisible: the counts must equal
 * what a plain `count(*)` over `logs` would return for the same range. This
 * asserts exactly that, over randomised ranges chosen to straddle the boundaries
 * where the routing changes — mid-second, mid-minute, and spans shorter than one
 * bucket.
 *
 * Run it while ingestion is in flight. A rollup that is merely eventually
 * consistent passes on an idle database and fails here.
 *
 *   DATABASE_URL=postgres://logservice:logservice@127.0.0.1:55432/logs \
 *     node scripts/difftest.mjs
 */
import pg from "pg";

const BASE = process.env.TARGET ?? "http://localhost:8080";
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://logservice:logservice@127.0.0.1:55432/logs";

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });

/** Ground truth, straight from the raw table. */
async function truth(since, until, service) {
  const conditions = ['"timestamp" >= $1', '"timestamp" < $2'];
  const values = [since, until];

  if (service !== undefined) {
    conditions.push(`service = $${values.push(service)}`);
  }

  const { rows } = await pool.query(
    `SELECT count(*)::bigint AS n FROM logs WHERE ${conditions.join(" AND ")}`,
    values,
  );

  return Number(rows[0].n);
}

/** The endpoint's answer for the same range. */
async function api(since, until, bucket, service) {
  const params = new URLSearchParams({ since, until, bucket });
  if (service !== undefined) {
    params.set("service", service);
  }

  const response = await fetch(`${BASE}/logs/aggregate?${params}`);
  if (!response.ok) {
    return { error: response.status };
  }

  const body = await response.json();

  return { sum: body.buckets.reduce((total, b) => total + b.count, 0) };
}

// Widths chosen to exercise every branch: under a second, under a minute,
// spanning exactly one boundary, and spanning many.
const WIDTHS_MS = [1_500, 7_000, 45_000, 61_000, 137_000, 600_000, 3_600_000];
const BUCKETS = ["1m", "5m", "1h"];

const now = Date.now();
const cases = [];

for (let i = 0; i < 24; i += 1) {
  const until = new Date(now - Math.floor(Math.random() * 90_000));
  const since = new Date(until.getTime() - WIDTHS_MS[i % WIDTHS_MS.length]);

  cases.push({
    since: since.toISOString(),
    until: until.toISOString(),
    bucket: BUCKETS[i % BUCKETS.length],
    ...(i % 4 === 0 ? { service: "checkout" } : {}),
  });
}

let mismatches = 0;

for (const c of cases) {
  const [expected, actual] = await Promise.all([
    truth(c.since, c.until, c.service),
    api(c.since, c.until, c.bucket, c.service),
  ]);

  if (actual.sum !== expected) {
    mismatches += 1;
    console.log(
      `MISMATCH bucket=${c.bucket}${c.service ? ` service=${c.service}` : ""} ` +
        `${c.since} -> ${c.until}: endpoint=${actual.sum ?? `HTTP ${actual.error}`} raw=${expected}`,
    );
  }
}

await pool.end();

console.log(
  mismatches === 0
    ? `all ${cases.length} ranges match the raw table exactly`
    : `${mismatches} of ${cases.length} ranges disagree`,
);

process.exit(mismatches === 0 ? 0 : 1);
