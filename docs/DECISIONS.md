# Technical Decisions

A running log of choices made and why. Source material for the README.

---

## Stack

| Concern | Choice | Reason |
|---|---|---|
| Runtime | Node.js 24 LTS | Mature Docker and CI support |
| HTTP framework | Fastify 5 | Fastest mainstream JSON server; matters at 15k logs/sec |
| Database access | `pg`, raw SQL | Must see and tune every query |
| Validation | Hand-rolled hot path, Zod at edges | Split by call volume — see below |
| Migrations | Numbered `.sql` files, custom runner | No magic; partition DDL under our control |
| Tests | Vitest | Native TypeScript, no compile step |
| Lint and format | Biome | One dependency, fast in CI |

---

## No ORM

Rejected Prisma and TypeORM because:

1. The demo requires `EXPLAIN ANALYZE` on important queries. Analyzing a plan
   for SQL you did not write is not meaningful.
2. Hitting 15k logs/sec requires Postgres `COPY`, which ORMs do not expose.
3. The app container has 256 MB RAM. Prisma's query engine is a significant
   fraction of that budget.
4. The `logs` table uses time partitioning; ORM schema tooling handles these poorly.

Accepted cost: SQL injection safety is now our responsibility. The spec treats
injection as disqualifying. Mitigated by a single parameterized query builder
(all user input via placeholders, identifiers via allow-list) and dedicated tests.

---

## Validation split by call volume

Per-entry log validation runs ~15,000 times per second, so it is hand-written:
allocation-light, and gives exact control over the `{ index, reason }` rejection
format the spec requires.

Config loading and query parameter parsing run a few times per second, so they
use Zod, where clarity is worth more than nanoseconds.

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
3. The ingestion write path will be rewritten during performance work
   (INSERT → batched COPY). Behind a repository boundary, that swap does not
   touch HTTP handlers.

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

Reason: at 15k logs/sec under a 0.5 CPU limit, per-request log serialization and
blocking writes to stdout consume CPU needed for parsing and database writes.
Docker's default json-file log driver also writes to disk without rotation, so
sustained load tests can produce gigabytes of container logs.

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

Expected trade-off: the GC runs more often under ingestion pressure. This is
deliberate — predictable short pauses beat sudden process death.

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

This is a number to measure, not assume. The performance phase will benchmark
4 / 8 / 16 / 32 and record the result.

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

Rejected — EAV side table (`log_id`, `key`, `value`): at ~3 attributes per entry
and 15k entries/sec, this turns 15k row inserts per second into 60k. Multi-key
filters also require repeated self-joins against a table growing 3x faster than
the log table itself. Not viable on a 1 CPU database.

Rejected — hybrid with promoted columns for hot keys: the load generator's
attribute keys are not known in advance, so promotion would be guesswork. Kept
as a documented upgrade path if profiling in the performance phase identifies
genuinely hot keys.

Known limitation: JSONB repeats key names in every row, inflating storage
relative to a normalized layout. Accepted in exchange for write throughput and
schema flexibility.

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
rows, and the composite index on `(service, timestamp)` does not include `level`
anyway, so the saving is largely notional. `CHECK (level IN (...))` provides
integrity without the type's costs.

`service` — rejected a separate `services` table with a foreign key. It would add
a join to every read query and a lookup-or-insert to every write, at 15k
writes/sec on 1 CPU. Postgres also stores these columns as `extended`, meaning
TOAST compresses repeated values automatically, so part of the expected
normalization saving happens without the operational cost.

General principle applied here: normalization trades operations for space. At
15k writes/sec on a single CPU, operations are the scarcer resource.

---

## Time partitioning

The `logs` table is range-partitioned on `timestamp`, one partition per day.

Rejected — `DELETE FROM logs WHERE timestamp < ...` for retention. Postgres marks
rows dead rather than removing them, so a delete reclaims no space until VACUUM
runs. On a 1 CPU database under sustained ingestion, VACUUM competes directly with
writes, and the deleted rows remain in the table and every index until it catches
up. A 200k-row delete also locks each row individually and writes hundreds of MB
of WAL. This breaks the spec requirement of "no long-running locks, excessive
table bloat, or major ingestion disruption."

`DROP TABLE logs_YYYY_MM_DD` is a metadata operation: milliseconds, full space
reclaimed immediately, negligible WAL, zero bloat, no impact on concurrent writes.

Secondary benefit: partition pruning. Queries with `since`/`until` skip
non-matching partitions entirely at plan time, which directly serves the p95
aggregation target.

Daily granularity chosen because the spec states ~1M rows ≈ one month. Daily gives
~33k rows per partition and ~30 live partitions — fine-grained enough for useful
retention, coarse enough that planning overhead stays low. Hourly would produce
720 partitions per month and slow query planning; monthly would make the smallest
deletable unit an entire month.

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
  Sequential IDs always append to the rightmost page, which stays cached. At 15k
  inserts/sec the random pattern causes measurably more page splits and WAL.
- Generation cost is non-trivial at 15k/sec on 0.5 CPU.
- Cursors carrying a UUID are larger and slower to parse.

UUID would be correct with multiple uncoordinated writers, or if IDs had to be
generated client-side before insert. Neither applies: a single database issues
all IDs at write time.

Note: a partitioned table requires the partition key in the primary key, so the
PK is `(timestamp, id)` rather than `(id)`. This matches the sort order the spec
requires, so the constraint costs nothing. The BIGSERIAL sequence is shared across
all partitions, keeping ids globally unique.

---

## Substring search on `message` (the `q` parameter)

`pg_trgm` is enabled, but the trigram index is **not yet created**.

The spec requires `q` to be a case-insensitive substring match, which compiles to
`message ILIKE '%term%'`. A B-tree index cannot serve this: it is ordered
lexically, so it can answer "starts with" but not "contains". Without a suitable
index, every `q` query is a sequential scan over the full partition set.

`pg_trgm` decomposes text into three-character sequences and indexes those with
GIN, making mid-string matching index-assisted.

The cost is real: a trigram index can exceed the size of the column it indexes,
and every insert generates dozens of trigram entries to maintain. At 15k
inserts/sec that is a direct tax on the primary throughput target.

Decision deferred to the performance phase: measure the ingestion cost of the
index against the query cost without it, and decide based on how frequently the
load generator actually exercises `q`. Enabling the extension now avoids needing
a separate migration later.

---

## Migrations

Numbered `.sql` files in `src/db/migrations/`, applied by a custom ~60-line runner
at startup, before the service reports ready.

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

---

## Startup ordering

`src/index.ts` performs startup in a fixed order, and the order is load-bearing:

1. `listen()` — the port opens; `/health` answers **503**
2. `verifyConnection()` — database reachable
3. `runMigrations()` — schema present
4. `markReady()` — `/health` answers **200**

The spec states the service must report healthy only after the database
connection is established and migrations have been applied, and that the load
generator polls `/health` before starting. Reporting ready early means 15k
logs/sec arrive against an unprepared database; never reporting ready means the
submission is not graded at all.

Graceful shutdown reverses this: `markNotReady()` runs first so `/health` returns
503 and traffic stops being routed, then in-flight requests drain, then Fastify's
`onClose` hooks fire (closing the pool). A 10s timer force-exits if shutdown
itself hangs; `stop_grace_period: 15s` in compose leaves 5s of margin above it.

## Health check strategy

`GET /health` performs a live `SELECT 1`, cached for 5 seconds.

The load generator polls this endpoint continuously and begins sending 15k
logs/sec on the first 200, so the answer must be honest and cheap. A purely
in-memory flag would keep reporting healthy after the database dropped, and the
generator would keep sending data that cannot be stored. Querying on every poll
would instead consume the small connection pool that ingestion depends on.

Caching bounds the cost at one query per 5 seconds regardless of poll rate. The
check carries a 2s query timeout so a slow database cannot block the endpoint,
and recovery is automatic — no restart is needed once the database returns.

Startup state is tracked separately from the liveness check, so "still starting"
and "database unavailable" are distinguishable and the former costs no query.

## Ingestion write path

Batches are written with a single multi-row `INSERT` per chunk of up to 5000
entries, not one statement per entry. Each round trip to Postgres costs more
than the insert itself, so batching converts N round trips into one.

Chunking exists because Postgres caps a statement at 65535 bind parameters
(13107 rows at five columns) and because a single oversized statement would hold
a large parameter array and query string in a 256 MB process.

Dynamic SQL is limited to generating positional placeholders (`$1`, `$2`, ...)
from a loop counter. No user-supplied value ever enters the query text; values
travel separately in the parameter array and are never parsed as SQL.

This is the correct-but-unoptimized implementation. `COPY` is the expected
upgrade, deferred to the performance phase so the decision rests on a measured
comparison. The `insertLogs(pool, entries)` signature is the boundary that keeps
that swap invisible to callers.

## Retention

`RETENTION_DAYS` defaults to 30. The spec states the test dataset represents
roughly one month, so a shorter default would delete the load generator's own
data mid-run and make queries return empty results — a request that would have
succeeded on a plain service failing because of an optional feature. A very long
default would mean the feature never actually executes during grading.

Expiry drops whole partitions rather than deleting rows. Partition selection
joins `pg_inherits` rather than matching `relname LIKE 'logs_%'`, so only genuine
partitions of `logs` are eligible — a table named `logs_backup` is untouched,
verified by test. The name pattern `^logs_\d{4}_\d{2}_\d{2}$` additionally
excludes `logs_default`, whose loss would break the ingestion safety net.

Dropped partition names are logged at `warn` level, not `info`: production runs
at `warn`, and irreversible data deletion must remain visible there. The log line
includes the retention value in effect, so an unexpected deletion can be traced
to its configuration.

Retention runs once at startup and every six hours thereafter. Startup matters
because a service down for a week would otherwise wait six hours before cleaning
up. Six hours is well inside the daily granularity at which a partition can
become expired, while keeping catalog scans infrequent.

The cutoff date is computed inside the database from `CURRENT_DATE` rather than
passed in from Node, so partition boundaries and the retention cutoff share a
single clock.

## Null bytes in text fields

Rejected at validation with a per-entry reason, not stripped.

Postgres cannot store `\u0000` in a `TEXT` column — its strings are
NUL-terminated internally — while JSON permits it. Without an explicit check the
insert fails at the database and the handler returns 500 for the whole batch,
violating both the error contract and the partial-success requirement that one
bad entry must not fail the batch.

Rejecting rather than sanitising: the spec does not ask for normalisation, and
silently altering stored data is a surprising behaviour in a log service. An
explicit rejection reason tells the sender what to fix.

Found by an integration test, not by inspection.