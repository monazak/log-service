-- Core log storage.
--
-- Design decisions (see docs/DECISIONS.md):
--   * attributes as JSONB      — arbitrary user-defined keys, one row per entry
--   * daily range partitioning — retention by DROP TABLE, plus partition pruning
--   * PRIMARY KEY (timestamp, id) — deterministic ordering; partition key must
--        

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS logs(
    id         BIGSERIAL, 
    timestamp  TIMESTAMPTZ NOT NULL,
    level      TEXT        NOT NULL CHECK(level IN ('debug', 'info', 'warn', 'error')),
    service    TEXT        NOT NULL CHECK(length(service) > 0), 
    message    TEXT        NOT NULL CHECK(length(message) > 0),
    attributes JSONB       NOT NULL DEFAULT '{}'::jsonb, 
    PRIMARY KEY (timestamp, id)
) PARTITION BY RANGE (timestamp);