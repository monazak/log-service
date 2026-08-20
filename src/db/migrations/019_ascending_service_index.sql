-- Drops DESC from the service index.
--
-- `(service, "timestamp" DESC, id DESC)` from migration 004 chose its direction
-- to match the query's ORDER BY. That was unnecessary: a btree is traversable
-- both ways, so `ORDER BY "timestamp" DESC, id DESC` is served by scanning an
-- ascending index backwards — same rows, same order, no sort node. Verified on
-- the resulting plan, which is a Merge Append over per-partition
-- `Index Scan Backward`.
--
-- Ascending is the better direction because it matches how rows arrive. Within
-- one service the newest row then has the *largest* key, so inserts land at the
-- right edge of a leaf page, where Postgres splits 90/10 for an append instead
-- of 50/50 for an insertion into the middle.
--
-- Measured by building both indexes empty on the same partition and growing them
-- under the same 15,000 logs/sec run, 1,351,350 rows:
--
--   (service, "timestamp", id)             94 MB
--   (service, "timestamp" DESC, id DESC)  102 MB
--
-- 8%, not the multiple a first look at a long-running database suggested — that
-- database's 80 bytes per row was accumulated bloat across many runs, not an
-- artefact of the sort direction. The gain here is modest and worth taking: it
-- is a smaller index on the write path, it costs nothing at read time, and the
-- ascending form is also what lets the aggregate's `min("timestamp")` guards
-- resolve a service-filtered probe by index-only scan.

DROP INDEX IF EXISTS logs_service_time_idx;

CREATE INDEX IF NOT EXISTS logs_service_time_idx
  ON logs (service, "timestamp", id);
