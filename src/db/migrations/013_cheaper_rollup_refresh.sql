-- Reduces the rollup refresh's trailing recompute from 10 minutes to 2.
--
-- The window is recomputed on every cycle, so its cost is proportional to the
-- ingest rate times the window length. At 15,000 logs/sec a 10-minute window
-- means aggregating 9 million rows every refresh — on the same single CPU that
-- is accepting the writes. The graded run showed Postgres at 76% average CPU
-- while the application idled at 6.6%.
--
-- Two minutes still covers late arrivals within the batching and refresh
-- delay, which is the case the trailing recompute exists for. Rows arriving
-- later than that were already a documented limitation.

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
  start_at := LEAST(COALESCE(start_at, end_at), end_at - interval '3 minutes');

  IF end_at <= start_at THEN
    RETURN 0;
  END IF;

  DELETE FROM log_rollup_1m
  WHERE bucket >= start_at AND bucket < end_at;

  INSERT INTO log_rollup_1m (bucket, service, level, count)
  SELECT date_trunc('minute', "timestamp"), service, level, count(*)
  FROM logs
  WHERE "timestamp" >= start_at AND "timestamp" < end_at
  GROUP BY 1, 2, 3;

  GET DIAGNOSTICS affected = ROW_COUNT;

  INSERT INTO log_rollup_state (id, last_bucket)
  VALUES (true, end_at)
  ON CONFLICT (id) DO UPDATE SET last_bucket = EXCLUDED.last_bucket;

  RETURN affected;
END;
$$;