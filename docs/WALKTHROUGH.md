# Walkthrough

A guided tour of the service for a reviewer or a live demo: what happens on each
request, which file to open, and the commands that demonstrate each claim.

Companion documents: [`DECISIONS.md`](DECISIONS.md) for why each choice was
made, [`PERFORMANCE.md`](PERFORMANCE.md) for measurements and methodology.

---

## Starting from nothing

```bash
docker compose -f docker-compose.yml up -d --build   # production config
curl -s localhost:8080/health                        # {"status":"ok"}
```

`/health` returns 503 until migrations have applied and a partition exists for
today, so a 200 means the service can actually accept a write. Startup order is
in [`src/index.ts`](../src/index.ts): listen first so the port answers honestly
while the database work happens, then migrate, then `markReady()`.

Two checks that back up the documentation:

```bash
scripts/conformance.sh        # 42 checks: every validation rule and documented 400
npm run test:db               # 97 tests against a real database
```

---

## The ingestion path

`POST /logs`, in the order the code runs:

| Step | File | What it decides |
|---|---|---|
| Envelope shape | [`domain/request.ts`](../src/domain/request.ts) `parseLogsEnvelope` | 400 on malformed JSON or a missing `logs` array |
| Per-entry validation | [`domain/validation.ts`](../src/domain/validation.ts) | Which entries are valid; each rejection carries its index and reason |
| Batch split | [`domain/batch.ts`](../src/domain/batch.ts) `validateBatch` | `{ valid, rejected }`; 400 only if *nothing* is valid |
| Queue | [`db/batcher.ts`](../src/db/batcher.ts) `submit` | Combines concurrent requests into one write |
| Write | [`db/repositories/logRepository.ts`](../src/db/repositories/logRepository.ts) `copyLogs` | COPY plus both rollup upserts, one transaction |

The two things worth pausing on:

**The caller's promise resolves after `COMMIT`, not after queueing.** That is
what keeps "never respond 200 to a batch you have not durably accepted" true
despite the batching. Micro-batching adds latency to a request; it never
acknowledges a write that did not happen.

**The rollups are updated inside the same transaction as the COPY.** So `logs`,
`log_rollup_1m` and `log_rollup_1s` cannot disagree at any commit — there is no
refresh lag, no watermark, and no "recent data" fallback in the read path.

Demonstrate the partial-batch contract:

```bash
curl -s -X POST localhost:8080/logs -H 'content-type: application/json' -d '{
  "logs": [
    {"timestamp":"2026-08-21T10:00:00Z","level":"error","service":"checkout","message":"ok"},
    {"timestamp":"2026-08-21T10:00:00Z","level":"critical","service":"checkout","message":"bad level"},
    {"timestamp":"2026-08-21T10:00:00Z","level":"info","service":"checkout","message":"nested","attributes":{"a":{"b":1}}}
  ]}'
```

```json
{"accepted":1,"rejected":[
  {"index":1,"reason":"invalid level: 'critical'"},
  {"index":2,"reason":"attribute 'a' must be a string, number, or boolean"}]}
```

---

## The query path

`GET /logs` parses in [`domain/query.ts`](../src/domain/query.ts), decodes the
cursor in [`domain/cursor.ts`](../src/domain/cursor.ts), and builds SQL in
[`db/queries/whereClause.ts`](../src/db/queries/whereClause.ts).

**Every user value becomes a bind parameter.** `whereClause.ts` is the only file
that builds dynamic SQL, and its `param()` helper pushes a value onto the array
and returns `$3` — a caller physically cannot interpolate a value into the text.
`bucket` and `group_by` cannot be bound (Postgres plans before binding), so they
select between fragments from a closed allow-list in
[`domain/aggregate.ts`](../src/domain/aggregate.ts).

### Plans to run live

Ordinary filter — index scan per partition, stops at the limit:

```sql
EXPLAIN (ANALYZE, COSTS OFF) SELECT id,"timestamp",level,service,message,attributes
FROM logs WHERE service='checkout' AND "timestamp" >= now() - interval '10 min'
ORDER BY "timestamp" DESC, id DESC LIMIT 101;
```

```
Limit (actual rows=101)
  ->  Merge Append
        ->  Index Scan Backward using logs_2026_08_21_service_timestamp_id_idx (actual rows=101)
        ->  Index Scan Backward using logs_2026_08_22_...        (actual rows=0)
Execution Time: 0.288 ms
```

Note the index is ascending and scanned **backwards**. A `DESC` index would
serve the same order at the same cost while inserting newest-first onto the
leftmost page, which splits 50/50 instead of 90/10: measured at 806 MB against
a 205 MB primary key on identical rows (migration 019).

---

## The aggregation path

This is the interesting one, and the one that moved the most.

`canUseRollup()` decides the source: any request without `attr.<key>` or `q` can
be answered from pre-aggregated counters. `buildRollupAggregateQuery()` then
splits the range:

```
since ├──────┬──────────────────────────────┬──────┤ until
      │ secs │        whole minutes         │ secs │
      └──1s──┴────────────1m────────────────┴──1s──┘
```

Whole minutes come from `log_rollup_1m`. Each partial minute at the ends comes
from `log_rollup_1s`, and where a probe can prove the rest of the minute empty,
from the minute row directly.

```sql
-- one hour, 1m buckets, over 559,053 stored rows
EXPLAIN (ANALYZE, COSTS OFF) ...   -- see the query the app builds
```

```
GroupAggregate (actual rows=3)
  ->  Sort (actual rows=60)
        ->  Append (actual rows=60)
              ->  Index Scan using log_rollup_1s_pkey    (actual rows=0)
              ->  Bitmap Heap Scan on log_rollup_1m      (actual rows=60)
                    Heap Blocks: exact=2
              ->  Index Scan using log_rollup_1s_pkey    (actual rows=0)
Execution Time: 0.361 ms
```

**60 rows and 2 heap blocks to aggregate an hour of a half-million-row table.**
Before the partial-minute work, the same query counted up to 900,000 raw rows
one at a time — 438 ms locally, 1.41–3.32 s p95 on the graded platform.

Prove the routing is invisible:

```bash
DATABASE_URL=postgres://logservice:logservice@127.0.0.1:55432/logs \
  node scripts/difftest.mjs
# all 24 ranges match the raw table exactly
```

Run it *during* ingestion. A rollup that is only eventually consistent passes on
an idle database and fails here.

### The `min()` probe, and why not `EXISTS`

```sql
(SELECT min("timestamp") FROM logs WHERE "timestamp" >= $1 AND "timestamp" < $2) IS NOT NULL
```

`EXISTS` tells the planner it may stop at the first matching row, so it picks a
sequential scan expecting to reach one immediately. The answer this probe wants
is usually *no*, and proving a range empty by sequential scan reads the whole
partition — 78,231 buffers to clear one minute. `min()` over an indexed column is
rewritten into "walk the index, take the first row", which has no sequential-scan
form to fall back to. Same answer, 0.17 ms. **The difference is 394 ms.**

---

## Retention

[`db/retention.ts`](../src/db/retention.ts) `dropExpiredPartitions` drops whole
daily partitions rather than deleting rows.

```sql
DROP TABLE logs_2026_07_21;   -- metadata operation: milliseconds, no row churn
```

`DELETE` would write a dead tuple per row, leave the space needing vacuum, and
generate WAL proportional to the data removed — while competing with ingestion
for the same CPU. `RETENTION_DAYS` defaults to 30. Both rollups are pruned on
the same cutoff, or they would keep counting rows that no longer exist.

---

## Questions worth rehearsing

**Why JSONB rather than an EAV table?** At ~3 attributes per entry, EAV turns
one insert into four and makes multi-key filters repeated self-joins against a
table growing 3× faster than `logs`. Values are coerced to strings at ingestion
so `attr.retries=3` matches whether the client sent `3` or `"3"` — JSONB
distinguishes them, the spec does not.

**Why is `level` not indexed on its own?** Four distinct values, so a filter on
it matches too large a fraction of rows for an index scan to beat a sequential
scan. It rides along as the third column of the service index.

**What happens at 45,000 logs/sec?** 44,929 accepted, nothing rejected,
aggregate p95 4.3 ms. Adaptive batch sizing: the busier the writers, the more
entries accumulate for the next COPY.

**What breaks first?** `GET /logs?q=<term>` with no `service` filter — see Known
limitations in the README. And planning time grows with partition count, 2.6 ms
at 9 partitions to 14.5 ms at 36.

**Something that measured well and was wrong.** Two things, both reverted, both
in [`DECISIONS.md`](DECISIONS.md): flushing on arrival, and a trigram index on
`message`. Each looked good locally and cost points on the graded platform,
because this machine had database headroom the platform does not.
