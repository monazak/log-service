-- Fixes a gap in rollup coverage.
--
-- The original refresh assumed time only moves forward: rows arriving with
-- timestamps older than the watermark were never rolled up, and the raw-tail
-- merge excluded them because it starts at the watermark. Late-arriving batches
-- — a client buffering and flushing — fell into that gap entirely.
--
-- The refresh now recomputes a trailing window on every run rather than only
-- advancing, so late arrivals within the window are picked up. Rows older than
-- the window are still missed; this is documented as a known limitation.

CREATE OR REPLACE FUNCTION refresh_log_rollup()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  start_at  TIMESTAMPTZ;
  end_at    TIMESTAMPTZ;
  affected  INTEGER;
BEGIN
  SELECT last_bucket INTO start_at FROM log_rollup_state WHERE id;

  end_at := date_trunc('minute', now()) - interval '1 minute';

  -- Recompute a trailing window so late-arriving rows are included.
  start_at := LEAST(start_at, end_at - interval '10 minutes');

  IF end_at <= start_at THEN
    RETURN 0;
  END IF;

  -- Delete before reinserting: the window is recomputed, not accumulated, so
  -- ON CONFLICT DO UPDATE with += would double-count on every pass.
  DELETE FROM log_rollup_1m
  WHERE bucket >= start_at AND bucket < end_at;

  INSERT INTO log_rollup_1m (bucket, service, level, count)
  SELECT
    date_trunc('minute', "timestamp"),
    service,
    level,
    count(*)
  FROM logs
  WHERE "timestamp" >= start_at
    AND "timestamp" < end_at
  GROUP BY 1, 2, 3;

  GET DIAGNOSTICS affected = ROW_COUNT;

  UPDATE log_rollup_state SET last_bucket = end_at WHERE id;

  RETURN affected;
END;
$$;