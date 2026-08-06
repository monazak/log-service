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