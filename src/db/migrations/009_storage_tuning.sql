-- Reduces per-row write cost on leaf partitions.
--
-- Storage parameters cannot be set on a partitioned parent — it holds no rows —
-- so they are applied when each partition is created, and backfilled onto
-- existing ones here.
--
-- fillfactor=100: the default 90 reserves free space on every page for future
-- in-place updates. This table is append-only, so that reservation is pure
-- waste: 10% more pages written per row.

DO $$
DECLARE
  part_name TEXT;
BEGIN
  FOR part_name IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'logs'
  LOOP
    EXECUTE format('ALTER TABLE %I SET (fillfactor = 100)', part_name);
  END LOOP;
END $$;

-- New partitions must get the same setting, so recreate the helper with it.
CREATE OR REPLACE FUNCTION ensure_log_partitions(days_ahead INTEGER DEFAULT 3)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  day_offset  INTEGER;
  part_date   DATE;
  part_name   TEXT;
  created     INTEGER := 0;
BEGIN
  FOR day_offset IN -1..days_ahead LOOP
    part_date := (CURRENT_DATE + day_offset);
    part_name := format('logs_%s', to_char(part_date, 'YYYY_MM_DD'));

    IF NOT EXISTS (
      SELECT 1 FROM pg_class WHERE relname = part_name
    ) THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF logs FOR VALUES FROM (%L) TO (%L) WITH (fillfactor = 100)',
        part_name,
        part_date,
        part_date + 1
      );
      created := created + 1;
    END IF;
  END LOOP;

  RETURN created;
END;
$$;