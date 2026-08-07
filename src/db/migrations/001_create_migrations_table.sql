CREATE table IF NOT EXISTS schema_migrations(
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);