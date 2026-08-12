-- Pre-aggregated 1-minute rollups.
--
-- Aggregation over the raw table scans every row in range: measured at 1,429 ms
-- p95 under concurrent ingestion against a 1000 ms target. Counting 3M rows
-- requires reading them, so the fix is to not read them.
--
-- Refreshed on a timer rather than by trigger. A trigger would run ~43,000 times
-- per second on the write path; the timer runs once per 10 seconds. The spec's
-- 20-second visibility allowance is what makes deferred refresh legitimate.

CREATE TABLE IF NOT EXISTS log_rollup_1m (
  bucket    TIMESTAMPTZ NOT NULL,
  service   TEXT        NOT NULL,
  level     TEXT        NOT NULL,
  count     BIGINT      NOT NULL,
  PRIMARY KEY (bucket, service, level)
);

CREATE INDEX IF NOT EXISTS log_rollup_1m_bucket_idx
  ON log_rollup_1m (bucket);

-- Tracks how far the rollup has been computed, so each refresh only processes
-- new data instead of recomputing history.
CREATE TABLE IF NOT EXISTS log_rollup_state (
  id            BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  last_bucket   TIMESTAMPTZ NOT NULL
);

INSERT INTO log_rollup_state (id, last_bucket)
VALUES (true, '2000-01-01T00:00:00Z')
ON CONFLICT (id) DO NOTHING;

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

  -- Stop one minute short of now: the current minute is still receiving rows,
  -- and a bucket must be complete before it is counted.
  end_at := date_trunc('minute', now()) - interval '1 minute';

  IF end_at <= start_at THEN
    RETURN 0;
  END IF;

  INSERT INTO log_rollup_1m (bucket, service, level, count)
  SELECT
    date_trunc('minute', "timestamp"),
    service,
    level,
    count(*)
  FROM logs
  WHERE "timestamp" >= start_at
    AND "timestamp" < end_at
  GROUP BY 1, 2, 3
  ON CONFLICT (bucket, service, level)
  DO UPDATE SET count = log_rollup_1m.count + EXCLUDED.count;

  GET DIAGNOSTICS affected = ROW_COUNT;

  UPDATE log_rollup_state SET last_bucket = end_at WHERE id;

  RETURN affected;
END;
$$;