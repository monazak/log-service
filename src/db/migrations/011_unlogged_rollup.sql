-- Makes the rollup tables UNLOGGED.
--
-- UNLOGGED tables skip WAL entirely: no write-ahead logging, no crash recovery.
-- The rollup is derived data — every row is recomputable from `logs` — so
-- durability buys nothing here, while WAL writes compete directly with ingestion
-- on a saturated single CPU.
--
-- Cost: the table is truncated if Postgres shuts down uncleanly. The refresh
-- function recomputes a trailing window on every pass, so recent data self-heals;
-- older buckets would need a manual rebuild. Acceptable for a cache that exists
-- purely to accelerate reads.

ALTER TABLE log_rollup_1m SET UNLOGGED;
ALTER TABLE log_rollup_state SET UNLOGGED;