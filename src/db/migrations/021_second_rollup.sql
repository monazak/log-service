-- A second-granularity rollup, so a partial minute never scans raw rows.
--
-- Migration 014 put the minute rollup on the write path, and f860c63 taught the
-- aggregate query to answer a partial minute from it whenever the rest of that
-- minute is empty. Both edges of a range are usually partial, because a client
-- computing `since` as `Date.now() - N` never lands on a minute boundary.
--
-- The trailing edge is fine: `until` is normally "now", nothing has been written
-- past it, and the probe proves the minute empty beyond it for the cost of an
-- index descent. The leading edge is not. The minute containing `since` almost
-- always holds rows *before* `since` — that is what "an hour ago" means once a
-- run has been going an hour — so the probe fails and the query falls back to
-- counting raw rows one at a time. At 15,000 logs/sec that is up to 900,000
-- rows for a single aggregate, measured at 129-212 ms locally and 1.41-3.32 s
-- p95 on the graded platform, which is where the query score went.
--
-- Finer buckets bound that fallback. With per-second counters the leading edge
-- costs at most one second of raw rows instead of sixty, and the same
-- empty-gap probe usually removes even those. The cost is one more upsert per
-- batch: a flush spans well under a second, so it touches roughly as many
-- second-rows as minute-rows.
--
-- Kept alongside the minute rollup rather than replacing it. A seven-day range
-- covers 604,800 seconds but only 10,080 minutes, so long ranges still read
-- minutes and only the two partial edges read seconds.

CREATE TABLE IF NOT EXISTS log_rollup_1s (
  bucket    TIMESTAMPTZ NOT NULL,
  service   TEXT        NOT NULL,
  level     TEXT        NOT NULL,
  count     BIGINT      NOT NULL,
  PRIMARY KEY (bucket, service, level)
);

-- Same update-heavy tuning as migration 015 applied to the minute rollup: every
-- batch upserts into the same handful of live rows, so the table needs free
-- space for HOT updates and vacuum that is not throttled.
ALTER TABLE log_rollup_1s SET (
  fillfactor = 70,
  autovacuum_vacuum_scale_factor = 0.0,
  autovacuum_vacuum_threshold = 1000,
  autovacuum_vacuum_cost_delay = 0,
  autovacuum_analyze_scale_factor = 0.0,
  autovacuum_analyze_threshold = 1000
);

-- Which buckets this table can be trusted for.
--
-- The table is only complete for the period it has been maintained over. Rows
-- written to `logs` before it existed are absent, and pruning deliberately
-- removes old seconds. A query that read it outside that window would silently
-- undercount, so the window is recorded rather than assumed.
CREATE TABLE IF NOT EXISTS log_rollup_1s_state (
  id                 BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  authoritative_from TIMESTAMPTZ NOT NULL
);

-- Backfill before claiming authority, so the claim is true on a database that
-- already holds data. On a fresh one this aggregates nothing.
INSERT INTO log_rollup_1s (bucket, service, level, count)
SELECT date_trunc('second', "timestamp"), service, level, count(*)
FROM logs
GROUP BY 1, 2, 3
ON CONFLICT (bucket, service, level)
DO UPDATE SET count = EXCLUDED.count;

INSERT INTO log_rollup_1s_state (id, authoritative_from)
VALUES (true, '-infinity')
ON CONFLICT (id) DO NOTHING;

-- Deletes seconds older than the retention window and raises the watermark to
-- match, in one transaction so no query can observe a window the table no
-- longer covers. Returns the new watermark.
CREATE OR REPLACE FUNCTION prune_log_rollup_1s(retention_minutes INTEGER)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
AS $$
DECLARE
  cutoff TIMESTAMPTZ;
  result TIMESTAMPTZ;
BEGIN
  cutoff := date_trunc('minute', now()) - make_interval(mins => retention_minutes);

  DELETE FROM log_rollup_1s WHERE bucket < cutoff;

  UPDATE log_rollup_1s_state
     SET authoritative_from = greatest(authoritative_from, cutoff)
   WHERE id
  RETURNING authoritative_from INTO result;

  RETURN result;
END;
$$;
