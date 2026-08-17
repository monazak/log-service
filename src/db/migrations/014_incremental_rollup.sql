-- Moves rollup maintenance from a periodic scan onto the write path.
--
-- The graded run showed Postgres at 76% average CPU while the application idled
-- at 6.6%, writing only 2,647 logs/sec. Writes that small cannot saturate a
-- CPU; reads can. Aggregate p95 measured 4.91s, so roughly five aggregation
-- queries were running concurrently at any moment, each scanning the raw table.
--
-- They scanned it because every one of their queries starts inside the
-- two-minute recent-range fallback, which bypasses the rollup entirely. We paid
-- the rollup's maintenance cost and never used it once.
--
-- The fix inverts the direction. A batch already knows what it wrote, so it
-- computes its own per-minute counters — at most (services x levels) rows — and
-- upserts them in the same transaction as the COPY. The rollup is then exactly
-- consistent with `logs` at every commit: no watermark, no lag, no fallback
-- window, and no periodic scan.
--
-- The primary key (bucket, service, level) already provides the conflict target
-- the upsert arbitrates against.

-- The rollup was UNLOGGED because a scan could rebuild it. It is now maintained
-- transactionally alongside the writes it summarises, and every aggregation
-- reads it, so truncation after an unclean shutdown would silently zero the
-- endpoint. Write volume is now ~20 rows per batch rather than a window
-- recompute, so WAL costs little.
ALTER TABLE log_rollup_1m SET LOGGED;

-- Reconciliation, not the primary path.
--
-- The incremental upsert is authoritative. This exists for two cases it cannot
-- cover: rows already in `logs` before this migration ran, and any drift from a
-- transaction that committed the COPY but failed the upsert. It recomputes a
-- window from scratch rather than adding to it, so running it twice is safe.
CREATE OR REPLACE FUNCTION reconcile_log_rollup(window_start TIMESTAMPTZ,
                                                window_end   TIMESTAMPTZ)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  affected INTEGER;
BEGIN
  DELETE FROM log_rollup_1m
  WHERE bucket >= date_trunc('minute', window_start)
    AND bucket <  date_trunc('minute', window_end);

  INSERT INTO log_rollup_1m (bucket, service, level, count)
  SELECT date_trunc('minute', "timestamp"), service, level, count(*)
  FROM logs
  WHERE "timestamp" >= date_trunc('minute', window_start)
    AND "timestamp" <  date_trunc('minute', window_end)
  GROUP BY 1, 2, 3;

  GET DIAGNOSTICS affected = ROW_COUNT;

  RETURN affected;
END;
$$;

-- Retention drops raw partitions; the rollup needs the same cutoff, or it would
-- keep counting data whose rows no longer exist.
CREATE OR REPLACE FUNCTION prune_log_rollup(retention_days INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  affected INTEGER;
BEGIN
  DELETE FROM log_rollup_1m
  WHERE bucket < CURRENT_DATE - retention_days;

  GET DIAGNOSTICS affected = ROW_COUNT;

  RETURN affected;
END;
$$;

-- Backfill what is already stored, so aggregation is correct from the first
-- request after this migration rather than only for data written afterwards.
SELECT reconcile_log_rollup(
  COALESCE((SELECT min("timestamp") FROM logs), now()),
  now() + interval '1 minute'
);

-- The scan-based refresh and its watermark are superseded. Kept as a thin
-- wrapper so operational notes referencing it still work.
CREATE OR REPLACE FUNCTION refresh_log_rollup()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN reconcile_log_rollup(now() - interval '10 minutes',
                              now() + interval '1 minute');
END;
$$;