-- 0001: Tenancy & security core.
-- Pattern per docs/design/04-architecture.md §3 (verified AWS RLS pattern):
--   * every tenant-owned table carries tenant_id and FORCE ROW LEVEL SECURITY
--   * policies key off transaction-local settings app.current_tenant /
--     app.current_user set via set_config(..., true) — SET LOCAL semantics,
--     safe under transaction-mode connection pooling
--   * current_setting(name, true) yields NULL when unset, so with no tenant
--     context every policy evaluates false: deny by default
--   * jenga_app never owns tables and has NOBYPASSRLS, so RLS binds it always

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Tenants
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE,
  status     text NOT NULL DEFAULT 'active'
             CHECK (status IN ('active', 'suspended', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_self ON tenants
  USING (id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Users (global: one identity may belong to many tenants).
-- Not tenant-scoped, so no tenant RLS; access is app-layer-guarded and the
-- app role gets no DELETE. PII columns stay minimal until DPA tooling lands.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  password_hash text NOT NULL,
  full_name     text NOT NULL,
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'locked', 'closed')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_key ON users (lower(email));

-- ---------------------------------------------------------------------------
-- Memberships (tenant-scoped; also readable by the member themselves so a
-- logged-in user can list their workspaces before selecting a tenant).
-- ---------------------------------------------------------------------------
CREATE TABLE memberships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  user_id    uuid NOT NULL REFERENCES users (id),
  role       text NOT NULL CHECK (role IN
             ('owner', 'admin', 'accountant', 'cashier',
              'storekeeper', 'payroll', 'viewer')),
  status     text NOT NULL DEFAULT 'active'
             CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);

CREATE INDEX memberships_tenant_idx ON memberships (tenant_id, user_id);
CREATE INDEX memberships_user_idx ON memberships (user_id);

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;

CREATE POLICY membership_read ON memberships FOR SELECT
  USING (
    tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
    OR user_id = NULLIF(current_setting('app.current_user', true), '')::uuid
  );

CREATE POLICY membership_write ON memberships FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE POLICY membership_update ON memberships FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- A signed-in user may read the tenants they actively belong to (workspace
-- picker, pre-tenant-selection). The memberships subquery is itself subject
-- to memberships RLS, whose user_id arm grants exactly these rows.
CREATE POLICY tenant_member_read ON tenants FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.tenant_id = tenants.id
        AND m.user_id = NULLIF(current_setting('app.current_user', true), '')::uuid
        AND m.status = 'active'
    )
  );

-- ---------------------------------------------------------------------------
-- Refresh tokens (global; tied to user identity, not tenant).
-- ---------------------------------------------------------------------------
CREATE TABLE refresh_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

-- ---------------------------------------------------------------------------
-- Audit log: append-only, per-tenant hash chain (05-security.md §3).
-- No UPDATE/DELETE policies exist and the app role gets no such grants;
-- a trigger blocks them for every non-superuser role as defence in depth.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  actor_user_id uuid REFERENCES users (id),
  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     text,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash     text,
  hash          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_tenant_idx ON audit_log (tenant_id, id DESC);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_read ON audit_log FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE POLICY audit_insert ON audit_log FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE FUNCTION audit_log_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END
$$;

CREATE TRIGGER audit_log_no_rewrite
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- ---------------------------------------------------------------------------
-- Tenant provisioning: SECURITY DEFINER so signup (running as jenga_app,
-- which has no INSERT grant on tenants) can atomically create a tenant and
-- its owner membership. The function sets the tenant context itself so the
-- FORCE RLS policies pass for exactly the tenant being created.
-- ---------------------------------------------------------------------------
CREATE FUNCTION create_tenant_with_owner(
  p_name text,
  p_slug text,
  p_owner_user_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant_id uuid := gen_random_uuid();
BEGIN
  PERFORM set_config('app.current_tenant', v_tenant_id::text, true);
  INSERT INTO tenants (id, name, slug) VALUES (v_tenant_id, p_name, p_slug);
  INSERT INTO memberships (tenant_id, user_id, role)
  VALUES (v_tenant_id, p_owner_user_id, 'owner');
  RETURN v_tenant_id;
END
$$;

REVOKE ALL ON FUNCTION create_tenant_with_owner(text, text, uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Grants for the runtime role: least privilege, no DELETE anywhere,
-- no INSERT/UPDATE on tenants (provisioning goes through the function).
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO jenga_app;
GRANT SELECT ON tenants TO jenga_app;
GRANT SELECT, INSERT ON users TO jenga_app;
GRANT UPDATE (password_hash, full_name, status) ON users TO jenga_app;
GRANT SELECT, INSERT, UPDATE ON memberships TO jenga_app;
GRANT SELECT, INSERT ON refresh_tokens TO jenga_app;
GRANT UPDATE (revoked_at) ON refresh_tokens TO jenga_app;
GRANT SELECT, INSERT ON audit_log TO jenga_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO jenga_app;
GRANT EXECUTE ON FUNCTION create_tenant_with_owner(text, text, uuid) TO jenga_app;
