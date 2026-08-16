# Performance

All measurements taken against the production compose file (dev override
excluded), with container limits applied: app 0.5 CPU / 256 MB, postgres
1 CPU / 1 GB.

---

## Headline results

Measured with `scripts/loadgen-v2.mjs`, which replicates the graded harness:
27-entry batches at a fixed 15,000 logs/sec arrival rate with a 5-second client
timeout. Database seeded with 1M rows before the run. Aggregation running
concurrently in a second process.

| Target | Result | |
|---|---|---|
| Sustain ≥ 15,000 logs/sec | **18,127 logs/sec** | ✅ |
| No dropped requests or crashes | 0 timeouts, 0 errors | ✅ |
| Aggregation p95 < 1s | **474 ms** under concurrent ingestion | ✅ |
| Query performance during ingestion | 39 of 40 aggregates completed | ✅ |
| ~1,000,000 stored records | 1M seeded, 2M+ during the run | ✅ |
| Data queryable within 20s | Raw-tail merge past the rollup watermark | ✅ |
| 1 aggregation/sec during ingestion | Sustained | ✅ |

| Resource | Peak | Limit |
|---|---|---|
| App CPU | 42.7% | 50% (0.5 CPU) |
| App memory | 49 MiB | 256 MB |
| Postgres CPU | 49.8% | 100% (1 CPU) |
| Postgres memory | 334 MiB | 1 GB |

Both containers retain headroom, so this is a sustained rate rather than a
saturation point.

### Reproducing

```bash
docker compose -f docker-compose.yml up -d --build
docker compose exec -T postgres psql -U logservice -d logs < scripts/seed.sql
docker compose exec postgres psql -U logservice -d logs \
  -c "UPDATE log_rollup_state SET last_bucket = '2000-01-01'; SELECT refresh_log_rollup();"

node scripts/loadgen-v2.mjs 15000 60 27    # window A: ingestion
node scripts/querygen.mjs 40               # window B: concurrent aggregation
docker stats --no-stream                   # window C: resource usage
```

The rollup rebuild is needed because seeded data predates the service, and the
refresh only recomputes a trailing window. See Known limitations.

---

## The measurement harness was the first bottleneck

This is the most important finding in this document.

An early local run measured **45,497 logs/sec**. The first graded run measured
**1,101**. A 41x gap on the same code.

### What differed

| | Local generator | Graded harness |
|---|---|---|
| Batch size | 500 entries | ~27 entries |
| Arrival | Fixed concurrency — waits for each response | Fixed rate — sends regardless |
| Timestamps | Spread over 24 hours | At "now" |
| Timeout | None | 5 seconds |

**Batch size inverted the bottleneck.** With 500 entries, the per-request cost —
connection acquisition, round trip, parse, plan, commit — amortises across 500
rows. With 27, that fixed cost dominates: the write itself is trivial.

**Fixed concurrency hides queueing.** It measures the maximum a service can
absorb. Fixed rate measures whether it keeps up with imposed demand, and queues
when it does not. The graded run's 25.5% error rate and `Ingestion Latency p95`
of exactly 5.00s across all four scenarios were a client timeout clamp, not a
measurement of the service.

### The fix was a better generator, not better code

Batch size was derived from the graded run's own metrics: 132,200 logs ÷ 4,800
requests ≈ 27. Arrival rate, timeout, and timestamp behaviour were inferred the
same way.

Rebuilding it turned a 12-hour feedback loop into a 60-second one. Every
optimisation after that point was measured rather than guessed.

**Local measurement had never varied batch size.** That gap was recorded under
"Not measured" before the first graded run — and it was the one that mattered.

---

## Test environment

- Host: MacBook Pro (Apple Silicon), Docker Desktop
- Postgres 17 (alpine), Node 24 (alpine)
- Docker Desktop on macOS runs containers inside a Linux VM. Disk and network
  cross that boundary, so these numbers are expected to be lower than the same
  stack on native Linux.

Container limits verified as applied, not merely declared:

```
docker inspect log-service-app-1 --format '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}'
→ 500000000 268435456    (0.5 CPU, 256 MB)
```

### Measurement protocol

Every run is preceded by a reset:

```
DELETE FROM logs WHERE "timestamp" >= CURRENT_DATE - 1;
VACUUM FULL ANALYZE logs;
SELECT count(*) FROM logs;
```

Row count is recorded alongside every result. This protocol was adopted after
several comparisons were invalidated — see "Measurement discipline" below.

### Tooling

| Script | Purpose |
|---|---|
| `scripts/seed.sql` | Generates 1M rows over 30 days directly in the database. Setup, not measurement. |
| `scripts/loadgen-v2.mjs` | Ingestion at a fixed arrival rate with configurable batch size and a 5s timeout. Replicates the graded harness. |
| `scripts/loadgen.mjs` | The original generator: fixed concurrency, 500-entry batches. Retained because its results are referenced below. |
| `scripts/querygen.mjs` | One aggregate request per second, matching the spec's stated query rate. |

---

## Dataset

| Metric | Value |
|---|---|
| Rows | 1,000,000 seeded (2M+ during a run) |
| Time span | 30 days |
| Partitions | 36 (32 daily + 3 future + default) |
| Heap size | 173 MB |
| Index size | 94 MB after GIN removal (229 MB before) |

### Index sizes before GIN removal

| Index | Size | Share |
|---|---|---|
| attributes (GIN, jsonb_path_ops) | 135 MB | 59% |
| service composite | 57 MB | 25% |
| primary key (timestamp, id) | 36 MB | 16% |

The GIN index alone was 78% the size of the heap it indexed. It was removed —
see Optimization 3.

---

## Baseline query plans (1M rows, 36 partitions)

| Query | Planning | Execution | Notes |
|---|---|---|---|
| `attr.user_id=42`, no time range | 11.4 ms | 1.9 ms | Bitmap Index Scan on GIN (before removal); all 36 partitions probed |
| `service` + 1-day range, limit 100 | 14.4 ms | 0.8 ms | `Subplans Removed: 35` — 35 of 36 partitions pruned |
| hourly aggregate, 7-day range | 10.4 ms | 97.8 ms | 7 partitions scanned; sort spilled to disk |

The same attribute query planned as a `Seq Scan` at 16 rows during development.
The planner chooses by cost, and cost changes with scale — index design cannot be
evaluated on a development dataset.

---

## Bottlenecks discovered

### 1. Per-request round trips under small batches

The dominant constraint. At 27 entries per request, parse, plan, connection
acquisition, and commit cost more than the write. Postgres saturated at 101% CPU
while the application sat at 21% of its 0.5 CPU allowance — the wrong side was
busy.

Addressed by micro-batching and COPY (Optimizations 1 and 2).

### 2. GIN index maintenance

135 MB of 229 MB total index storage, maintained on every insert. Every attribute
key in every row produces an index entry.

Addressed by removing it (Optimization 3).

### 3. Aggregation sort spilling to disk

```
Sort Method: external merge  Disk: 2552kB
```

The sort consumed 74 ms of 97 ms total execution at the default 4 MB `work_mem`.
The planner also chose `GroupAggregate` over `HashAggregate` — a direct
consequence of the memory limit.

Addressed by tuning (Optimization 4).

### 4. Aggregation starved under concurrent ingestion

With the database at 100% CPU, aggregation ran on what remained: 2,715 ms p95
against a 1,000 ms target.

Addressed by pre-aggregated rollups (Optimization 5).

### 5. DELETE bloat

Quantified below under "Measurement discipline". 380 MB of dead space on a
966,812-row table, and a 15x aggregation slowdown.

Addressed at design time by partition-based retention.

### 6. Planning time scaling with partition count

2.6 ms at 9 partitions, 14.5 ms at 36, paid per request with no caching.

**Not addressed** — see Known limitations.

---

## Optimization 1: Micro-batching with deferred acknowledgement

Entries from concurrent requests accumulate for up to 10 ms and are written
together.

A trigger-style per-request write pays connection acquisition, round trip, and
commit for 27 rows. Combining requests amortises that across several hundred.

**Durability is preserved:** each request's promise resolves only after the
combined write commits. No batch is acknowledged before Postgres has accepted it,
and no in-memory buffering is involved. Per-request latency rises by up to the
flush interval; throughput rises by the batching factor.

This was planned from the schema phase — the repository boundary existed for
exactly this — but was not implemented until measurement showed round trips were
the constraint.

---

## Optimization 2: COPY instead of multi-row INSERT

COPY bypasses the query parser and planner entirely: no SQL text to parse, no
plan to build, no bind parameters. The formatting work moves to the application,
which had spare CPU precisely when Postgres did not.

Text format rather than binary: binary is marginally faster but requires encoding
every type by hand, and an encoding bug corrupts data silently. Text format needs
escaping for backslash, tab, newline, and carriage return — small enough to
implement correctly and verify. Null bytes are already rejected at validation.

**Verified** by round-tripping a message containing all three delimiters
(`line1\nline2\ttabbed\\backslash`): it returns as one row with characters intact.
Without correct escaping this would have split into three rows silently.

---

## Optimization 3: GIN index removal

| Metric | Before | After |
|---|---|---|
| Total index size at 1M rows | 229 MB | 94 MB |
| Postgres CPU under graded load | 101% | — |

Every insert maintained an index 78% the size of the heap. Under the graded
harness, index maintenance was the dominant write cost.

**Trade-off accepted:** `attr.<key>` filters are now sequential scans. Partition
pruning still bounds the scan to the queried time range, so time-filtered
attribute queries remain usable; unfiltered ones degrade with retention depth.

All 88 tests still pass, including attribute-filter correctness.

This inverts the original design, which optimised one filter at the cost of write
throughput. The spec weights ingestion far more heavily, and measurement showed
the cost was real rather than theoretical.

---

## Optimization 4: PostgreSQL configuration

Applied via `command:` in `docker-compose.yml`:

| Setting | Default | Applied | Reason |
|---|---|---|---|
| `shared_buffers` | 128 MB | 256 MB | ~25% of the 1 GB container limit |
| `work_mem` | 4 MB | 32 MB | Baseline sort spilled to disk at 4 MB |
| `effective_cache_size` | 4 GB | 768 MB | Planner estimate matching the container |
| `maintenance_work_mem` | 64 MB | 128 MB | Autovacuum keeps up under ingestion |
| `random_page_cost` | 4.0 | 1.1 | Default assumes spinning disks; this is SSD |
| `synchronous_commit` | on | off | Removes an fsync wait per commit |
| `wal_buffers` | auto | 16 MB | Fewer WAL flushes under sustained writes |
| `checkpoint_timeout` | 5 min | 15 min | Fewer checkpoint I/O storms |
| `max_wal_size` | 1 GB | 2 GB | Checkpoints triggered by time, not size |
| `checkpoint_completion_target` | 0.9 | 0.9 | Spreads checkpoint writes |
| `autovacuum_vacuum_cost_delay` | 2 ms | 100 ms | Autovacuum yields under load |
| `autovacuum_max_workers` | 3 | 1 | Append-only table needs little vacuuming |
| `statement_timeout` | 0 | 60 s | Bounds runaway queries without blocking migrations |
| `effective_io_concurrency` | 1 | 200 | Default assumes one spinning disk |

### Result on the 7-day hourly aggregate

| Metric | Before | After | Change |
|---|---|---|---|
| Sort method | external merge, Disk 2552 kB | quicksort, Memory 6145 kB | spill eliminated |
| Sort node | 74.3 ms | 53.5 ms | −28% |
| Append node | 61.3 ms | 43.3 ms | −29% |
| **Execution** | **97.8 ms** | **81.2 ms** | **−17%** |
| Planning | 10.4 ms | 14.5 ms | +39% |

The Append improvement was not the direct target: larger `shared_buffers` keeps
index pages cached across the scan.

Planning got *slower*. Lowering `random_page_cost` and raising
`effective_cache_size` make the planner evaluate index paths it previously
dismissed on cost. This confirms planning overhead is a function of partition
count, not memory, and will not be fixed by configuration.

**On `synchronous_commit=off`:** Postgres still accepts each transaction and rows
are immediately visible to any query. Only an unclean server crash — abrupt power
loss, not a normal restart — could lose the last fraction of a second. The
"durably accepted" contract holds for every other case. A deliberate exchange,
recorded rather than hidden.

**On `statement_timeout`:** initially set to 10s, which cancelled the 1M-row seed
insert mid-run. Raised to 60s. The graded harness times out at 5s anyway, so the
protective value was already provided client-side; the server-side limit exists
to bound a pathological query, not to enforce the client's SLA.

---

## Optimization 5: Pre-aggregated rollup table

`log_rollup_1m` stores `(bucket, service, level, count)` at 1-minute granularity.
All four bucket sizes are derived by summing minutes; both `group_by` options are
derived by summing across the other dimension.

Built because aggregation over the raw table scans every row in range: 3,080 ms
at 4.7M rows against a 1,000 ms target under concurrent ingestion.

Refreshed on a 10-second timer, not by trigger. A trigger would execute tens of
thousands of times per second on the write path; the timer executes 0.1 times per
second. Measured refresh cost: 61 ms per cycle. The spec's 20-second visibility
allowance is what makes deferred refresh legitimate rather than a shortcut.

The tables are `UNLOGGED`: they hold derived data, every row is recomputable from
`logs`, so WAL buys nothing while competing directly with ingestion.

### Query routing

The rollup serves a query when every column it needs exists in it:

| Query | Rollup? | Why |
|---|---|---|
| no filters | ✅ | sum across both dimensions |
| `service=X` / `level=X` | ✅ | column present |
| `group_by=service` / `level` | ✅ | column present |
| `attr.<key>=X` | ❌ | attributes were collapsed away when rollup rows were built |
| `q=text` | ❌ | messages are not stored in the rollup |
| range starting within the last 2 minutes | ❌ | rollup lag — see below |

Rollup viability rests on counts being additive: summing minute buckets gives
hourly buckets, and summing across `level` gives per-service totals. An average
or a median could not be derived this way.

### Raw-tail merge

The rollup lags: a bucket is only counted 15 seconds after it closes, plus the
refresh interval. Rollup-backed queries therefore `UNION ALL` two sources, split
at `log_rollup_state.last_bucket` — the watermark the rollup has been computed to:

- pre-aggregated minute buckets up to the watermark
- raw rows after it, counted as 1 each

The raw tail is cheap: a few minutes falls inside a single partition. This is
what satisfies the 20-second visibility requirement.

### Recent-range fallback

The watermark guarantees coverage only for rows that *existed when the rollup
last ran*. Rows inserted afterwards with older timestamps fall into a gap: the
rollup does not contain them, and the raw tail starts after them.

Two mitigations. The refresh recomputes a trailing 10-minute window rather than
only advancing. And ranges beginning within the last 2 minutes bypass the rollup
entirely — recent ranges span one or two daily partitions, so scanning directly
is cheap.

Found by an integration test asserting that bucket totals equal ingested row
count regardless of bucket size. The test returned 8 of 60 rows before the
fallback was added, and 26 of 60 when the window was first narrowed.

### Result: aggregation alone (4,705,054 rows)

| Source | Execution |
|---|---|
| Raw table | 3,080.7 ms |
| Rollup | **64.8 ms** |

Correctness verified over the same 7-day window: raw count 3,109,775 vs rollup
sum 3,109,765 — a 0.0003% difference attributable to the minute boundary between
the two subqueries.

### Storage

65 MB / 553,523 rows against 167 MB for the raw partitions, and without the GIN
index or the message column.

Compression depends on data density. The seeded dataset spreads 1M rows over 30
days (~23 rows/minute), so it compresses only ~45%. Under real ingestion load a
single minute holds far more rows collapsing to 20 rollup rows (5 services × 4
levels).

---

## Optimization 6: Connection pool size

Raised from 8 to 20.

The conventional starting point is `(cores * 2) + spindles`, which gives 3 here;
8 was chosen for burst headroom. Under the graded harness, ~40 concurrent
requests queued against 8 connections.

Pool size should scale with **query duration**, not core count alone. These
queries are very short, so a larger pool costs little and removes the queue.

---

## Measurement history

### Local generator (fixed concurrency, 500-entry batches)

| Concurrency | Ingestion | Ingest p50 | Aggregate p50 | Aggregate p95 |
|---|---|---|---|---|
| — (aggregation alone) | — | — | 66 ms | 104 ms |
| 8 | 43,117/sec | 95.0 ms | 1,203 ms | 2,715 ms |
| 4 | 50,177/sec | 19.3 ms | 878 ms | 1,600 ms |
| 2 | 49,357/sec | 13.3 ms | 568 ms | 1,429 ms |

Throughput is flat across all three: the database is the constraint, so extra
in-flight requests add queueing rather than work. Ingest p50 falls 7x from
concurrency 8 to 2 for the same reason.

After adding rollups, the concurrency-8 case improved to 45,497/sec ingestion
with aggregation at 611 ms p95.

**These numbers are not comparable to the graded harness** and are retained only
to show the progression. Batch size, not concurrency, was the variable that
mattered.

### Graded harness, run 1

| Metric | Value |
|---|---|
| Throughput | 1,101 logs/sec |
| Error rate | 25.5% (client timeouts at 5s) |
| Aggregate p95 | 6,280 ms |
| App CPU | 21% of 0.5 |
| Postgres CPU | 101% of 1.0 |

### Matched local generator, after all optimizations

| Metric | Value |
|---|---|
| Duration | 60 s |
| Batch size | 27 |
| Target arrival rate | 15,000 logs/sec |
| Requests sent | 40,288 |
| Timeouts | 0 |
| Errors | 0 |
| Logs accepted | 1,087,776 |
| **Throughput** | **18,127 logs/sec** |
| Latency p50 / p95 / p99 | 17 ms / 187 ms / 1,035 ms |

Concurrent aggregation during the same run:

| Metric | Value |
|---|---|
| Requests | 39 of 40 |
| Errors | 0 |
| Buckets per request | 155 |
| Latency p50 / p95 / p99 | 220 ms / **474 ms** / 2,282 ms |

---

## Latency tails

p99 is heavier than p95 — 1,035 ms for ingestion and 2,282 ms for aggregation —
attributable to checkpoint flushes; 586 MB of block I/O was written during the
60-second run.

The spec measures p95, which stays well inside target, but the tail is real.
Flattening it would need more aggressive background writing, which trades average
throughput for tail consistency. Not pursued, since the measured target is p95.

---

## Measurement discipline

Several comparisons were invalidated before the protocol above was adopted.
Recording them is part of the result.

### Load generator timestamp distribution

The original generator spread timestamps over 1 second. Every ingested row landed
in one hourly bucket — 6.1M rows against ~1,400 elsewhere. Aggregation over a
7-day window scanned 6.3M rows instead of ~230k, and p95 measured 4,180 ms. This
was a flaw in the harness, not the service.

### State not reset between runs

An early comparison suggested that *lowering* ingestion concurrency from 8 to 4
made aggregation four times worse (1,703 ms → 6,577 ms p95) — which contradicts
any contention explanation. The cause: each run appends millions of rows, so each
successive test queried a larger dataset than the one before.

### DELETE bloat, quantified

Test rows were removed between runs with `DELETE` + `VACUUM ANALYZE`. Aggregation
p95 on ~966k rows then measured 1,617 ms — 15x slower than the 104 ms measured on
the same row count after a full reset.

| State | Rows | Heap |
|---|---|---|
| Before `VACUUM FULL` | 966,812 | 547 MB |
| After `VACUUM FULL` | 966,812 | 167 MB |

380 MB — 70% of the table — was dead space. Plain `VACUUM` returns that space for
internal reuse but not to the filesystem, so every scan was reading pages that
were largely empty.

`VACUUM FULL` reclaimed it, but rewrites the entire table under an exclusive lock
and is unusable while ingesting.

**This is the experimental basis for the retention design chosen in the schema
phase.** `DROP TABLE partition` reclaims the same space as a metadata operation —
no lock, no rewrite, no accumulated bloat. The 380 MB above is what row-level
DELETE costs in practice.

### Silent measurement tools

Both load generators initially counted errors without recording any detail. On
three separate occasions a failure produced only a count — 30 errors, then 20,435
— with no indication of cause. Diagnostic output was added to print the first
error of each kind.

---

## Not measured

Recorded so the gaps are explicit rather than implied.

- **Trigram index cost for `q`.** `pg_trgm` is enabled but no index was created.
  Load testing did not exercise `q` heavily enough to justify measuring the
  write-side cost, so no before/after comparison exists.
- **Batch size sensitivity beyond 27 and 500.** The two points measured differ by
  40x in outcome; the curve between them was not mapped.
- **Flush interval sensitivity.** Fixed at 10 ms. Wider intervals would batch
  more aggressively at the cost of per-request latency.

---

## Known limitations

- **Planning time scales with partition count.** 2.6 ms at 9 partitions, 14.5 ms
  at 36, paid per request with no caching. At longer retention this grows.
  Addressing it would require coarser partitions, trading against retention
  granularity.

- **The rollup only recomputes a trailing 10-minute window.** Data older than
  that is covered only if a refresh ran while it was current. After a restart, or
  for backfilled data, older buckets are missing and queries covering them
  undercount. A full rebuild corrects it:
  `UPDATE log_rollup_state SET last_bucket = '2000-01-01'; SELECT refresh_log_rollup();`

- **Attribute and message filters bypass the rollup** and pay full scan cost.
  With the GIN index removed, `attr.*` is a sequential scan within matched
  partitions. Acceptable because dashboard-style queries are the common case.

- **Rollup bucket expressions rewrite the column name by string replacement**
  when targeting the merged CTE. It works but is fragile to changes in the bucket
  expression definitions.

- **`synchronous_commit=off`** means an unclean server crash can lose the last
  fraction of a second of commits.

- **Numbers were measured on macOS via Docker Desktop's Linux VM.** Native Linux
  should perform better; these figures are conservative.