-- One-time cluster bootstrap. Run as a superuser BEFORE migrations:
--   sudo -u postgres psql -v ON_ERROR_STOP=1 -f db/bootstrap.sql
--
-- Two-role model (see docs/design/04-architecture.md §3):
--   jenga_migrator — owns the schema; used ONLY by the migration runner.
--   jenga_app      — runtime role; NOBYPASSRLS, never owns tables, so
--                    FORCE ROW LEVEL SECURITY applies to every query it runs.
-- Passwords here are local-development values; real environments inject them
-- via secret management (05-security.md §3).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jenga_migrator') THEN
    CREATE ROLE jenga_migrator LOGIN PASSWORD 'migrator_dev_pw';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jenga_app') THEN
    CREATE ROLE jenga_app LOGIN PASSWORD 'app_dev_pw' NOBYPASSRLS;
  END IF;
  -- Background fiscal worker: NOBYPASSRLS like the app role, but granted an
  -- explicit cross-tenant policy on the fiscal queue tables ONLY (it must
  -- drain the queue across tenants). It can touch nothing else.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jenga_worker') THEN
    CREATE ROLE jenga_worker LOGIN PASSWORD 'worker_dev_pw' NOBYPASSRLS;
  END IF;
END
$$;

SELECT 'CREATE DATABASE jenga_dev OWNER jenga_migrator'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'jenga_dev')
\gexec

SELECT 'CREATE DATABASE jenga_test OWNER jenga_migrator'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'jenga_test')
\gexec
