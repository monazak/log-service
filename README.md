# Log Ingestion and Query Service

A service that ingests high volumes of structured logs, stores them in
PostgreSQL, and exposes query and time-bucketed aggregation APIs.

Measured at **45,497 logs/sec** with aggregation at **611 ms p95 under concurrent
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

---

## Configuration

Every variable has a default. None are required.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `HOST` | `0.0.0.0` | Listen address — must not be localhost inside a container |
| `DATABASE_URL` | `postgres://logservice:logservice@postgres:5432/logs` | Matches docker-compose.yml |
| `DB_POOL_SIZE` | `8` | Connection pool size |
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
├── db/         Connection pool, repositories, SQL construction
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
(meaningless for SQL you did not write), because partitioned tables are handled
poorly by ORM schema tooling, and because a query engine is a significant
fraction of a 256 MB budget.

The accepted cost is owning injection safety directly. See below.

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
cause measurably more page splits at 45k inserts/sec. UUID would be correct with
multiple uncoordinated writers; a single database issues all ids here.

**`level` and `service` as `TEXT` with `CHECK`, not `ENUM` or a lookup table.**
A `services` table would add a join to every read and a lookup-or-insert to every
write. Postgres stores these columns as `extended`, so TOAST compresses repeated
values automatically — part of the expected normalization saving happens without
the operational cost. General principle: normalization trades operations for
space, and at 45k writes/sec on one CPU, operations are the scarcer resource.

---

## Attribute storage

**A single `attributes JSONB` column, indexed with GIN (`jsonb_path_ops`).**

Rejected — EAV side table (`log_id`, `key`, `value`): at ~3 attributes per entry
this turns 45k row inserts per second into 180k, and multi-key filters require
repeated self-joins against a table growing 3x faster than the log table.

Rejected — promoted columns for hot keys: the load generator's attribute keys are
not known in advance, so promotion would be guesswork. Kept as a documented
upgrade path.

**`jsonb_path_ops` rather than the default GIN opclass.** It indexes values only,
not keys, producing an index roughly 30% smaller. The trade-off is support for
fewer operators — but `@>` is the only one the spec requires.

**Values are coerced to strings at ingestion.** The spec requires `attr.<key>` to
compare as strings while permitting numbers and booleans. JSONB distinguishes `3`
from `"3"`, so `@> '{"retries":"3"}'` would not match a stored numeric `3`.
Coercing at write time makes every filter a single containment check against one
index.

**Measured cost:** the GIN index is 135 MB against 173 MB of heap at 1M rows —
78% the size of the data it indexes. See `docs/PERFORMANCE.md`.

---

## Index design

| Index | Serves |
|---|---|
| `PRIMARY KEY (timestamp, id)` | Time-range filters and the required sort order |
| `(service, timestamp DESC, id DESC)` | `service=X`, optionally with a time range |
| `GIN (attributes jsonb_path_ops)` | `attr.<key>=<value>` via `@>` |

**Deliberately not indexed:**

- **`level` alone** — four distinct values, so a filter on it typically matches
  too large a fraction of rows for an index scan to beat a sequential scan. It
  appears in no index; measured selectivity did not justify one.
- **`message` (pg_trgm)** — the extension is enabled but no trigram index exists.
  A trigram index can exceed the size of the column it indexes and taxes every
  insert. Deferred pending evidence that `q` is exercised often enough to justify
  the write cost.

Every index slows ingestion: each insert updates all of them. At 45k/sec that is
the dominant constraint, so nothing was added speculatively.

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

**A unit test asserts the invariant directly:** every value in the parameter
array must be absent from the generated SQL text. An integration test stores
`'); DROP TABLE logs; --` as a service name and confirms it comes back as literal
text.

---

## Performance

Full methodology, measurements, and the mistakes made along the way are in
[`docs/PERFORMANCE.md`](docs/PERFORMANCE.md).

### Results

| Target | Result | |
|---|---|---|
| Sustain ≥ 15,000 logs/sec | **45,497/sec** | ✅ |
| No dropped requests or crashes | 0 errors across all runs | ✅ |
| ~1,000,000 stored rows | 4.7M under load | ✅ |
| Aggregation p95 < 1s (idle) | 160 ms | ✅ |
| Aggregation p95 < 1s (under ingestion) | **611 ms** | ✅ |
| 1 aggregate/sec during ingestion | 30/30 completed | ✅ |
| Newly ingested data queryable within 20s | Raw tail queried past the rollup watermark | ✅ |

The spec lists 20,000 and 25,000 logs/sec as additional credit.

### Method

| Script | Purpose |
|---|---|
| `scripts/seed.sql` | 1M rows over 30 days, generated in-database. Setup, not measurement. |
| `scripts/loadgen.mjs` | Ingestion over HTTP `POST /logs` — the path a grader exercises |
| `scripts/querygen.mjs` | One aggregate request per second |

Ingestion is measured over HTTP rather than direct SQL, because that is what gets
graded: it includes JSON parsing, validation, and the 0.5 CPU application limit.
The generator holds fixed concurrency rather than a fixed rate, so throughput is
bounded by the service rather than the harness.

Every run resets state first (`DELETE` recent rows, `VACUUM FULL ANALYZE`) and
records `count(*)` alongside the result. This protocol was adopted after several
comparisons turned out to be invalid — documented in `docs/PERFORMANCE.md`.

### Optimizations applied

**1. PostgreSQL memory and cost settings.** The baseline aggregation sort spilled
to disk (`external merge, Disk: 2552kB`) at the default 4 MB `work_mem`. Raising
it to 32 MB and `shared_buffers` to 256 MB eliminated the spill; execution fell
from 97.8 ms to 81.2 ms. `random_page_cost` lowered from 4.0 to 1.1 because the
default assumes spinning disks.

**2. Pre-aggregated rollup table.** Aggregation over the raw table scans every
row in range — 3,080 ms at 4.7M rows. `log_rollup_1m` stores
`(bucket, service, level, count)` at 1-minute granularity; all four bucket sizes
and both `group_by` options are derived by summing. The same query costs 64.8 ms.

Refreshed on a 10-second timer, **not** by trigger: a trigger would execute
~45,000 times per second on the write path, against 0.1 times per second for the
timer. The spec's 20-second visibility allowance is what makes deferred refresh
legitimate.

Under concurrent ingestion at concurrency 8, aggregation p95 fell from 2,715 ms
to 611 ms. Ingestion throughput *improved* 6% as a side effect, because aggregate
queries no longer monopolise the database for seconds at a time.

**Query routing.** The rollup serves a query only when every column it needs
exists in it. Attribute filters and message search fall back to the raw table, as
do ranges beginning within the last hour — recent ranges are cheap to scan
directly and avoid rollup lag entirely.

---

## Testing

88 tests: unit tests for validation, query building, and cursors; integration
tests against a real PostgreSQL instance for all four endpoints.

```bash
npm run test:unit    # no database
npm run test:db      # full suite
```

The database is never mocked. The entire project is about database behaviour, so
a mock would test the mock. Integration tests use Fastify's `inject()` rather
than a real socket — same routing and error handling, no port binding, which is
only possible because `buildServer()` is separate from `listen()`.

**Two real defects were found by tests, not by inspection:**

1. A `\u0000` byte in a message caused the entire batch to fail with 500.
   Postgres cannot store NUL in a `TEXT` column while JSON permits it. This
   violated both the error contract and the partial-success requirement. Now
   rejected per-entry with a reason.

2. The rollup merge assumed `last_bucket` meant "everything before this is rolled
   up". It means "everything that existed when the rollup last ran". Rows
   inserted afterwards with older timestamps were covered by neither branch and
   vanished from aggregates entirely.

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

---

## Known limitations

- **Planning time scales with partition count** — 2.6 ms at 9 partitions, 14.5 ms
  at 36, paid per request with no caching. At longer retention this grows.
  Addressing it would mean coarser partitions, trading against retention
  granularity.

- **Rows arriving with timestamps older than the rollup's trailing window are
  missed by the rollup.** Queries covering recent ranges fall back to the raw
  table, so results stay correct; the cost is that late-arriving historical data
  does not benefit from pre-aggregation. A general fix requires tracking
  insertion order separately from event time.

- **`attr.*` and `q` filters bypass the rollup** and pay full scan cost.
  Acceptable because dashboard-style queries — counts over time, split by service
  or level — are the common case.

- **No trigram index on `message`**, so `q` is a sequential scan within the
  matched partitions. Enabled but not created pending evidence it is worth the
  write cost.

- **Repeated query parameters take the first value** (`?service=a&service=b`
  filters on `a`). The spec does not define this case.

- **Sub-millisecond timestamp precision is truncated** — JavaScript `Date` holds
  milliseconds, so microsecond input loses precision silently.

- **The default `DATABASE_URL` contains development credentials.** Required by
  the zero-configuration contract. A real deployment would source them from a
  secret store and refuse to start without them.

- **Performance numbers were measured on macOS via Docker Desktop's Linux VM.**
  Native Linux should perform better; these figures are conservative.

---

## Optional features

None implemented. `docker compose up` with no configuration yields the plain core
service: all four endpoints unauthenticated, no rate limit, no tenancy. An
unrecognised `Authorization` header is ignored rather than rejected, verified in
CI.

---

## Further reading

| Document | Contents |
|---|---|
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Every design decision and its rationale, in the order they were made |
| [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) | Full measurements, methodology, and invalidated experiments |