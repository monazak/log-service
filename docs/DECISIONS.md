# Technical Decisions

A running log of choices made and why. Source material for the README.

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

## No ORM

Rejected Prisma and TypeORM because:

1. The demo requires `EXPLAIN ANALYZE` on important queries. Analyzing a plan
   for SQL you did not write is not meaningful.
2. Hitting 15k logs/sec requires Postgres `COPY`, which ORMs do not expose.
3. The app container has 256 MB RAM. Prisma's query engine is a significant
   fraction of that budget.
4. Phase 4 uses time-partitioned tables; ORM schema tooling handles these poorly.

Accepted cost: SQL injection safety is now our responsibility. The spec treats
injection as disqualifying. Mitigated by a single parameterized query builder
(all user input via placeholders, identifiers via allow-list) and dedicated tests.

## Validation split by call volume

Per-entry log validation runs ~15,000 times per second, so it is hand-written:
allocation-light, and gives exact control over the `{ index, reason }` rejection
format the spec requires.

Config loading and query parameter parsing run a few times per second, so they
use Zod, where clarity is worth more than nanoseconds.

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

## Logging

Application logging uses pino via Fastify. Per-request logging is disabled when
NODE_ENV=production, and the default level rises from `info` to `warn`.

Reason: at 15k logs/sec under a 0.5 CPU limit, per-request log serialization and
blocking writes to stdout consume CPU needed for parsing and database writes.
Docker's default json-file log driver also writes to disk without rotation, so
sustained load tests can produce gigabytes of container logs.

LOG_LEVEL overrides the default in any environment, so verbose debugging remains
available in a running container.

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