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

## Optimization 1: PostgreSQL memory and cost settings

Applied via `command:` in docker-compose.yml:

| Setting | Default | Applied | Reason |
|---|---|---|---|
| `shared_buffers` | 128 MB | 256 MB | ~25% of the 1 GB container limit |
| `work_mem` | 4 MB | 32 MB | Baseline sort spilled to disk at 4 MB |
| `effective_cache_size` | 4 GB | 768 MB | Planner estimate matching the container |
| `maintenance_work_mem` | 64 MB | 128 MB | Autovacuum keeps up under ingestion |
| `random_page_cost` | 4.0 | 1.1 | Default assumes spinning disks; this is SSD |

### Result: 7-day hourly aggregate

| Metric | Before | After | Change |
|---|---|---|---|
| Sort method | external merge, Disk 2552 kB | quicksort, Memory 6145 kB | spill eliminated |
| Sort node | 74.3 ms | 53.5 ms | −28% |
| Append node | 61.3 ms | 43.3 ms | −29% |
| **Execution** | **97.8 ms** | **81.2 ms** | **−17%** |
| Planning | 10.4 ms | 14.5 ms | +39% |

The Append improvement was not the direct target: larger `shared_buffers` keeps
index pages cached across the scan rather than re-reading them.

Planning got *slower*. Lowering `random_page_cost` and raising
`effective_cache_size` make the planner evaluate index paths it previously
dismissed on cost. This confirms planning overhead is a function of partition
count, not memory, and will not be fixed by configuration.

`work_mem` is allocated per sort operation, not per connection. With a pool of 8,
worst case is 8 × 32 MB = 256 MB on top of 256 MB shared_buffers, leaving
headroom inside the 1 GB limit. This bound only holds because the pool is small —
a decision made in phase 4 that constrains this one.

## Ingestion throughput

Measured against the production compose file (dev override excluded), with the
database already holding 1M rows.

| Metric | Value |
|---|---|
| Duration | 30 s |
| Batch size | 500 |
| Concurrency | 8 |
| Requests | 4,065 |
| Errors | 0 |
| Logs accepted | 2,032,500 |
| **Throughput** | **67,683 logs/sec** |
| Latency p50 | 68.0 ms |
| Latency p95 | 97.7 ms |
| Latency p99 | 106.6 ms |

Target is 15,000/sec; the spec lists 20,000 and 25,000 as additional credit.

Verified after the run: `count(*)` = 3,633,969 (1M seeded + 2M ingested), and
`logs_default` holds 0 rows, confirming every row was routed to its daily
partition rather than the fallback.

### Resource usage during the run

| Container | CPU (of limit) | Memory |
|---|---|---|
| app | 44–51% of 0.5 CPU — **saturated** | 54 MiB / 256 MiB |
| postgres | 66–86% of 1 CPU | 335 MiB / 1 GiB |

The application container is the bottleneck: it consumes essentially its entire
half-CPU allocation while Postgres retains 15–35% headroom. The work on that path
is JSON parsing of ~150 KB bodies, per-entry validation of 500 entries against six
rules, attribute serialization, and building 2,500 bind parameters.

This validates the phase 0 decision to hand-write per-entry validation rather
than use a schema library: validation sits directly on the CPU-bound path.

Memory is not a constraint — the app uses 22% of its limit, so
`--max-old-space-size=192` was never approached.

### Durability

Throughput is achieved with synchronous acknowledgement: the handler awaits the
INSERT before responding 200, so no batch is acknowledged before Postgres has
accepted it. The spec's "never respond 200 to a batch you have not durably
accepted" holds without special handling.