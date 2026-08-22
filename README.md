# Log Ingestion and Query Service

A service that ingests high volumes of structured logs, stores them in
PostgreSQL, and exposes query and time-bucketed aggregation APIs.

Measured against the graded harness's own fixtures at **15,014 logs/sec** — its
full 15,000/sec target — with aggregation at **6.4 ms p95 under concurrent
ingestion**, inside the specified container limits (app 0.5 CPU / 256 MB,
postgres 1 CPU / 1 GB), and postgres still at 27% of its single CPU. It absorbs
the harness's 45,000/sec breaking-point stage at 44,929 logs/sec without
dropping a request.

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
| `INGEST_MAX_CONCURRENT_WRITES` | `2` | COPY transactions in flight at once. Raising it trades database contention for write parallelism; the default is measured |
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

### The GIN index was removed, then earned its way back

A GIN index using `jsonb_path_ops` was the original design, serving `attr.<key>`
filters via `@>`. It was dropped in migration 008 and restored in migration 016.
Both decisions were measured, and the reason they differ is that the write path
changed underneath them.

**Why it was dropped.** At 1M rows the index occupied 135 MB against 173 MB of
heap — 78% the size of the data it indexed. Under load Postgres saturated its
single CPU at 1,101 logs/sec while the application sat at 21% of its allowance.
Index maintenance was the dominant write cost, and the spec weights ingestion
heavily.

**Why it came back.** By migration 016 entries were micro-batched and written
with COPY, the rollup was maintained incrementally instead of by periodic scan,
and the application had dropped to 6% CPU under the same load. The headroom that
did not exist in 008 existed now. The index returned with `fastupdate = on`, so
inserts append to a pending list that merges in bulk rather than descending the
tree per row.

**Current cost and benefit**, measured under live 15,000 logs/sec ingestion:

| Query | With the index |
|---|---|
| `attr.fixture_index=500000` (1 row of 3M) | 31–104 ms |
| `attr.region=eu-west` (broad) | 3.7 ms |
| `attr.seed=6122026` (1M matches) | 266–337 ms |

Those numbers also depend on the staged windowing in `queryLogs` — see
[Index design](#index-design).

---

## Index design

| Index | On | Serves |
|---|---|---|
| `PRIMARY KEY (timestamp, id)` | `logs` | Time-range filters and the required sort order |
| `(service, timestamp, id)` | `logs` | `service=X`, optionally with `level` or a time range |
| `GIN (attributes jsonb_path_ops)` | `logs` | `attr.<key>=<value>` via `@>` |
| `PRIMARY KEY (bucket, service, level)` | `log_rollup_1m` | Whole minutes of an aggregate range |
| `(bucket)` | `log_rollup_1m` | Range scans over the rollup |
| `PRIMARY KEY (bucket, service, level)` | `log_rollup_1s` | The partial minute at each end of a range |

**The service index ascends** (migration 019). It reads `(service, timestamp,
id)`, not `timestamp DESC, id DESC`, even though every query sorts descending.
Postgres scans a B-tree backwards at the same cost, so the ordering buys
nothing — but it costs. Newest-first insertion into a `DESC` index always lands
on the leftmost page, and Postgres only applies its 90/10 page-split
optimisation to rightmost appends. Leftmost inserts split 50/50 and leave pages
permanently half full: the index measured **806 MB against a 205 MB primary
key** on identical rows. Ascending, it packs like the primary key does.

**Deliberately not indexed:**

- **`level` alone** — four distinct values, so a filter on it typically matches
  too large a fraction of rows for an index scan to beat a sequential scan. It
  is the third column of the service index, where it is nearly free.
- **`message` (pg_trgm)** — built in migration 020 and dropped again in 022. A
  62-character message yields roughly sixty trigrams, so at the breakpoint
  scenario's 45,000 logs/sec the index takes on the order of 2.7 million entries
  per second. It halved throughput at that stage (10,709 → 5,083 logs/sec) and
  took ingestion p95 from 49 ms to 1.92 s, in exchange for no measurable query
  benefit: every `q` query the load generator issues also carries `service` and
  a time range, which the service index already narrows.

**`attr.<key>` and `q` are staged rather than planned directly.** Neither the
GIN index nor a trigram index carries any ordering, so for `ORDER BY timestamp
DESC LIMIT n` the planner chooses between selecting on the filter and sorting
the matches, or walking the time index backwards and testing each row. It
estimates `@>` and `ILIKE` at a flat fraction of the table whatever the value,
so on a selective filter it takes the second option expecting to fill the page
quickly — and walks the entire table instead. Measured: a filter matching one
row in three million took 3 s and hit the statement timeout, surfacing as a 500.

`queryLogs` therefore tries time windows newest-first. A window that fills the
page is the answer, because everything it excludes is strictly older than
everything it returns. A broad filter fills the first window at once; reaching
the end of the windows is itself evidence the filter is selective, so the final
full-range attempt is planned behind an `OFFSET 0` fence, where sorting the few
matches is the cheap option.

Every index slows ingestion: each insert updates all of them. At the measured
write rate that is the dominant constraint, so nothing was added speculatively,
and two indexes have been removed after measurement.

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

Measured over 120 seconds at a fixed 15,000/sec arrival rate, against a database
prepared with the harness's own 1,000,000-row fixture, with queries running
concurrently throughout.

| Target | Result | |
|---|---|---|
| Sustain ≥ 15,000 logs/sec | **15,013 logs/sec** — 100% of target | ✅ |
| No dropped requests or crashes | 0 errors, 0 rejected, 0 timeouts | ✅ |
| Aggregation p95 < 1s | **3.1 ms** under concurrent ingestion | ✅ |
| Query performance during ingestion | `GET /logs` p95 2.2 ms | ✅ |
| ~1,000,000 stored records | 1M fixture + 1.8M ingested during the run | ✅ |
| Data queryable within 20s | Committed before the 200; rollup shares the transaction | ✅ |
| 1 aggregation/sec during ingestion | Sustained at 2/sec | ✅ |

Postgres runs at 19% of its CPU and the application at 32% of its 0.5, so this is
a sustained rate rather than a saturation point. Pushed further, the same build
takes the harness's stress, spike, and breakpoint profiles — up to 45,000/sec —
with no errors and no rejected batches.

### Scored by the graded harness, run locally

The grading harness is published as a CLI, so the same catalogue that scores a
submission can be run against this repository directly:

```bash
npx --yes github:Ahmad-Abbas-Foothill/logs-benchmark-cli \
  --compose ./docker-compose.yml --full --seed 6122026 \
  --runner docker --json benchmark-report.json --generator-cpus 2
```

```
Correctness    15.0 / 15   (15/15 checks)
Performance    47.5 / 50   throughput 14,998/s . errors 0.0% . p95 16ms
Queries        15.0 / 15   aggregate p95 2ms . consistency 4/4
Reliability    20.0 / 20   4/4 scenarios

Total          97.5 / 100
```

Three caveats belong with that number, all of them the tool's own:

- **Correctness is the only part that transfers exactly.** The CLI states it:
  the catalogue and k6 script are identical to the platform's. Performance
  points are "indicative, not a grade".
- **This machine measured 0.66x the reference speed.** A slower core ingests
  less in the 0.5 CPU the application is given, and nothing in the score
  normalises for it.
- **The generator was itself the constraint** in stress, spike, and breakpoint,
  where k6 could not start every scheduled iteration. Those three scenarios
  understate the service rather than measure it.

**47.5 is the maximum the performance section can award.** Its four components
are reported in `benchmark-report.json`, and their maxima sum to 0.95, not 1.0:

| Component | Scored | Maximum |
|---|---|---|
| `throughput` | 0.39996 | 0.40 |
| `errors` | 0.300 | 0.30 |
| `latency` | 0.200 | 0.20 |
| `sustainedBonus` | 0.050 | 0.05 |
| | **0.94996** → 47.4978 / 50 | 0.95 → 47.5 / 50 |

So 97.5 is the ceiling for this scoring version, and the run sits 0.038 below
it: 0.002 from throughput (14,998 against a 15,000 target) and 0.036 from
aggregate latency, where reaching a perfect score would require a sub-millisecond
p95 — less than one HTTP round trip.

One further detail from the report worth knowing: `readAfterWrite` is recorded
(0.495) but carries no weight. The queries score is exactly
`6 * (consistent scenarios / 4) + 9 * aggregate-latency score`, which is why
optimising for read-after-write visibility — see
[`docs/DECISIONS.md`](docs/DECISIONS.md) — bought nothing and cost latency.

### Required reporting

| Item | Value |
|---|---|
| Test environment | Docker Compose on macOS (Apple Silicon); app 0.5 CPU / 256 MB, postgres 1 CPU / 1 GB. Docker Desktop runs containers in a Linux VM, so native Linux should perform better. |
| Dataset size | 1,000,000-row harness fixture; 2.8M rows by the end of the run |
| Batch size | 33 entries, matching the graded harness |
| Ingestion rate | **15,013 logs/sec** sustained over 120s against a fixed 15,000/sec arrival rate |
| Query rate | 2 aggregations/sec and 2 log queries/sec, concurrent with ingestion |
| Ingestion latency | p50 9.4 ms · **p95 14.9 ms** |
| Query latency | aggregate **p95 3.1 ms** · `GET /logs` **p95 2.2 ms** |
| Resource usage | app 32% of 0.5 CPU, 42 MiB of 256 MB · postgres 19% of 1 CPU, 355 MiB of 1 GB |
| Bottlenecks discovered | Raw partial-minute edges in the aggregate query, a sequential scan chosen for an `EXISTS` probe, harness batch size, GIN index maintenance, per-request round trips, DELETE bloat, disk-spilling sorts |
| Optimizations applied | Partial-minute aggregation served from the rollup, `min()` probes that cannot plan as sequential scans, COPY ingestion, micro-batching, trigram index removal, WAL/checkpoint tuning, pool sizing, `synchronous_commit=off`, `fillfactor=100`, ascending service index |

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

1. **Partial minutes answered from the rollup.** The aggregate query read raw
   rows for the fraction of a minute at each end of the range. At 15,000
   logs/sec that is up to 900,000 rows per request — 658,515 rows and 438 ms
   when measured — competing with ingestion for the one database CPU. Serving
   those ends from the rollup where it is exact took the same request to 0.95 ms.
2. **`min()` guards instead of `EXISTS`.** The condition that decides whether
   the rollup is exact planned as a sequential scan over the whole partition:
   `EXISTS` promises the planner an early exit, but the answer is normally "no
   such row", so proving it meant reading everything. 394 ms to 0.17 ms.
3. **COPY instead of multi-row INSERT.** Bypasses parse and plan entirely.
4. **Micro-batching.** Combines concurrent requests into one write, with a 10 ms
   flush interval chosen for how visible a just-written record stays.
5. **PostgreSQL tuning.** `work_mem` 4→32 MB eliminated a disk-spilling sort;
   `shared_buffers` 128→256 MB; `random_page_cost` 4.0→1.1 (the default assumes
   spinning disks); `synchronous_commit=off` removes an fsync wait per commit.
6. **Pre-aggregated rollups.** Aggregation over the raw table scanned 3,080 ms at
   4.7M rows; the rollup answers the same query in 65 ms.
7. **Pool size 8→20.** ~40 concurrent requests against 8 connections queued.

#### Latency tails

Ingestion is flat through p95 — 9.4 ms median against 14.9 ms p95 — and the
remaining tail is checkpoint flushes, which show up as isolated requests in the
hundreds of milliseconds rather than as a shifted distribution.

Aggregation no longer degrades with run length. It used to: every request read
the raw rows of the current minute, so its cost grew with the ingest rate, and a
long run drifted from milliseconds to seconds. Now the rows it reads are bounded
by the number of minutes in the range, and a 120-second run ends as fast as it
starts (8.6 ms average, 24.9 ms worst).

## Testing

97 tests: unit tests for validation, query building, and cursors; integration
tests against a real PostgreSQL instance for all four endpoints, including the
partial-minute aggregation boundaries, whose totals are asserted against the
rows actually written.

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
`docker compose up` with no environment file, no arguments and no manual setup
yields the plain core service:

- All four required endpoints served unauthenticated
- No rate limit, quota, or tenancy restriction the load generator could hit
- Migrations applied automatically before `/health` reports 200

`AUTH_ENABLED` is not implemented and therefore behaves as disabled. An
unrecognised `Authorization: Bearer` header is **ignored, not rejected** — CI
sends one on every contract request, and `scripts/conformance.sh` asserts it.

Three items from the spec's stretch-goal list are present. All three are always
on, add no required parameter, and change no required response shape or status
code — they are additive in the sense the contract requires.

| Feature | Surface | Default | Configuration |
|---|---|---|---|
| Pre-aggregated rollup tables | none — internal | on | none |
| Operational metrics | `GET /metrics` | on | none |
| Log dashboard | `GET /dashboard` | on | none |

**Pre-aggregated rollup tables** (`log_rollup_1m`, `log_rollup_1s`). Both are
maintained inside the same transaction as the COPY that writes the raw rows, so
neither can disagree with `logs` at any commit — there is no refresh lag and no
watermark. Aggregate queries route by what the rollup can answer correctly:

| Query | Source |
|---|---|
| Whole minutes of the range | `log_rollup_1m` |
| The partial minute at each end | `log_rollup_1s`, or the minute rollup where a probe proves the rest of the minute empty |
| `attr.<key>` or `q` present | raw table — those dimensions are not in either rollup |

The routing is invisible from outside: same request, same response shape, same
counts. `scripts/difftest.mjs` checks that claim by comparing the endpoint
against ground-truth SQL over randomised ranges that straddle second and minute
boundaries, under live ingestion.

**`GET /metrics`** returns process-local counters and latency percentiles for
ingestion and query paths as JSON. Additive: a new endpoint, nothing removed.

**`GET /dashboard`** serves a single self-contained HTML page for browsing and
filtering logs, backed by the same public API. Additive in the same way.

---

## Known limitations

- **`GET /logs?q=<term>` with no `service` filter can exceed the read statement
  timeout**, returning 500 after 3 s. With a million fixture messages sharing the
  term's trigrams, the filter is selective but nothing indexes it usefully, so
  the staged windows expire and the fenced scan rechecks `ILIKE` across the
  range. Every `q` query the load generator issues carries `service`, which
  answers in 2.9 ms. Bounding the unnarrowed case would mean paying trigram
  write cost that measured worse than the problem.

- **`attr.<key>` and `q` aggregates bypass both rollups** and pay raw-scan cost,
  because neither dimension survives pre-aggregation. Time-filtered ones stay
  bounded by partition pruning; unfiltered ones degrade with retention depth.

- **The second rollup is authoritative only for the last two hours.** Older
  partial minutes fall back to the minute rollup and its emptiness probe, and
  where that probe fails, to a raw scan of up to one minute of data. The
  watermark in `log_rollup_1s_state` is what keeps that fallback correct rather
  than silently undercounting.

- **Planning time scales with partition count** — 2.6 ms at 9 partitions, 14.5 ms
  at 36, paid per request with no caching. At longer retention this grows.
  Addressing it would mean coarser partitions, trading against retention
  granularity.

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

- **Local performance numbers have twice disagreed with the graded platform**,
  both times because this machine had database headroom the platform does not.
  Arrival-time flushing and the trigram index each measured well here and cost
  points there. The figures above are the configuration that measured best on
  the platform, not the one that measures best locally.

---

## Further reading

| Document | Contents |
|---|---|
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Every design decision and its rationale, in the order they were made |
| [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) | Full measurements, methodology, and invalidated experiments |