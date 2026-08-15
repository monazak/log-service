# Technical Decisions

A running log of choices made and why. Source material for the README.

---

## Stack

| Concern | Choice | Reason |
|---|---|---|
| Runtime | Node.js 24 LTS | Mature Docker and CI support |
| HTTP framework | Fastify 5 | Fastest mainstream JSON server; matters at high ingest rates |
| Database access | `pg`, raw SQL | Must see and tune every query |
| Validation | Hand-written throughout | See below |
| Migrations | Numbered `.sql` files, custom runner | No magic; partition DDL under our control |
| Tests | Vitest | Native TypeScript, no compile step |
| Lint and format | Biome | One dependency, fast in CI |

---

## No ORM

Rejected Prisma and TypeORM because:

1. The demo requires `EXPLAIN ANALYZE` on important queries. Analyzing a plan
   for SQL you did not write is not meaningful.
2. Bulk insert performance needs hand-tuned SQL — multi-row INSERT with explicit
   chunking — which ORMs abstract away.
3. The app container has 256 MB RAM. Prisma's query engine is a significant
   fraction of that budget.
4. The `logs` table uses time partitioning; ORM schema tooling handles these poorly.

Accepted cost: SQL injection safety is now our responsibility. The spec treats
injection as disqualifying. Mitigated by a single parameterized query builder
(all user input via placeholders, identifiers via allow-list) and dedicated tests.

---

## Validation is hand-written, not schema-library based

Per-entry log validation runs on the hot path — measured at ~45,000 entries/sec —
so it is hand-written: allocation-light, with exact control over the
`{ index, reason }` rejection format the spec requires.

Query parameter parsing was initially planned to use Zod, on the reasoning that
it runs a few times per second where clarity beats nanoseconds. It is
hand-written too, because `attr.<key>` filters have dynamic keys that a static
schema cannot describe. Forcing Zod into that shape would have been less clear
than an explicit parser, and consistency with the ingestion validator is worth
more than the library.

Measurement later supported the first half of this: under a concentrated write
pattern the application container saturated its half-CPU on JSON parsing and
per-entry validation while Postgres still had headroom. Validation sits directly
on the CPU-bound path.

---

## Project structure

Three layers with dependencies pointing inward:

- `http/` — Fastify routes, status codes, response shaping.
- `domain/` — types and validation rules. No I/O, no framework imports.
- `db/` — connection pool, repositories, SQL query construction.

`domain/` imports from neither of the others. Test: if the HTTP layer were
replaced by a CLI, `domain/` would not change.

Rationale:

1. Validation and query building are unit-testable as plain functions, with no
   server or database required.
2. All dynamic SQL construction is confined to `db/queries/`, giving a single
   auditable location for injection safety — necessary since we rejected an ORM.
3. The ingestion write path sits behind a repository boundary, so it could be
   swapped for `COPY` without touching HTTP handlers. Measurement showed the
   multi-row INSERT reaches 45k/sec — three times the target — so the swap was
   never needed. The boundary remains available.

---

## Import extensions

Relative imports use the `.ts` extension, enabled by `allowImportingTsExtensions`
and `rewriteRelativeImportExtensions`.

Reason: the dev loop runs `.ts` files directly through Node's type stripping,
which does not remap `.js` specifiers to `.ts` files. The production build runs
compiled output in `dist/`, which needs `.js`. Writing `.ts` and letting the
compiler rewrite on emit satisfies both without a second toolchain.

---

## Logging

Application logging uses pino via Fastify. Per-request logging is disabled when
`NODE_ENV=production`, and the default level rises from `info` to `warn`.

Reason: under sustained ingestion on a 0.5 CPU limit, per-request log
serialization and blocking writes to stdout consume CPU needed for parsing and
database writes. Docker's default json-file log driver also writes to disk
without rotation, so sustained load tests can produce gigabytes of container logs.

`LOG_LEVEL` overrides the default in any environment, so verbose debugging remains
available in a running container. Note that `LOG_LEVEL=debug` is therefore a
performance switch, not only a verbosity switch — benchmark runs must leave it unset.

---

## Resource limits and Node heap sizing

Container limits match the spec: 0.5 CPU / 256 MB for the application,
1 CPU / 1 GB for PostgreSQL. Applied from the start of the project so that every
performance measurement is taken under the conditions the solution is graded in,
rather than on full laptop resources.

The application container sets `NODE_OPTIONS=--max-old-space-size=192`.

Reason: Node does not read the container's cgroup limit. It inspects total host
memory and sizes its heap accordingly. Inside a 256 MB container this means the
garbage collector defers collection based on memory that does not exist, the
process exceeds the limit, and the kernel OOM-kills it — no exception, no stack
trace. The container simply disappears and `restart: unless-stopped` brings it
back, so the failure presents as a random dropout under load.

192 rather than 256 because Node's off-heap usage (buffers, native modules,
thread stacks) falls outside this limit. The remaining 64 MB is headroom.

Measured outcome: the application peaked at 22% of its 256 MB limit during load
testing, so this ceiling was never approached. It remains as insurance against a
future change that allocates more per request.

Note: in the dev override, `node --watch` keeps the container alive after a
startup failure, so the port stays bound with no server behind it. Production
runs `node dist/index.js` directly, so a startup failure exits the process and
`restart: unless-stopped` retries. Startup failures should therefore always be
verified against the production compose file.

---

## Connection pooling

Pool size defaults to 8 (`DB_POOL_SIZE`), with `idleTimeoutMillis: 30000` and
`connectionTimeoutMillis: 5000`.

Postgres forks one OS process per connection, each holding memory against a 1 GB
budget on a 1 CPU container. Oversized pools cause memory pressure and
context-switch thrashing, reducing throughput rather than increasing it. The
conventional starting point is `(cores * 2) + spindles`, which gives 3 here; 8
allows headroom for burst without approaching the thrashing region.

Pool size was not benchmarked directly. Request concurrency was swept instead
(8 / 4 / 2) and showed the same shape: throughput flat across all three, ingest
p50 seven times worse at concurrency 8 than at 2. More concurrency against a
saturated single CPU is contention, not capacity. The pool size of 8 was left
unchanged because the database, not the pool, was the constraint in every run.

Idle connections close after 30s so the pool shrinks between load phases,
releasing database memory. Every borrowed client is released in a `finally`
block — a leaked connection is never returned, and after `max` leaks the service
hangs with no error.

---

## Timestamps

All timestamp columns use `TIMESTAMPTZ`.

`TIMESTAMP` stores a wall-clock reading with no zone, so `14:00Z` and `14:00+03:00`
compare as equal when they are three hours apart. Since the ingestion API accepts
any valid ISO 8601 offset and range queries must be correct, timestamps are
normalized to UTC on storage.

---

## Attribute storage: JSONB with a GIN index

Chosen: a single `attributes JSONB` column, indexed with GIN (`jsonb_path_ops`).

Rejected — EAV side table (`log_id`, `key`, `value`): at ~3 attributes per entry,
this turns every row insert into four. Multi-key filters also require repeated
self-joins against a table growing 3x faster than the log table itself. Not
viable on a 1 CPU database.

Rejected — hybrid with promoted columns for hot keys: the load generator's
attribute keys are not known in advance, so promotion would be guesswork. Kept
as a documented upgrade path.

`jsonb_path_ops` rather than the default GIN opclass: it indexes values only, not
keys, producing an index roughly 30% smaller. The trade-off is support for fewer
operators — but `@>` is the only one the spec requires.

Measured cost: the GIN index is 135 MB against 173 MB of heap at 1M rows — 78% the
size of the data it indexes, and 59% of total index size. Accepted in exchange for
write throughput and schema flexibility.

### Value normalization

The spec requires `attr.<key>` to compare as strings, but permitted attribute
values are strings, numbers, or booleans. JSONB distinguishes `3` from `"3"`, so
`@> '{"retries":"3"}'` would not match a stored numeric `3`.

All attribute values are therefore coerced to strings at ingestion time. This
makes every equality filter a single containment check against one index, and
matches the spec's response example, which shows attribute values as strings.

---

## Column types for `level` and `service`

Both are `TEXT` with `CHECK` constraints rather than `ENUM`, `SMALLINT`, or a
normalized lookup table.

`level` — rejected `ENUM` because adding a value later requires `ALTER TYPE`,
which is awkward inside transactions. Rejected `SMALLINT` because it requires
conversion on every read and write and makes ad-hoc `psql` debugging opaque
(`WHERE level = 3` communicates nothing). The theoretical saving is ~4 MB at 1M
rows, and no index contains `level` anyway, so the saving is largely notional.
`CHECK (level IN (...))` provides integrity without the type's costs.

`service` — rejected a separate `services` table with a foreign key. It would add
a join to every read query and a lookup-or-insert to every write. Postgres also
stores these columns as `extended`, meaning TOAST compresses repeated values
automatically, so part of the expected normalization saving happens without the
operational cost.

General principle applied here: normalization trades operations for space. At
45k writes/sec on a single CPU, operations are the scarcer resource.

---

## Time partitioning

The `logs` table is range-partitioned on `timestamp`, one partition per day.

Rejected — `DELETE FROM logs WHERE timestamp < ...` for retention. Postgres marks
rows dead rather than removing them, so a delete reclaims no space until VACUUM
runs. On a 1 CPU database under sustained ingestion, VACUUM competes directly with
writes, and the deleted rows remain in the table and every index until it catches
up. This breaks the spec requirement of "no long-running locks, excessive table
bloat, or major ingestion disruption."

This was later measured directly. After several load runs cleaned up with
`DELETE` + `VACUUM ANALYZE`, a table holding 966,812 rows occupied 547 MB; after
`VACUUM FULL` the same rows occupied 167 MB. 380 MB — 70% of the table — was dead
space, and aggregation p95 measured 1,617 ms against 104 ms on the same row count
after a full reset.

`DROP TABLE logs_YYYY_MM_DD` is a metadata operation: milliseconds, full space
reclaimed immediately, negligible WAL, zero bloat, no impact on concurrent writes.

Secondary benefit: partition pruning. Queries with `since`/`until` skip
non-matching partitions entirely at plan time. Measured: a service-plus-one-day
query showed `Subplans Removed: 35`, scanning 1 of 36 partitions.

Daily granularity chosen because the spec states ~1M rows ≈ one month. Daily gives
~33k rows per partition and ~30 live partitions — fine-grained enough for useful
retention, coarse enough that planning overhead stays low. Hourly would produce
720 partitions per month and slow query planning; monthly would make the smallest
deletable unit an entire month.

Cost of the choice: planning time scales with partition count — 2.6 ms at 9
partitions, 14.5 ms at 36 — and is paid per request with no caching.

Note on constraint evaluation order: on a partitioned table, partition routing
happens before CHECK constraints are evaluated, because the constraints live on
the leaf partitions. A row whose timestamp matches no partition is rejected with
"no partition found" regardless of whether its other columns are valid.

---

## Primary key and deterministic ordering

`id BIGSERIAL`, with `PRIMARY KEY (timestamp, id)`.

The spec requires ordering to stay deterministic when timestamps collide, so all
queries sort by `(timestamp DESC, id DESC)`. Without a tiebreaker, Postgres may
return equal-timestamp rows in any order, which silently breaks keyset pagination:
the same row can appear on two pages, or be skipped entirely.

Rejected — UUID:

- 16 bytes vs 8. At 1M rows that is 8 MB extra in the heap plus 8 MB in every
  index containing it, against a 1 GB database memory budget.
- UUIDv4 values are random, so each insert lands on an arbitrary B-tree page.
  Sequential IDs always append to the rightmost page, which stays cached. At
  measured throughput the random pattern causes more page splits and WAL.
- Cursors carrying a UUID are larger and slower to parse.

UUID would be correct with multiple uncoordinated writers, or if IDs had to be
generated client-side before insert. Neither applies: a single database issues
all IDs at write time.

Note: a partitioned table requires the partition key in the primary key, so the
PK is `(timestamp, id)` rather than `(id)`. This matches the sort order the spec
requires, so the constraint costs nothing. The BIGSERIAL sequence is shared across
all partitions, keeping ids globally unique.

Ids are carried as strings end to end: `pg` returns BIGINT as text because the
range exceeds what a JavaScript number represents exactly.

---

## Substring search on `message` (the `q` parameter)

`pg_trgm` is enabled, but the trigram index was **never created**.

The spec requires `q` to be a case-insensitive substring match, which compiles to
`message ILIKE '%term%'`. A B-tree index cannot serve this: it is ordered
lexically, so it can answer "starts with" but not "contains". Without a suitable
index, every `q` query is a sequential scan over the matched partitions.

`pg_trgm` decomposes text into three-character sequences and indexes those with
GIN, making mid-string matching index-assisted.

The cost is real: a trigram index can exceed the size of the column it indexes,
and every insert generates dozens of trigram entries to maintain. The GIN index on
`attributes` already accounts for 59% of total index size, which is direct
evidence of what a second GIN index would cost the write path.

The decision remains **deferred, not resolved**. Load testing did not exercise `q`
heavily enough to justify measuring the write-side cost, so no comparison was run.
This is recorded as a known limitation rather than a completed evaluation.

---

## Migrations

Numbered `.sql` files in `src/db/migrations/`, applied by a custom runner at
startup, before the service reports ready.

Each file runs inside its own transaction, so a failure leaves no partial schema
and no recorded version — the next start retries cleanly. A Postgres advisory lock
serialises concurrent instances, so two containers starting simultaneously cannot
apply the same migration twice. The lock is held on a single dedicated client for
the duration, since advisory locks are session-scoped.

Rejected off-the-shelf migration tools because daily partition creation requires
dynamic DDL that these tools model poorly, and because every line needs to be
explicable during the demo.

Note: `tsc` does not copy `.sql` files, so the build script explicitly copies
`src/db/migrations` into `dist/db/migrations`.

Operational rule: once a migration has been applied in any environment that
matters, it is immutable. Changes go in a new numbered file. During early
development `docker compose down -v` was used to reset after editing an applied
migration; this is safe only because no other environment existed.

---

## Linting

Biome, with `useLiteralKeys` disabled.

That rule rewrites `env["PORT"]` to `env.PORT`. Bracket access is deliberate:
combined with `noUncheckedIndexedAccess`, it types environment reads as
`string | undefined`, forcing explicit handling of a missing variable. Dot access
reads as a guaranteed property and hides that. Biome itself classifies the fix as
unsafe.

## Typecheck configuration

Two tsconfig files. `tsconfig.json` builds `src` into `dist`. `tsconfig.check.json`
extends it with `rootDir: "."` and `noEmit`, and includes `tests` as well.

A single config cannot serve both: `rootDir: "./src"` is required so the build
emits `dist/index.js` rather than `dist/src/index.js`, but that same setting makes
including `tests` an error. Splitting them means test files are type-checked under
the same strict options as production code without affecting build output.

---

## Startup ordering

`src/index.ts` performs startup in a fixed order, and the order is load-bearing:

1. `listen()` — the port opens; `/health` answers **503**
2. `verifyConnection()` — database reachable
3. `runMigrations()` — schema present
4. `ensurePartitions()` — today's partition exists
5. `markReady()` — `/health` answers **200**

The spec states the service must report healthy only after the database
connection is established and migrations have been applied, and that the load
generator polls `/health` before starting. Reporting ready early means load
arrives against an unprepared database; never reporting ready means the
submission is not graded at all.

Background schedulers (partition maintenance, retention, rollup refresh) start
*after* `markReady()`, because they are maintenance rather than readiness
conditions — the service is correct without them for a while.

Fastify rejects `addHook` once `listen()` has been called, so all lifecycle hooks
are registered before startup. Background workers return their timer handles
rather than registering their own cleanup, keeping teardown in one place.

Graceful shutdown reverses the order: `markNotReady()` runs first so `/health`
returns 503 and traffic stops being routed, then in-flight requests drain, then
Fastify's `onClose` hooks fire (clearing timers, closing the pool). A 10s timer
force-exits if shutdown itself hangs; `stop_grace_period: 15s` in compose leaves
5s of margin above it.

---

## Health check strategy

`GET /health` performs a live `SELECT 1`, cached for 5 seconds.

The load generator polls this endpoint continuously and begins sending load on
the first 200, so the answer must be honest and cheap. A purely in-memory flag
would keep reporting healthy after the database dropped, and the generator would
keep sending data that cannot be stored. Querying on every poll would instead
consume the small connection pool that ingestion depends on.

Caching bounds the cost at one query per 5 seconds regardless of poll rate.
Recovery is automatic — no restart is needed once the database returns.

Startup state is tracked separately from the liveness check, so "still starting"
and "database unavailable" are distinguishable and the former costs no query.

The check does not set a per-query timeout; `connectionTimeoutMillis` on the pool
bounds the case that matters, which is failing to acquire a connection at all.

### Pool error listener

`pg` emits an `error` event when a background connection fails — a database
restart, a dropped socket. Node terminates the process on an unhandled `error`
event, so the pool registers a listener. Without it, a database outage kills the
service instead of degrading it to 503, and the automatic recovery path never runs.

Discovered by stopping the database deliberately during development and observing
the process die rather than return 503.

---

## Ingestion write path

Batches are written with a single multi-row `INSERT` per chunk of up to 5000
entries, not one statement per entry. Each round trip to Postgres costs more than
the insert itself, so batching converts N round trips into one.

Chunking exists because Postgres caps a statement at 65535 bind parameters
(13107 rows at five columns) and because a single oversized statement would hold
a large parameter array and query string in a 256 MB process.

Dynamic SQL is limited to generating positional placeholders (`$1`, `$2`, ...)
from a loop counter. No user-supplied value ever enters the query text; values
travel separately in the parameter array and are never parsed as SQL.

Measured at 45,497 logs/sec against a 15,000 target, so `COPY` was not needed.
The `insertLogs(pool, entries)` signature remains the boundary that would keep
such a swap invisible to callers.

Acknowledgement is synchronous: the handler awaits the INSERT before responding
200, so no batch is acknowledged before Postgres has accepted it. The spec's
"never respond 200 to a batch you have not durably accepted" holds without
special handling — no in-memory buffering is involved.

---

## Dynamic query construction

All WHERE-clause construction lives in `db/queries/whereClause.ts`. A local
`param()` helper pushes a value onto the parameter array and returns only its
positional placeholder, so a caller cannot interpolate a user value into the SQL
text even by mistake. Confining dynamic SQL to one file makes the injection
surface auditable in a single place — necessary because we rejected an ORM.

Attribute filters compile to a single `attributes @> $n` containment check with
all requested keys and values serialized into one JSON parameter. The query text
is therefore identical regardless of which attribute keys the caller supplies,
and one index probe serves any number of attribute filters.

`q` is escaped for LIKE metacharacters before being wrapped in wildcards. Without
this, `q=%` matches every row (a full scan of the retention window) and `q=100%`
silently means "contains 100" rather than the literal text. This is a correctness
and performance issue rather than an injection one — parameters already prevent
execution.

A unit test asserts the invariant directly: every value in the parameter array
must be absent from the generated SQL text.

---

## Keyset pagination

Cursors encode the `(timestamp, id)` of the last returned row as base64url JSON,
and the next page selects rows strictly before that point using row comparison:
`("timestamp", id) < ($n, $m)`.

OFFSET was rejected on two grounds. Latency: Postgres must read and discard every
skipped row, so page cost grows linearly with depth. Correctness: offsets are
unstable under concurrent ingestion — a row inserted between two requests shifts
every position, duplicating or skipping results. This project ingests
continuously while queries run, so that is the normal case.

Row comparison rather than the expanded `(a < x OR (a = x AND b < y))` form,
because it maps directly onto the composite `(timestamp, id)` index.

Pages request `limit + 1` rows to detect whether more exist, avoiding a second
COUNT query. The extra row is trimmed before the response.

Cursors are validated but not signed. A tampered cursor can shift the read
position but cannot reach data a plain query could not, and all decode failures
return a single "invalid cursor" message rather than revealing the format.

---

## Aggregation

`bucket` and `group_by` are closed allow-lists resolved to SQL fragments we
wrote, never interpolated. Postgres plans a statement before binding parameters,
so an interval unit or a column name must be present in the query text at plan
time — `GROUP BY $1` does not group by a column, it groups by a constant string,
which is a silently wrong result rather than an error. The user's value selects
between fragments; it never becomes one.

The mapping uses `Record<BucketSize, string>` and `Record<GroupByField, string>`
so the type system enforces exhaustiveness: adding a bucket size to the union
without adding its expression is a compile error.

`1m`, `1h`, and `1d` map onto `date_trunc`. `5m` has no `date_trunc` unit —
Postgres supports natural boundaries, not multiples — so it is computed as
`to_timestamp(floor(extract(epoch FROM ts) / 300) * 300)`. Both approaches share
the property that every timestamp within the interval yields an identical value,
which is what makes GROUP BY produce buckets.

TimescaleDB's `time_bucket` would express all four cases directly, but the spec
requires PostgreSQL as the source of truth and adding an extension for four fixed
values is unjustified complexity.

`since` and `until` are required here although optional on `GET /logs`. The
filter parser is shared and accepts their absence, so the aggregate parser layers
a mandatory check on top. Without it, an aggregate with no time bound would scan
the full retention window with no LIMIT to stop it.

When `group_by` is absent the query selects the literal `NULL` as the group
column, so a single query shape serves both cases and the response carries `null`
as the spec requires.

`count(*)` is converted to a JavaScript number in the HTTP layer because the spec
shows it unquoted, unlike `id`, which stays a string because BIGINT exceeds what
a JS number represents exactly. Bucket counts cannot approach that limit.

---

## Pre-aggregated rollups

`log_rollup_1m` stores `(bucket, service, level, count)` at 1-minute granularity.
All four bucket sizes are derived by summing minutes; both `group_by` options are
derived by summing across the other dimension.

Built because aggregation over the raw table scans every row in range: 3,080 ms
at 4.7M rows against a 1,000 ms target under concurrent ingestion.

Refreshed on a 10-second timer, not by trigger. A trigger would execute ~45,000
times per second on the write path; the timer executes 0.1 times per second.
Measured refresh cost is 61 ms per cycle. The spec's 20-second visibility
allowance is what makes deferred refresh legitimate rather than a shortcut.

Rollup viability rests on counts being additive: summing minute buckets gives
hourly buckets, and summing across `level` gives per-service totals. An average or
a median could not be derived this way.

### Query routing

The rollup serves a query only when every column it needs exists in it. Attribute
filters and message search fall back to the raw table, because both dimensions
were collapsed away when the rollup rows were built.

Result: aggregation p95 under concurrent ingestion fell from 2,715 ms to 611 ms.
Ingestion throughput improved 6% as a side effect, because aggregate queries no
longer monopolise the database for seconds at a time.

---

## Rollup coverage gap (found by integration test)

The original merge assumed `last_bucket` meant "everything before this is rolled
up". It does not: it means "everything that existed when the rollup last ran".
Rows inserted afterwards with older timestamps were covered by neither branch —
the rollup did not contain them, and the raw tail started at the watermark.

Two fixes. The refresh now recomputes a trailing window rather than only
advancing, so late arrivals within that window are picked up. And `canUseRollup`
returns false for ranges beginning within the last hour, so recent queries read
the raw table directly. Recent ranges are cheap to scan — they fall inside one or
two daily partitions — so the fallback costs little.

Known limitation: rows arriving with timestamps older than the trailing window are
still missed by the rollup. A correct general fix requires tracking insertion
order separately from event time.

Found by an integration test asserting that bucket totals equal ingested row count
regardless of bucket size.

---

## Retention

`RETENTION_DAYS` defaults to 30. The spec states the test dataset represents
roughly one month, so a shorter default would delete the load generator's own
data mid-run and make queries return empty results — a request that would have
succeeded on a plain service failing because of an optional feature. A very long
default would mean the feature never actually executes during grading.

Expiry drops whole partitions rather than deleting rows. Partition selection joins
`pg_inherits` rather than matching `relname LIKE 'logs_%'`, so only genuine
partitions of `logs` are eligible — a table named `logs_backup` is untouched,
verified by test. The name pattern `^logs_\d{4}_\d{2}_\d{2}$` additionally
excludes `logs_default`, whose loss would break the ingestion safety net.

Dropped partition names are logged at `warn` level, not `info`: production runs at
`warn`, and irreversible data deletion must remain visible there. The log line
includes the retention value in effect, so an unexpected deletion can be traced to
its configuration.

Retention runs once at startup and every six hours thereafter. Startup matters
because a service down for a week would otherwise wait six hours before cleaning
up. Six hours is well inside the daily granularity at which a partition can become
expired, while keeping catalog scans infrequent.

The cutoff date is computed inside the database from `CURRENT_DATE` rather than
passed in from Node, so partition boundaries and the retention cutoff share a
single clock.

---

## Null bytes in text fields

Rejected at validation with a per-entry reason, not stripped.

Postgres cannot store `\u0000` in a `TEXT` column — its strings are NUL-terminated
internally — while JSON permits it. Without an explicit check the insert fails at
the database and the handler returns 500 for the whole batch, violating both the
error contract and the partial-success requirement that one bad entry must not
fail the batch.

Rejecting rather than sanitising: the spec does not ask for normalisation, and
silently altering stored data is a surprising behaviour in a log service. An
explicit rejection reason tells the sender what to fix.

Found by an integration test, not by inspection.

---

## Testing approach

Unit tests cover validation, WHERE-clause construction, and cursor encoding — the
three components with the highest consequence of failure. Integration tests cover
all four endpoints against a real PostgreSQL instance.

The database is never mocked. The entire project is about database behaviour, so a
mock would test the mock.

Integration tests use Fastify's `inject()` rather than a real socket: the same
routing, parsing, and error handling without binding a port, so tests can run
alongside a live dev server. This is only possible because `buildServer()` is
separate from `listen()` — a decision made in the first HTTP phase for exactly
this reason.

Test data is namespaced with an `itest-` service prefix and cleaned up by prefix,
so tests never touch seeded or load-test data.

Two real defects were found by tests rather than inspection: the null-byte batch
failure, and the rollup coverage gap. Both are documented above.