-- Makes the rollup watermark survive an unlogged-table truncation.
--
-- log_rollup_state is UNLOGGED, so Postgres truncates it after an unclean
-- shutdown. The refresh function read the watermark with SELECT and wrote it
-- with UPDATE — both no-ops on an empty table — so the watermark would never be
-- restored, the rollup would never advance, and every rollup-routed aggregate
-- would return zero rows.
--
-- Two changes: COALESCE on the read so a missing watermark starts from the
-- trailing window rather than doing nothing, and an upsert on the write so the
-- row is recreated. The aggregate query separately falls back to '-infinity'
-- when the row is missing, so a query landing in that window reads the raw
-- table rather than returning an empty result.

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

  end_at := date_trunc('minute', now() - interval '15 seconds');

  -- COALESCE covers the truncated-table case: with no prior watermark, fall
  -- back to the trailing window instead of leaving start_at NULL, which would
  -- make every comparison below return NULL and the function a no-op.
  start_at := LEAST(COALESCE(start_at, end_at), end_at - interval '10 minutes');

  IF end_at <= start_at THEN
    RETURN 0;
  END IF;

  -- The window is recomputed, not accumulated, so rows are deleted before
  -- reinsertion. Adding to existing counts would double them on every pass.
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

  -- Upsert rather than UPDATE: the row may have been truncated away.
  INSERT INTO log_rollup_state (id, last_bucket)
  VALUES (true, end_at)
  ON CONFLICT (id) DO UPDATE SET last_bucket = EXCLUDED.last_bucket;

  RETURN affected;
END;
$$;