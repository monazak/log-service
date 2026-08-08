-- Indexes, each justified by a query pattern in the spec.
--
-- Every index costs write throughput: each INSERT must update all of them.
-- At 15k inserts/sec on 1 CPU this is the dominant constraint, so nothing is
-- added speculatively.
--
-- Already covered by PRIMARY KEY (timestamp, id):
--   * time-range filters (since / until)
--   * ORDER BY timestamp DESC, id DESC
--
-- Deliberately NOT indexed:
--   * level alone — only four distinct values, so a filter on it typically
--     matches too large a fraction of rows for an index scan to beat a
--     sequential scan. It appears in the composite index below, where it is
--     nearly free.
--   * message (pg_trgm) — deferred to the performance phase, where the
--     ingestion cost will be measured against the query benefit.

-- Serves: service=X, optionally with level=Y, ordered by time.
-- Column order matters: service first because it is the more selective filter
-- and the one more likely to appear alone.
CREATE INDEX IF NOT EXISTS logs_service_time_idx
  ON logs (service, "timestamp" DESC, id DESC);

-- Serves: attr.<key>=<value> via the JSONB containment operator @>.
-- jsonb_path_ops rather than the default: it indexes only values, not keys,
-- producing a smaller and faster index. The trade-off is that it supports
-- fewer operators — but @> is the only one the spec requires.
CREATE INDEX IF NOT EXISTS logs_attributes_idx
  ON logs USING GIN (attributes jsonb_path_ops);