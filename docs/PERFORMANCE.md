# Performance

All measurements taken with container limits applied
(app: 0.5 CPU / 256 MB, postgres: 1 CPU / 1 GB).

## Test environment

- Host: MacBook Pro (Apple Silicon), Docker Desktop
- Postgres 17 (alpine), Node 24 (alpine)
- Docker Desktop on macOS runs containers inside a Linux VM. Disk and network
  cross that boundary, so these numbers are expected to be lower than the same
  stack on native Linux.

## Dataset

| Metric | Value |
|---|---|
| Rows | 1,000,000 |
| Time span | 30 days |
| Partitions | 36 (32 daily + 3 future + default) |
| Heap size | 173 MB |
| Index size | 229 MB |
| Total | 402 MB |

### Index breakdown

| Index | Size | Share |
|---|---|---|
| attributes (GIN, jsonb_path_ops) | 135 MB | 59% |
| service composite | 57 MB | 25% |
| primary key (timestamp, id) | 36 MB | 16% |

The GIN index alone is 78% the size of the heap it indexes. `request_id` is
unique per row, so it contributes ~1M index entries for a lookup pattern that is
rarely used — a candidate for exclusion, measured rather than assumed.

## Baseline: aggregation

Query: hourly buckets over a 7-day range (~230k rows), no grouping.

| Metric | Value |
|---|---|
| Planning time | 10.4 ms |
| Execution time | 97.8 ms |
| Spec target | < 1000 ms at p95 |

Execution is well inside target. Planning time is the concern: it grew from
2.6 ms at 9 partitions to 10.4 ms at 36, roughly linear in partition count, and
is paid on every request with no caching. At 60 days of retention this would
approach 20 ms per request against a 1 CPU database that is also ingesting.

## Bottlenecks identified

_(to be filled as measured)_

## Optimizations applied

_(to be filled as applied)_

## Baseline measurements (1M rows, 36 partitions)

| Query | Planning | Execution | Notes |
|---|---|---|---|
| `attr.user_id=42`, no time range | 11.4 ms | 1.9 ms | Bitmap Index Scan on GIN, all 36 partitions probed |
| `service` + 1-day range, limit 100 | 14.4 ms | 0.8 ms | 35 of 36 partitions pruned at runtime |
| hourly aggregate, 7-day range | 10.4 ms | 97.8 ms | 7 partitions scanned, sort spills to disk |

## Bottlenecks identified

### 1. Planning time exceeds execution time on point queries

Planning costs 10–14 ms regardless of query, because the planner evaluates all
36 partitions before pruning them. Two of the three queries above spend more
time being planned than executed. Planning is paid per request and is not cached.

Growth is roughly linear in partition count: 2.6 ms at 9 partitions, 10.4 ms at
36. At 60-day retention this would approach 25 ms per request on a 1 CPU database
that is concurrently ingesting.

### 2. Aggregation sort spills to disk

`Sort Method: external merge  Disk: 2552kB`

The sort consumes 74 ms of the 97 ms execution time. `work_mem` defaults to 4 MB,
which is insufficient for 216k rows, so intermediate results are written to disk.
The planner also chose `GroupAggregate` (which requires sorted input) over
`HashAggregate` (which does not) — a direct consequence of the memory limit.

### 3. Index size relative to available cache

Indexes total 229 MB against 173 MB of heap. `shared_buffers` defaults to 128 MB,
so the working set does not fit in cache. The GIN index on `attributes` is 135 MB
of that, inflated by `request_id` being unique per row — 1M index entries serving
a lookup pattern that is rarely exercised.