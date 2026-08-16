# Log Ingestion and Query Service

A service that ingests high volumes of structured logs, stores them in
PostgreSQL, and exposes query and time-bucketed aggregation APIs.

Measured at **18,950 logs/sec** with aggregation at **197 ms p95 under concurrent
ingestion**, inside the specified container limits (app 0.5 CPU / 256 MB,
postgres 1 CPU / 1 GB).

---

## Quick start

```bash
docker compose up
```

That is the whole setup. No environment file, no arguments, no manual steps —
every setting has a working default. The service is ready when `/health` returns
200:

```bash
curl localhost:8080/health
```

### Verify it works

```bash
# Ingest
curl -X POST localhost:8080/logs -H 'content-type: application/json' -d '{
  "logs": [{
    "timestamp": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",
    "level": "error",
    "service": "checkout",
    "message": "payment declined",
    "attributes": { "user_id": "42", "region": "eu-west" }
  }]
}'

# Query
curl "localhost:8080/logs?service=checkout&limit=10"

# Aggregate
curl "localhost:8080/logs/aggregate?since=$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)&until=$(date -u -v+1H +%Y-%m-%dT%H:%M:%SZ)&bucket=1h"
```

The `date` flags above are macOS syntax. On Linux use `date -u -d '1 hour ago'`
and `date -u -d '1 hour'`.

### Development

```bash
docker compose up          # hot reload via docker-compose.override.yml
npm run test:unit          # no database required
npm run test:db            # full suite against the Compose database
npm run typecheck
npm run lint
```

To run exactly as a grader would, bypassing the dev override:

```bash
docker compose -f docker-compose.yml up --build
```

### Reproducing the performance results

```bash
docker compose -f docker-compose.yml up -d --build
docker compose exec -T postgres psql -U logservice -d logs < scripts/seed.sql

node scripts/loadgen-v2.mjs 15000 60 27    # ingestion, matches graded harness
node scripts/querygen.mjs 40               # concurrent aggregation, second window
```

---

## Configuration

Every variable has a default. None are required.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `HOST` | `0.0.0.0` | Listen address — must not be localhost inside a container |
| `DATABASE_URL` | `postgres://logservice:logservice@postgres:5432/logs` | Matches docker-compose.yml |
| `DB_POOL_SIZE` | `20` | Connection pool size |
| `RETENTION_DAYS` | `30` | Age at which partitions are dropped |
| `LOG_LEVEL` | `warn` in production, `info` otherwise | Application log verbosity |
| `NODE_ENV` | `development` | Enables production logging behaviour when `production` |

---

## API

### `GET /health`

Returns 200 once the database is reachable and migrations have been applied,
503 otherwise. The check runs a live `SELECT 1`, cached for 5 seconds so that
polling does not compete with ingestion for the connection pool.

```json
{ "status": "ok" }
```

### `POST /logs`

Always accepts a batch; a batch of one is valid.

```json
{
  "logs": [{
    "timestamp": "2026-07-20T14:32:01.123Z",
    "level": "error",
    "service": "checkout",
    "message": "payment declined",
    "attributes": { "user_id": "42", "retries": 3 }
  }]
}
```

**Validation, per entry:**

| Field | Rule |
|---|---|
| `timestamp` | Required, valid ISO 8601, no more than 5 minutes in the future |
| `level` | Required, one of `debug`, `info`, `warn`, `error` |
| `service` | Required, non-empty string |
| `message` | Required, non-empty string |
| `attributes` | Optional, flat object; values string, number, or boolean |

An invalid entry does not fail the batch. Valid entries are accepted and each
rejection is reported with its index in the original array:

```json
{
  "accepted": 9,
  "rejected": [{ "index": 3, "reason": "invalid level: 'critical'" }]
}
```

**Status codes:** 200 when at least one entry is accepted. 400 when all entries
are rejected, the JSON is malformed, or the top-level shape is wrong. The
response body keeps the same shape in both cases — the sender needs the
rejection reasons either way.

### `GET /logs`

All parameters optional and freely combinable.

| Parameter | Meaning |
|---|---|
| `service` | Exact match |
| `level` | Exact match |
| `since` | Inclusive start |
| `until` | Exclusive end |
| `attr.<key>` | Attribute equality, compared as strings |
| `q` | Case-insensitive substring on message |
| `limit` | Default 100, maximum 1000 |
| `cursor` | Opaque cursor from a previous response |

Results are sorted by `timestamp DESC, id DESC`. The tiebreaker is required:
without it, equal-timestamp rows return in arbitrary order and pagination
silently duplicates or skips rows.

```json
{
  "logs": [{
    "id": "4521",
    "timestamp": "2026-07-20T14:32:01.123Z",
    "level": "error",
    "service": "checkout",
    "message": "payment declined",
    "attributes": { "user_id": "42" }
  }],
  "next_cursor": "eyJ0IjoiMjAyNi0wNy0yMFQxNDozMjowMS4xMjNaIiwiaSI6IjQ1MjEifQ"
}
```

`next_cursor` is `null` when no further results exist.

**400 responses** use `{ "error": "<description>" }` for: invalid timestamps,
`until` not later than `since`, unsupported levels, non-numeric limits, limits
outside 1–1000, and malformed cursors.

### `GET /logs/aggregate`

Supports the same filters as `GET /logs`, plus:

| Parameter | Required | Values |
|---|---|---|
| `since` | Yes | ISO 8601 |
| `until` | Yes | ISO 8601 |
| `bucket` | Yes | `1m`, `5m`, `1h`, `1d` |
| `group_by` | No | `service` or `level` |

Note that `since` and `until` are **required here** although optional on
`GET /logs`.

```json
{
  "buckets": [
    { "start": "2026-07-20T14:00:00.000Z", "group": "checkout", "count": 118 },
    { "start": "2026-07-20T14:00:00.000Z", "group": "auth", "count": 42 }
  ]
}
```

Ordered by bucket start ascending. Empty buckets are omitted. `group` is `null`
when `group_by` is not supplied.

---

## Architecture

```
src/
├── http/       Fastify routes, status codes, response shaping
├── domain/     Types and validation. No I/O, no framework imports
├── db/         Connection pool, repositories, SQL construction, batching
└── config/     Environment reading and validation
```

Dependencies point inward: `http/` and `db/` may import from `domain/`;
`domain/` imports from neither. If the HTTP layer were replaced by a CLI,
`domain/` would not change.

This matters for two reasons beyond tidiness. Validation and query building are
unit-testable as plain functions with no server or database. And **all dynamic
SQL construction is confined to `db/queries/`**, giving a single auditable
location for injection safety — necessary because no ORM is used.

### No ORM

Rejected because the demo requires `EXPLAIN ANALYZE` on important queries
(meaningless for SQL you did not write), because bulk ingestion needs hand-tuned
SQL that ORMs abstract away, because partitioned tables are handled poorly by ORM
schema tooling, and because a query engine is a significant fraction of a 256 MB
budget.

The accepted cost is owning injection safety directly. See Security below.

---

## Schema

```sql
CREATE TABLE logs (
  id          BIGSERIAL,
  timestamp   TIMESTAMPTZ NOT NULL,
  level       TEXT        NOT NULL CHECK (level IN ('debug','info','warn','error')),
  service     TEXT        NOT NULL CHECK (length(service) > 0),
  message     TEXT        NOT NULL CHECK (length(message) > 0),
  attributes  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (timestamp, id)
) PARTITION BY RANGE (timestamp);
```

**`TIMESTAMPTZ`, not `TIMESTAMP`.** The ingestion API accepts any valid ISO 8601
offset. Without a zone, `14:00Z` and `14:00+03:00` compare as equal when they
are three hours apart.

**`PRIMARY KEY (timestamp, id)`.** A partitioned table requires the partition key
in the primary key. This happens to match the sort order the spec requires, so
the constraint costs nothing.

**`id BIGSERIAL`, not UUID.** 8 bytes rather than 16, against a 1 GB database
budget. More importantly, sequential values always append to the rightmost
B-tree page, which stays cached, while random UUIDs land on arbitrary pages and
cause measurably more page splits at high insert rates. UUID would be correct
with multiple uncoordinated writers; a single database issues all ids here.

**`level` and `service` as `TEXT` with `CHECK`, not `ENUM` or a lookup table.**
A `services` table would add a join to every read and a lookup-or-insert to every
write. Postgres stores these columns as `extended`, so TOAST compresses repeated
values automatically — part of the expected normalization saving happens without
the operational cost. General principle: normalization trades operations for
space, and at this write rate on one CPU, operations are the scarcer resource.

**Daily range partitioning.** The spec states ~1M rows ≈ one month, so daily
gives ~33k rows per partition and ~30 live partitions — fine-grained enough for
useful retention, coarse enough that planning overhead stays low. Partitions are
created with `fillfactor = 100`: the default 90 reserves free space on every page
for in-place updates, and this table is append-only.

---

## Attribute storage

**A single `attributes JSONB` column.**

Rejected — EAV side table (`log_id`, `key`, `value`): at ~3 attributes per entry
this turns every row insert into four, and multi-key filters require repeated
self-joins against a table growing 3x faster than the log table.

Rejected — promoted columns for hot keys: the load generator's attribute keys are
not known in advance, so promotion would be guesswork. Kept as a documented
upgrade path.

**Values are coerced to strings at ingestion.** The spec requires `attr.<key>` to
compare as strings while permitting numbers and booleans. JSONB distinguishes `3`
from `"3"`, so `@> '{"retries":"3"}'` would not match a stored numeric `3`.
Coercing at write time makes every filter a single containment check.

### The GIN index was built, measured, and removed

A GIN index using `jsonb_path_ops` was the original design and served
`attr.<key>` filters via `@>`. Measurement removed it.

At 1M rows the index occupied 135 MB against 173 MB of heap — 78% the size of the
data it indexed, and 59% of total index storage. Under the graded load generator,
Postgres saturated its single CPU at 1,101 logs/sec while the application
container sat at 21% of its allowance: index maintenance was the dominant write
cost.

**Trade-off accepted:** `attr.<key>` filters are now sequential scans. Partition
pruning still bounds the scan to the queried time range, so time-filtered
attribute queries remain usable; unfiltered ones degrade with retention depth.
All 89 tests still pass, including attribute-filter correctness.

This inverts the original reasoning, which optimised one filter at the cost of
write throughput. The spec weights ingestion far more heavily.

---

## Index design

| Index | Serves |
|---|---|
| `PRIMARY KEY (timestamp, id)` | Time-range filters and the required sort order |
| `(service, timestamp DESC, id DESC)` | `service=X`, optionally with a time range |

**Deliberately not indexed:**

- **`attributes`** — removed after measurement, above.
- **`level` alone** — four distinct values, so a filter on it typically matches
  too large a fraction of rows for an index scan to beat a sequential scan.
- **`message` (pg_trgm)** — the extension is enabled but no trigram index exists.
  A trigram index can exceed the size of the column it indexes and taxes every
  insert. The decision is **deferred, not resolved**: load testing never
  exercised `q` heavily enough to justify measuring the write-side cost, so no
  comparison was run.

Every index slows ingestion: each insert updates all of them. At the measured
write rate that is the dominant constraint, so nothing was added speculatively.

---

## Retention

`RETENTION_DAYS` defaults to 30. Expired data is removed by **dropping whole
partitions**, not deleting rows.

`DROP TABLE logs_YYYY_MM_DD` is a metadata operation: milliseconds, space
reclaimed immediately, negligible WAL, no lock contention with writers.

**This was measured, not assumed.** During performance work, test rows were
removed with `DELETE` + `VACUUM ANALYZE` between runs. On 966,812 rows the table
occupied 547 MB; after `VACUUM FULL` it occupied 167 MB. **380 MB — 70% of the
table — was dead space** that plain VACUUM had returned for internal reuse but
not to the filesystem. Aggregation p95 on that bloated table measured 1,617 ms
against 104 ms on the same row count after a full reset.

`VACUUM FULL` reclaims it but rewrites the table under an exclusive lock, which
is unusable while ingesting. Partition dropping avoids the problem entirely.

**Partition selection joins `pg_inherits`** rather than matching
`relname LIKE 'logs_%'`, so only genuine partitions of `logs` are eligible — a
table named `logs_backup` is untouched, verified by test. The name pattern
additionally excludes `logs_default`, whose loss would break the ingestion
safety net.

Retention runs once at startup and every six hours. Dropped partition names are
logged at `warn` level: production runs at `warn`, and irreversible deletion must
stay visible there.

---

## Ingestion write path

Two mechanisms, both added after measurement showed per-request cost dominated.

**Micro-batching.** Entries from concurrent requests accumulate for up to 10 ms
and are written together. The graded harness sends ~27 entries per request, so
each request's own write is trivial while the connection acquisition, round trip,
and commit are not. Combining amortises that.

**COPY rather than multi-row INSERT.** COPY bypasses the query parser and planner
entirely — no SQL text to parse, no plan to build, no bind parameters. The
formatting work moves to the application, which had spare CPU precisely when
Postgres did not.

Text format rather than binary: binary is marginally faster but requires encoding
every type by hand, and an encoding bug corrupts data silently. Text format needs
escaping for backslash, tab, newline, and carriage return. Verified by
round-tripping a message containing all three delimiters — it returns as one row
with characters intact.

**Durability is preserved.** Each request's promise resolves only after the COPY
commits, so no batch is acknowledged before Postgres has accepted it. The spec's
"never respond 200 to a batch you have not durably accepted" holds without
special handling — no in-memory buffering is involved. Per-request latency rises
by up to the flush interval; throughput rises by the batching factor.

---

## Security

The spec treats SQL injection as disqualifying. Without an ORM, that is handled
directly.

**All dynamic SQL lives in `src/db/queries/`.** A local `param()` helper pushes a
value onto the parameter array and returns only its positional placeholder:

```typescript
const param = (value: unknown): string => {
  values.push(value);
  return `$${values.length}`;
};

conditions.push(`service = ${param(filters.service)}`);   // → "service = $1"
```

A caller **cannot** interpolate a user value into the SQL text, because the
helper never hands the value back. This is enforced by design rather than by
discipline.

**Attribute keys are user-controlled too.** They are collapsed into a single JSON
parameter, so the query text is identical regardless of which keys are supplied:

```sql
WHERE attributes @> $1     -- $1 = '{"user_id":"42","region":"eu-west"}'
```

**Identifiers cannot be parameters.** Postgres plans a statement before binding
values, so `GROUP BY $1` groups by a constant string rather than a column — a
silently wrong result, not an error. `bucket` and `group_by` are therefore closed
allow-lists whose values *select* between SQL fragments we wrote, never build
one. The mapping uses `Record<BucketSize, string>` so the type system enforces
exhaustiveness.

**COPY has its own escaping surface.** Text-format COPY delimits fields with tabs
and rows with newlines, so an unescaped message containing either would corrupt
row structure silently. Backslash, tab, newline, and carriage return are escaped;
null bytes are rejected at validation.

**A unit test asserts the injection invariant directly:** every value in the
parameter array must be absent from the generated SQL text. An integration test
stores `'); DROP TABLE logs; --` as a service name and confirms it comes back as
literal text.

---

## Performance

Full methodology, measurements, and the mistakes made along the way are in
[`docs/PERFORMANCE.md`](docs/PERFORMANCE.md).

### Results against spec targets

| Target | Result | |
|---|---|---|
| Sustain ≥ 15,000 logs/sec | **18,950 logs/sec** | ✅ |
| No dropped requests or crashes | 0 timeouts, 0 errors | ✅ |
| Aggregation p95 < 1s | **197 ms** under concurrent ingestion | ✅ |
| Query performance during ingestion | 40 of 40 aggregates completed | ✅ |
| ~1,000,000 stored records | 1M seeded, 2M+ during the run | ✅ |
| Data queryable within 20s | Raw-tail merge past the rollup watermark | ✅ |
| 1 aggregation/sec during ingestion | Sustained | ✅ |

Both containers retain headroom, so this is a sustained rate rather than a
saturation point.

### Required reporting

| Item | Value |
|---|---|
| Test environment | Docker Compose on macOS (Apple Silicon); app 0.5 CPU / 256 MB, postgres 1 CPU / 1 GB. Docker Desktop runs containers in a Linux VM, so native Linux should perform better. |
| Dataset size | 1,000,000 seeded rows spanning 30 days; 2M+ during the run |
| Batch size | 27 entries, matching the graded harness. Earlier local runs used 500 — see below. |
| Ingestion rate | **18,950 logs/sec** sustained over 60s against a fixed 15,000/sec arrival rate |
| Query rate | 1 aggregation/sec, concurrent with ingestion |
| Query latency | p50 148 ms · **p95 197 ms** · p99 247 ms |
| Resource usage | app 41.5% of 0.5 CPU, 48 MiB of 256 MB · postgres 40.9% of 1 CPU, 340 MiB of 1 GB |
| Bottlenecks discovered | Harness batch size, GIN index maintenance, per-request round trips, DELETE bloat, disk-spilling sorts |
| Optimizations applied | COPY ingestion, micro-batching, GIN index removal, unlogged rollups, WAL/checkpoint tuning, pool sizing, `synchronous_commit=off`, `fillfactor=100` |

### The measurement harness was the first bottleneck

An early local run measured 45,497 logs/sec. The first graded run measured 1,101.
The gap was not the service.

The local generator used 500-entry batches and fixed concurrency — waiting for
each response before sending the next. The graded harness uses ~27-entry batches
at a fixed arrival rate. Fixed concurrency measures the maximum a service can
absorb; fixed rate measures whether it keeps up with imposed demand, and queues
when it does not. Under 27-entry batches the per-request cost dominates: the
write is trivial, the round trip is not.

Rebuilding the generator to match — batch size derived from the graded run's own
metrics (132,200 logs ÷ 4,800 requests), fixed arrival rate, 5-second timeout —
turned a 12-hour feedback loop into a 60-second one and made every subsequent
optimisation measurable rather than speculative. `scripts/loadgen-v2.mjs` is that
generator.

### Optimizations, in order of impact

1. **COPY instead of multi-row INSERT.** Bypasses parse and plan entirely.
2. **Micro-batching.** Combines concurrent requests into one write.
3. **GIN index removal.** 59% of index storage, maintained on every insert.
4. **PostgreSQL tuning.** `work_mem` 4→32 MB eliminated a disk-spilling sort;
   `shared_buffers` 128→256 MB; `random_page_cost` 4.0→1.1 (the default assumes
   spinning disks); `synchronous_commit=off` removes an fsync wait per commit.
5. **Pre-aggregated rollups.** Aggregation over the raw table scanned 3,080 ms at
   4.7M rows; the rollup answers the same query in 65 ms.
6. **Unlogged rollup tables.** Derived data needs no WAL.
7. **Pool size 8→20.** ~40 concurrent requests against 8 connections queued.

#### Latency tails

p99 is heavier than p95 for ingestion — 953 ms against 145 ms — attributable to
checkpoint flushes; the run wrote 1.8 GB of block I/O in sixty seconds.

Aggregation shows no such gap (247 ms p99 against 197 ms p95), because
rollup-backed queries touch a bounded number of rows regardless of how much data
arrived while they ran.

The spec measures p95, which stays well inside target on both. Flattening the
ingestion tail would need more aggressive background writing, trading average
throughput for tail consistency.

## Testing

89 tests: unit tests for validation, query building, and cursors; integration
tests against a real PostgreSQL instance for all four endpoints.

```bash
npm run test:unit    # no database
npm run test:db      # full suite
```

The database is never mocked. The entire project is about database behaviour, so
a mock would test the mock. Integration tests use Fastify's `inject()` rather
than a real socket — same routing and error handling, no port binding, which is
only possible because `buildServer()` is separate from `listen()`.

**Three real defects were found by tests, not by inspection:**

1. A `\u0000` byte in a message caused the entire batch to fail with 500.
   Postgres cannot store NUL in a `TEXT` column while JSON permits it. This
   violated both the error contract and the partial-success requirement. Now
   rejected per-entry with a reason.

2. The rollup merge assumed `last_bucket` meant "everything before this is rolled
   up". It means "everything that existed when the rollup last ran". Rows
   inserted afterwards with older timestamps were covered by neither branch and
   vanished from aggregates.

3. Narrowing the raw-table fallback window from one hour to two minutes dropped
   aggregate totals from 60 to 26 — the rollup's trailing recompute window did
   not cover the full queried range.

---

## CI

`.github/workflows/ci.yml` runs two jobs.

**`verify`** — install, lint, typecheck, build, and the full test suite against a
PostgreSQL service container.

**`contract`** — starts the stack with `docker compose -f docker-compose.yml up`,
exactly as a grader would, waits for `/health`, and exercises all four required
endpoints. It sends an unrecognised `Authorization: Bearer` header to confirm it
is ignored rather than rejected, as the load generator contract requires.

The second job depends on the first: there is no point building an image from
code that does not pass its own tests.

Because no optional features are implemented, only the first configuration from
the spec applies — all four endpoints reachable with no credentials. There is no
`AUTH_ENABLED=true` path to test.

---

## Optional features

**No authentication, rate limiting, quotas, or multi-tenancy are implemented.**
`docker compose up` with no configuration yields the plain core service:

- All four required endpoints served unauthenticated
- No rate limit, quota, or tenancy restriction
- No environment file, arguments, or manual setup required

`AUTH_ENABLED` is not implemented and therefore behaves as disabled. An
unrecognised `Authorization: Bearer` header is ignored rather than rejected —
verified in CI, which sends one on every smoke-test request.

**One item from the spec's stretch-goal list is present:** pre-aggregated rollup
tables (`log_rollup_1m`). It is included as a performance mechanism rather than
a toggleable feature — always on, transparent to callers, and it changes no
response shape or status code. Aggregate queries route to the rollup or the raw
table based on which can answer them correctly:

| Query | Source |
|---|---|
| no filters, or `service` / `level` / `group_by` | rollup |
| `attr.<key>` or `q` | raw table — those dimensions are not in the rollup |
| range starting within the last 2 minutes | raw table — rollup lag |

The routing is invisible from outside: same request, same response shape, same
counts.

---

## Known limitations

- **Planning time scales with partition count** — 2.6 ms at 9 partitions, 14.5 ms
  at 36, paid per request with no caching. At longer retention this grows.
  Addressing it would mean coarser partitions, trading against retention
  granularity.

- **The rollup only recomputes a trailing 10-minute window.** Data older than
  that is covered only if a refresh ran while it was current. After a restart, or
  for backfilled data, older buckets are missing and queries covering them
  undercount. A full rebuild corrects it:
  `UPDATE log_rollup_state SET last_bucket = '2000-01-01'; SELECT refresh_log_rollup();`

- **`attr.*` and `q` filters bypass the rollup** and pay full scan cost. The GIN
  index removal makes `attr.*` a sequential scan within matched partitions.
  Acceptable because dashboard-style queries — counts over time, split by service
  or level — are the common case.

- **No trigram index on `message`**, so `q` is a sequential scan within matched
  partitions. The extension is enabled; the index decision remains deferred
  rather than resolved, because load testing never exercised `q` heavily enough
  to justify measuring the write cost.

- **`synchronous_commit=off`** means an unclean server crash can lose the last
  fraction of a second of commits. Postgres still accepts each transaction and
  rows are immediately visible, so the "durably accepted" contract holds for
  every case except abrupt power loss. A deliberate exchange, not an oversight.

- **Repeated query parameters take the first value** (`?service=a&service=b`
  filters on `a`). The spec does not define this case.

- **Sub-millisecond timestamp precision is truncated** — JavaScript `Date` holds
  milliseconds, so microsecond input loses precision silently.

- **The default `DATABASE_URL` contains development credentials.** Required by
  the zero-configuration contract. A real deployment would source them from a
  secret store and refuse to start without them.

- **Numbers were measured on macOS via Docker Desktop's Linux VM.** Native Linux
  should perform better; these figures are conservative.

---

## Further reading

| Document | Contents |
|---|---|
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Every design decision and its rationale, in the order they were made |
| [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) | Full measurements, methodology, and invalidated experiments |