-- A trigram index for the `q` substring filter.
--
-- `q` compiles to `message ILIKE '%term%'`. A B-tree cannot serve that: it is
-- ordered lexically, so it answers "starts with" and not "contains". Every `q`
-- query has therefore been a sequential scan over whatever partitions the time
-- range matched.
--
-- Measured under concurrent ingestion on 1.7M rows: 25 ms for an unfiltered
-- aggregate, 660 ms for the same aggregate with `q`. The platform reports
-- aggregate p95 around four seconds on a larger dataset, and this is the only
-- query shape that scales that way.
--
-- The index was deferred in the original design, and the reason was written
-- down at the time: a trigram index can exceed the size of the column it
-- indexes, and every insert generates dozens of entries to maintain. That was
-- the correct call when the GIN index on attributes was already saturating the
-- write path. It is no longer the same write path — entries are micro-batched
-- and written with COPY, and the application sits at 6% CPU under load.
--
-- fastupdate = on is what makes it affordable, and the same reasoning as
-- migration 016: new entries accumulate in a pending list and merge in bulk
-- rather than updating the tree on every insert. The pending list limit keeps
-- the portion a query must also scan small.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS logs_message_trgm
  ON logs USING gin (message gin_trgm_ops)
  WITH (fastupdate = on, gin_pending_list_limit = 4096);