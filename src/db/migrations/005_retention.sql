-- Retention: drops whole partitions rather than deleting rows.
--
-- DELETE marks rows dead without reclaiming space, writes hundreds of MB of WAL,
-- and leaves the table bloated until VACUUM catches up — on a 1 CPU database
-- competing with sustained ingestion. DROP TABLE is a metadata operation:
-- milliseconds, full space reclaimed, negligible WAL, no impact on writers.

CREATE OR REPLACE FUNCTION drop_expired_log_partitions(retention_days INTEGER)
RETURNS TABLE (dropped_partition TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
  cutoff      DATE;
  part_record RECORD;
BEGIN
  IF retention_days < 1 THEN
    RAISE EXCEPTION 'retention_days must be at least 1, got %', retention_days;
  END IF;

  cutoff := CURRENT_DATE - retention_days;

  FOR part_record IN
    SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class parent ON parent.oid = i.inhparent
    WHERE parent.relname = 'logs'
      AND c.relname ~ '^logs_\d{4}_\d{2}_\d{2}$'
      AND to_date(right(c.relname, 10), 'YYYY_MM_DD') < cutoff
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS %I', part_record.name);
    dropped_partition := part_record.name;
    RETURN NEXT;
  END LOOP;
END;
$$;