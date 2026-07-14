-- Role bootstrap for MANAGED PostgreSQL (Render/RDS/Neon) where you connect
-- as the database owner rather than a superuser. The owner acts as
-- jenga_migrator (runs migrations, owns tables); this script creates the
-- two runtime roles. Run once from a psql shell:
--
--   psql "$OWNER_DATABASE_URL" \
--     -v app_pw="'<strong-app-password>'" \
--     -v worker_pw="'<strong-worker-password>'" \
--     -f db/bootstrap-managed.sql
--
-- Then set on the API service:
--   APP_DB_URL    = owner URL with user jenga_app + the app password
--   WORKER_DB_URL = owner URL with user jenga_worker + the worker password
--   ADMIN_DB_URL  = the owner URL itself (migrations only)

SELECT set_config('vars.app_pw', :app_pw, false);
SELECT set_config('vars.worker_pw', :worker_pw, false);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jenga_app') THEN
    EXECUTE format('CREATE ROLE jenga_app LOGIN PASSWORD %L NOBYPASSRLS',
                   current_setting('vars.app_pw'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jenga_worker') THEN
    EXECUTE format('CREATE ROLE jenga_worker LOGIN PASSWORD %L NOBYPASSRLS',
                   current_setting('vars.worker_pw'));
  END IF;
END
$$;

GRANT CONNECT ON DATABASE :"DBNAME" TO jenga_app, jenga_worker;
