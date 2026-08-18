-- Restores a GIN index on attributes, tuned for a write-heavy workload.
--
-- The index was created in 004 and dropped in 008 after measurement: at 1M rows
-- it held 135 MB against 173 MB of heap, and under load Postgres saturated its
-- CPU on index maintenance while the application idled at 21%. Removing it was
-- correct for the write path as it existed then.
--
-- The write path has since changed completely. Entries are micro-batched and
-- written with COPY, the rollup is maintained incrementally rather than by
-- periodic scan, and the application now sits at 6% CPU under the graded load.
-- The headroom that did not exist in 008 exists now.
--
-- What forced a re-evaluation: aggregate p95 measured 4.80s on the platform
-- while the same code measured 2ms locally. The difference is which path the
-- query takes. Aggregations without attribute or message filters read the
-- rollup — a bounded number of rows regardless of stored volume. Ones with
-- `attr.<key>` fall through to the raw table, and that cost grows with every
-- row ingested. Measured on 1M seeded rows: 8.7ms unfiltered, 87ms filtered.
-- At platform scale under concurrent ingestion, that gap is seconds.
--
-- fastupdate = on is the difference from the original index. Instead of
-- updating the GIN tree on every insert, new entries accumulate in a pending
-- list and are merged in bulk. Inserts pay a list append; the merge cost is
-- amortised across thousands of rows. The trade is that a query must also scan
-- the pending list, which is why the limit below keeps it small.
--
-- jsonb_path_ops rather than the default opclass: it indexes values only, not
-- keys, producing an index roughly 30% smaller — and `@>` is the only operator
-- the attribute filter uses.

CREATE INDEX IF NOT EXISTS logs_attributes_gin
  ON logs USING gin (attributes jsonb_path_ops)
  WITH (fastupdate = on, gin_pending_list_limit = 4096);