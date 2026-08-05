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