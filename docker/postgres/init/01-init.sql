-- LocaleHub bootstrap: application role + databases.
--
-- The application connects as `localehub_app`, which is NOT the owner of the tables and
-- NOT a superuser, so PostgreSQL row level security actually applies to it (spec §9.2).
-- Migrations run as `postgres` (the owner) via MIGRATE_DATABASE_URL.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'localehub_app') THEN
    CREATE ROLE localehub_app LOGIN PASSWORD 'localehub' NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

SELECT 'CREATE DATABASE localehub_test OWNER postgres'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'localehub_test')\gexec

GRANT CONNECT ON DATABASE localehub TO localehub_app;
GRANT CONNECT ON DATABASE localehub_test TO localehub_app;

\connect localehub
GRANT USAGE ON SCHEMA public TO localehub_app;
ALTER DEFAULT PRIVILEGES FOR USER postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO localehub_app;
ALTER DEFAULT PRIVILEGES FOR USER postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO localehub_app;

\connect localehub_test
GRANT USAGE ON SCHEMA public TO localehub_app;
ALTER DEFAULT PRIVILEGES FOR USER postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO localehub_app;
ALTER DEFAULT PRIVILEGES FOR USER postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO localehub_app;
