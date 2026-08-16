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
2. Bulk ingestion needs direct control of the write mechanism. The path ended at
   `COPY`, which ORMs do not expose at all.
3. The app container has 256 MB RAM. Prisma's query engine is a significant
   fraction of that budget.
4. The `logs` table uses time partitioning; ORM schema tooling handles these poorly.

Accepted cost: SQL injection safety is now our responsibility. The spec treats
injection as disqualifying. Mitigated by a single parameterized query builder
(all user input via placeholders, identifiers via allow-list) and dedicated tests.

---

## Validation is hand-written, not schema-library based

Per-entry log validation runs on the hot path — tens of thousands of entries per
second — so it is hand-written: allocation-light, with exact control over the
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
- `db/` — connection pool, repositories, batching, SQL query construction.

`domain/` imports from neither of the others. Test: if the HTTP layer were
replaced by a CLI, `domain/` would not change.

Rationale:

1. Validation and query building are unit-testable as plain functions, with no
   server or database required.
2. All dynamic SQL construction is confined to `db/queries/`, giving a single
   auditable location for injection safety — necessary since we rejected an ORM.
3. The ingestion write path sits behind a repository boundary. That boundary was
   built specifically so the write mechanism could change without touching HTTP
   handlers, and it paid off: the path went from multi-row INSERT to micro-batched
   `COPY` with no change above `db/`.

---

## Import extensions

Relative imports use the `.ts` extension, enabled by `allowImportingTsExtensions`
and `rewriteRelativeImportExtensions`.

Reason: the dev loop runs `.ts` files directly through Node's type stripping,
which does not remap `.js` specifiers to `.ts` files. The production build runs
compiled output in `dist/`, which needs `.js`. Writing `.ts` and letting the
compiler rewrite on emit satisfies both without a second toolchain.

Consequence discovered later: type stripping removes type annotations but does
not *compile* anything. TypeScript syntax that generates code — parameter
properties, `enum`, `namespace`, decorators — fails at runtime in the dev loop
while passing `tsc` cleanly, because the two ask different questions. The
batcher's constructor was written with a parameter property and had to be
rewritten as an explicit field assignment. Dev and production containers differ
in capability, not only in speed.

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

Measured outcome: the application peaked at 49 MiB — 19% of its limit — during
load testing, so this ceiling was never approached. It remains as insurance
against a future change that allocates more per request.

Note: in the dev override, `node --watch` keeps the container alive after a
startup failure, so the port stays bound with no server behind it. Production
runs `node dist/index.js` directly, so a startup failure exits the process and
`restart: unless-stopped` retries. Startup failures should therefore always be
verified against the production compose file.

---

## Connection pooling

Pool size defaults to 20 (`DB_POOL_SIZE`), with `idleTimeoutMillis: 30000` and
`connectionTimeoutMillis: 5000`.

It started at 8. Postgres forks one OS process per connection, each holding
memory against a 1 GB budget on a 1 CPU container, and oversized pools cause
context-switch thrashing rather than throughput. The conventional starting point
is `(cores * 2) + spindles`, which gives 3 here; 8 allowed headroom for burst.

The graded harness disproved that reasoning for this workload. Roughly 40
concurrent requests queued against 8 connections while Postgres was the
bottleneck for a different reason entirely.

**The corrected rule: pool size should scale with query duration, not core count
alone.** Long queries against a saturated CPU make a large pool actively harmful —
which is what an earlier concurrency sweep (8 / 4 / 2 in-flight requests) showed,
with ingest p50 seven times worse at 8 than at 2. Very short queries make it
nearly free. These writes are very short, so 20 costs little and removes the
queue.

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

## Attribute storage: JSONB

Chosen: a single `attributes JSONB` column.

Rejected — EAV side table (`log_id`, `key`, `value`): at ~3 attributes per entry,
this turns every row insert into four. Multi-key filters also require repeated
self-joins against a table growing 3x faster than the log table itself. Not
viable on a 1 CPU database.

Rejected — hybrid with promoted columns for hot keys: the load generator's
attribute keys are not known in advance, so promotion would be guesswork. Kept
as a documented upgrade path.

Known limitation: JSONB repeats key names in every row, inflating storage
relative to a normalized layout. Accepted in exchange for write throughput and
schema flexibility.

### Value normalization

The spec requires `attr.<key>` to compare as strings, but permitted attribute
values are strings, numbers, or booleans. JSONB distinguishes `3` from `"3"`, so
`@> '{"retries":"3"}'` would not match a stored numeric `3`.

All attribute values are therefore coerced to strings at ingestion time. This
makes every equality filter a single containment check, and matches the spec's
response example, which shows attribute values as strings.

### The GIN index was built, measured, and removed

The original design indexed `attributes` with GIN using `jsonb_path_ops` —
chosen over the default opclass because it indexes values only, not keys,
producing an index roughly 30% smaller, and `@>` is the only operator the spec
requires.

Measurement removed it. At 1M rows the index occupied 135 MB against 173 MB of
heap — 78% the size of the data it indexed, and 59% of total index storage. Under
the graded load generator, Postgres saturated its single CPU at 1,101 logs/sec
while the application container sat at 21% of its allowance: index maintenance
was the dominant write cost, and every attribute key in every row produces an
index entry.

Dropped in migration `008`.

**Trade-off accepted:** `attr.<key>` filters are now sequential scans. Partition
pruning still bounds the scan to the queried time range, so time-filtered
attribute queries remain usable; unfiltered ones degrade with retention depth.
All 88 tests still pass, including attribute-filter correctness.

This inverts the original reasoning, which optimised one filter at the cost of
write throughput. The spec weights ingestion far more heavily, and measurement
showed the cost was real rather than theoretical.

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
tens of thousands of writes per second on a single CPU, operations are the
scarcer resource.

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

Partitions are created with `fillfactor = 100` (migration `009`). The default of
90 reserves free space on every page for future in-place updates; this table is
append-only, so that reservation is 10% more pages written per row for nothing.
Storage parameters cannot be set on a partitioned parent — it holds no rows — so
they are applied per partition, both to existing ones and inside
`ensure_log_partitions` for future ones.

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
`attributes` accounted for 59% of total index size before it was removed for
exactly that reason — direct evidence of what a second GIN index would cost the
write path.

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
matters, it is immutable. Changes go in a new numbered file. This is why the
performance work produced migrations `008`–`011` rather than edits to `002`–`007`:
`CREATE OR REPLACE FUNCTION` in a later file supersedes an earlier definition
without rewriting history. During early development `docker compose down -v` was
used to reset after editing an applied migration; this is safe only because no
other environment existed.

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
Fastify's `onClose` hooks fire — clearing timers, **draining the batcher**, then
closing the pool, in that order. Draining before closing the pool matters: queued
entries would otherwise fail their write and reject requests that had already been
told nothing. A 10s timer force-exits if shutdown itself hangs;
`stop_grace_period: 15s` in compose leaves 5s of margin above it.

---

## Health check strategy

`GET /health` performs a live `SELECT 1`, cached for 5 seconds.

The load generator polls this endpoint continuously and begins sending load on
the first 200, so the answer must be honest and cheap. A purely in-memory flag
would keep reporting healthy after the database dropped, and the generator would
keep sending data that cannot be stored. Querying on every poll would instead
consume the connection pool that ingestion depends on.

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

Three mechanisms, added in that order as measurement revealed each constraint.

### Multi-row INSERT (initial)

Batches were written with a single multi-row `INSERT` per chunk of up to 5000
entries, not one statement per entry. Each round trip to Postgres costs more than
the insert itself, so batching converted N round trips into one.

Chunking existed because Postgres caps a statement at 65535 bind parameters
(13107 rows at five columns) and because a single oversized statement would hold
a large parameter array and query string in a 256 MB process.

Dynamic SQL was limited to generating positional placeholders (`$1`, `$2`, ...)
from a loop counter. No user-supplied value entered the query text.

This measured 45,497 logs/sec locally with 500-entry batches, so `COPY` was
deferred. `insertLogs` remains in the repository, unused on the hot path.

### Micro-batching (added after the first graded run)

The graded harness sends ~27 entries per request. At that size the per-request
cost — connection acquisition, round trip, parse, plan, commit — dominates, while
the write itself is trivial. Postgres saturated at 101% CPU while the application
sat at 21% of its allowance.

Entries from concurrent requests now accumulate for up to 10 ms and are written
together, amortising that fixed cost across several hundred rows instead of 27.

This was planned from the schema phase — the repository boundary existed for
exactly this swap — but was not implemented until measurement showed round trips
were the constraint.

### COPY (replaced multi-row INSERT)

COPY bypasses the query parser and planner entirely: no SQL text to parse, no
plan to build, no bind parameters. The formatting work moves to the application,
which had spare CPU precisely when Postgres did not.

Text format rather than binary: binary is marginally faster but requires encoding
every type by hand, and an encoding bug corrupts data silently. Text format needs
escaping for backslash, tab, newline, and carriage return — small enough to
implement correctly and verify. Null bytes are already rejected at validation.

Verified by round-tripping a message containing all three delimiters
(`line1\nline2\ttabbed\\backslash`): it returns as one row with characters
intact. Without correct escaping it would have split into three rows silently.

### Durability is preserved throughout

Each request's promise resolves only after the combined write commits, so no
batch is acknowledged before Postgres has accepted it. The spec's "never respond
200 to a batch you have not durably accepted" holds without special handling —
no in-memory buffering is involved.

Per-request latency rises by up to the flush interval; throughput rises by the
batching factor.

---

## PostgreSQL configuration

Set via `command:` in `docker-compose.yml` rather than a mounted config file, so
the whole configuration is visible in one place and `docker compose up` needs no
extra files.

Two settings deserve explanation beyond "tuned for the container":

**`synchronous_commit=off`.** Postgres normally waits for WAL to reach disk before
acknowledging a commit. With this off, it acknowledges once WAL is in OS memory.
The transaction is still committed and rows are immediately visible to any query;
only an unclean server crash — abrupt power loss, not a normal restart — could
lose the last fraction of a second. The spec's "never respond 200 to a batch you
have not durably accepted" holds for every case except that one. A deliberate
exchange, recorded rather than hidden.

**`statement_timeout=60s`.** Initially set to 10s, which cancelled the 1M-row seed
insert mid-run and would equally have cancelled a long migration at startup —
turning a slow operation into a failed boot. Raised to 60s. The graded harness
times out at 5s anyway, so client-side protection already exists; the server-side
limit is there to bound a pathological query, not to enforce the client's SLA.

The rest — `shared_buffers`, `work_mem`, `effective_cache_size`,
`random_page_cost`, WAL and checkpoint sizing, autovacuum cost delay — are
container-appropriate values with measured effects, documented in
`docs/PERFORMANCE.md`.

---

## Dynamic query construction

All WHERE-clause construction lives in `db/queries/whereClause.ts`. A local
`param()` helper pushes a value onto the parameter array and returns only its
positional placeholder, so a caller cannot interpolate a user value into the SQL
text even by mistake. Confining dynamic SQL to one file makes the injection
surface auditable in a single place — necessary because we rejected an ORM.

Attribute filters compile to a single `attributes @> $n` containment check with
all requested keys and values serialized into one JSON parameter. The query text
is therefore identical regardless of which attribute keys the caller supplies.

`q` is escaped for LIKE metacharacters before being wrapped in wildcards. Without
this, `q=%` matches every row (a full scan of the retention window) and `q=100%`
silently means "contains 100" rather than the literal text. This is a correctness
and performance issue rather than an injection one — parameters already prevent
execution.

COPY introduced a second escaping surface. Text-format COPY delimits fields with
tabs and rows with newlines, so an unescaped message containing either would
corrupt row structure with no error raised. Backslash, tab, newline, and carriage
return are escaped; backslash first, or the escapes would escape each other.

A unit test asserts the injection invariant directly: every value in the parameter
array must be absent from the generated SQL text.

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
at 4.7M rows against a 1,000 ms target under concurrent ingestion. The rollup
answers the same query in 65 ms.

Refreshed on a 10-second timer, not by trigger. A trigger would execute tens of
thousands of times per second on the write path; the timer executes 0.1 times per
second. Measured refresh cost is 61 ms per cycle. The spec's 20-second visibility
allowance is what makes deferred refresh legitimate rather than a shortcut.

Rollup viability rests on counts being additive: summing minute buckets gives
hourly buckets, and summing across `level` gives per-service totals. An average or
a median could not be derived this way.

Both rollup tables are `UNLOGGED` (migration `011`). They hold derived data —
every row is recomputable from `logs` — so WAL buys nothing while competing
directly with ingestion for the same disk. The cost is that Postgres truncates
them after an unclean shutdown; the refresh self-heals recent data, and older
buckets need the manual rebuild documented in the README.

### Query routing

The rollup serves a query only when every column it needs exists in it. Attribute
filters and message search fall back to the raw table, because both dimensions
were collapsed away when the rollup rows were built. Ranges beginning within the
last two minutes also fall back — see below.

Result: aggregation p95 under concurrent ingestion fell from 2,715 ms to 611 ms
with the original 500-entry-batch generator, and measures 474 ms against the
harness-matched generator at 18,127 logs/sec ingestion. Ingestion throughput
improved as a side effect, because aggregate queries no longer monopolise the
database for seconds at a time.

---

## Rollup coverage gap (found by integration test)

The original merge assumed `last_bucket` meant "everything before this is rolled
up". It does not: it means "everything that existed when the rollup last ran".
Rows inserted afterwards with older timestamps were covered by neither branch —
the rollup did not contain them, and the raw tail started at the watermark.

Two fixes. The refresh recomputes a trailing 10-minute window rather than only
advancing, so late arrivals within that window are picked up. And `canUseRollup`
returns false for ranges beginning within the last two minutes, so recent queries
read the raw table directly. Recent ranges are cheap to scan — they fall inside
one or two daily partitions — so the fallback costs little.

The fallback window was initially one hour. That was too wide: the graded harness
runs for two minutes, so every one of its queries fell inside the window and the
rollup was never used at all — paying its write cost while delivering nothing.
Narrowing it to two minutes then exposed the coverage gap in the other direction:
aggregate totals dropped from 60 to 26 in a test, because queries began routing
to a rollup that did not cover the full range.

Known limitation: rows arriving with timestamps older than the trailing window are
still missed by the rollup. A correct general fix requires tracking insertion
order separately from event time.

Found by an integration test asserting that bucket totals equal ingested row count
regardless of bucket size.

---

## Unlogged tables and watermark loss

Making the rollup tables UNLOGGED removed their WAL cost, but Postgres truncates
unlogged tables after an unclean shutdown — and `log_rollup_state` holds a single
row that the entire rollup path depends on.

Two failure modes followed, neither of which raised an error:

The aggregate query joins its CTE against that row. A `CROSS JOIN` with zero rows
yields zero rows, so every rollup-routed aggregate would return `{"buckets": []}`
— an empty result with a 200 status.

The refresh function read the watermark with `SELECT` and wrote it with `UPDATE`,
both no-ops on an empty table. The watermark would never be restored, so the
condition was permanent rather than transient.

Fixed in two places. The query coalesces a missing watermark to `-infinity`, which
sends the whole range down the raw-table branch — slower but correct. The refresh
coalesces on read and upserts on write, so the row returns on the next cycle.

Found by deliberately truncating the table and querying, not by inspection. The
lesson generalises: making a table UNLOGGED is not free just because its contents
are derived — anything reading it must handle its absence.

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
failure, and the rollup coverage gap. Both are documented above. A third — the
COPY escaping surface — was verified by test before it could become a defect.