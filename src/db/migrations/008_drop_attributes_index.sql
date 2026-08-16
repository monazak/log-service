-- Drops the GIN index on attributes.
--
-- Measured: 135 MB of 229 MB total index size at 1M rows — 59% of all index
-- storage. Every insert maintains it, and under the graded load generator
-- Postgres saturates its single CPU at ~1,100 logs/sec while the application
-- container sits at 21% of its 0.5 CPU allowance. Index maintenance is the
-- dominant write cost.
--
-- Trade-off: attr.<key> filters become sequential scans. Partition pruning
-- still bounds that scan to the queried time range, so time-filtered attribute
-- queries remain usable; unfiltered ones degrade.
--
-- This is a deliberate exchange of read performance on one filter for write
-- throughput on the primary ingestion path.

DROP INDEX IF EXISTS logs_attributes_idx;