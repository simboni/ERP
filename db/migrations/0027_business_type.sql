-- 0027: Business type + per-tenant module visibility (industry foundation).
-- A switchboard that tailors the app per industry WITHOUT any per-industry
-- code: a business_type preset seeds which OPTIONAL modules a tenant sees,
-- and enabled_modules is the single source of truth the UI reads. Core
-- modules are always visible and never live here. Both columns hang off the
-- existing RLS-protected tenants row, so no new policies are needed — the
-- app role already holds UPDATE on tenants (granted in 0024).
--
-- The default for enabled_modules is EVERY optional module, so existing
-- tenants keep seeing the whole app — no regression on upgrade.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS business_type text NOT NULL DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS enabled_modules text[] NOT NULL
    DEFAULT ARRAY['pos','quotes','crm','projects','documents','finance','controls']::text[];
