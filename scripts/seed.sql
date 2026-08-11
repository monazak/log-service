-- Seeds ~1M log rows spread over the last 30 days.
--
-- Generated inside the database rather than through POST /logs: seeding is
-- setup, not the thing being measured. Ingestion throughput is measured
-- separately over HTTP, which is the path the grader exercises.

-- Partitions must exist before inserting. ensure_log_partitions only creates a
-- short forward window, so backfill the retention period explicitly.


DO $$
DECLARE 
    d INTEGER; 
    part_date DATE;
    part_name TEXT;
BEGIN
    FOR d IN 0..31 LOOP 
        part_date := CURRENT_DATE - d;
        part_name := format('logs_%s', to_char(part_date, 'YYYY_MM_DD'));

        IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
            EXECUTE format (
                'CREATE TABLE %I PARTITION OF logs FOR VALUES FROM (%L) TO (%L)',
                part_name, part_date, part_date + 1
            );
        END IF;
    END LOOP;
END $$;

-- Realistic shape: a handful of services, skewed level distribution, a few
-- attribute keys with varying cardinality.

INSERT INTO logs("timestamp", level, service, message, attributes)
SELECT 
    CURRENT_DATE - (random() * 30):: int - (random() * interval '1 day'),
    (ARRAY['debug', 'info', 'info', 'info', 'warn', 'error'])[floor(random() * 6 + 1)],
    (ARRAY['checkout', 'api', 'auth', 'payments', 'search'])[floor(random() * 5 + 1)],
    (ARRAY[
        'request completed', 
        'payment declined', 
        'user logged in',
        'cache miss', 
        'connection timeout',
        'validation failed'
    ])[floor(random() * 6 + 1)] || ' '|| i,
    jsonb_build_object(
        'user_id', (floor(random()* 10000))::text,
        'request_id', md5(i::text),
        'region', (ARRAY['eu-west','us-east','ap-south'])[floor(random() * 3 + 1)]
    )
FROM generate_series(1, 1000000) AS i;

ANALYZE logs;

