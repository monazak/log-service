-- Partition management for the logs table.
--
-- Partitions do not create themselves. Without a partition covering "now",
-- every INSERT fails. This function is called at startup and hourly thereafter.

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
        'CREATE TABLE %I PARTITION OF logs FOR VALUES FROM (%L) TO (%L)',
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

-- Safety net: any row whose timestamp falls outside every partition lands here
-- instead of being rejected. Should stay empty in normal operation.
CREATE TABLE IF NOT EXISTS logs_default PARTITION OF logs DEFAULT;

-- Create the initial window so the service can accept writes immediately.
SELECT ensure_log_partitions(3);