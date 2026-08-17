-- Tunes log_rollup_1m for the update-heavy access pattern it now has.
--
-- The rollup moved onto the write path: every batch upserts roughly twenty
-- rows. In Postgres an UPDATE writes a new tuple and leaves the old one dead,
-- so at 100 flushes per second this table accumulates ~2,000 dead tuples per
-- second — on a table that holds only twenty live rows per minute.
--
-- Three global settings make that worse than it needs to be:
--
--   fillfactor 100 (migration 009) leaves no free space on a page, which is
--   what a HOT update needs to place the new tuple beside the old one and skip
--   updating the indexes entirely.
--
--   autovacuum_vacuum_cost_delay 100ms and autovacuum_max_workers 1 were chosen
--   for an append-only table that barely needs vacuuming. This table needs it
--   constantly.
--
-- Left alone, the table bloats until an aggregate that should read twenty rows
-- is reading thousands of mostly-dead pages, and query latency climbs back over
-- the course of a long run. Local measurement never saw it because our runs are
-- two minutes.
--
-- Per-table storage parameters override the global ones.

ALTER TABLE log_rollup_1m SET (
  -- 30% free space per page so updates stay on-page and skip index maintenance.
  fillfactor = 70,

  -- Vacuum on an absolute threshold rather than a fraction of a small table:
  -- 5% of twenty rows would never trigger.
  autovacuum_vacuum_scale_factor = 0.0,
  autovacuum_vacuum_threshold = 1000,

  -- No throttling. This table is tiny; the vacuum is cheap and must keep up.
  autovacuum_vacuum_cost_delay = 0,

  -- Analyze often: the planner's row estimates drive whether it index-scans or
  -- seq-scans the rollup, and the row count changes constantly.
  autovacuum_analyze_scale_factor = 0.0,
  autovacuum_analyze_threshold = 1000
);

-- The new fillfactor applies to pages written from now on. Existing pages keep
-- their old packing until autovacuum rewrites them, which is acceptable: the
-- table is small and turns over constantly.
--
-- VACUUM FULL would apply it immediately but cannot run inside a transaction
-- block, and the migration runner wraps every file in one.