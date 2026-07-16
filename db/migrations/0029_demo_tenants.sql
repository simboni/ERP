-- 0029: Self-expiring DEMO / trial tenants.
--
-- A visitor can spin up a throwaway workspace pre-loaded with sample data for
-- their chosen industry. Everything they create is deleted automatically after
-- 24 hours by a background purge worker. Two columns flag such tenants:
--   * is_demo         — TRUE only for throwaway trial workspaces
--   * demo_expires_at — when the purge worker may reap it (now() + 24h)
-- Both hang off the existing RLS-protected tenants row, so no new policies are
-- needed for the app path; the default is_demo=false keeps every real tenant
-- untouched and out of the purge scan.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS demo_expires_at timestamptz;

-- Purge scan reads exactly (is_demo, demo_expires_at); a partial index keeps it
-- to the handful of live demo rows regardless of how many real tenants exist.
CREATE INDEX IF NOT EXISTS tenants_demo_purge_idx
  ON tenants (is_demo, demo_expires_at)
  WHERE is_demo;

-- ---------------------------------------------------------------------------
-- list_expired_demo_tenants(): the reaper's scan. SECURITY DEFINER so the
-- NOBYPASSRLS worker role can find expired demos cross-tenant WITHOUT being
-- granted SELECT on tenants/memberships (the tenant RLS policies subquery
-- memberships, which the worker must never read). Returns ONLY is_demo rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION list_expired_demo_tenants(p_limit int DEFAULT 100)
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM tenants
  WHERE is_demo = true AND demo_expires_at < now()
  ORDER BY demo_expires_at
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION list_expired_demo_tenants(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_expired_demo_tenants(int) TO jenga_worker;
GRANT EXECUTE ON FUNCTION list_expired_demo_tenants(int) TO jenga_app;

-- ---------------------------------------------------------------------------
-- purge_demo_tenant(): erase EVERY row a demo tenant owns, then the tenant and
-- its demo user(s). SECURITY DEFINER (same pattern as create_tenant_with_owner)
-- so it runs as the table owner and can reach the global tables (memberships,
-- refresh_tokens, users) and the append-only audit_log — none of which the
-- NOBYPASSRLS worker role could touch on its own.
--
-- Ordering: session_replication_role='replica' suspends FK-constraint triggers
-- AND the audit_log immutability trigger for this transaction, so tenant-scoped
-- tables can be deleted in any order. A bounded FK-violation retry loop is kept
-- as a belt-and-braces fallback (leaf-before-parent) in case replica mode is
-- ever unavailable.
--
-- SAFETY: the function REFUSES to touch any tenant that is not is_demo=true.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION purge_demo_tenant(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_demo   boolean;
  v_tables    text[];
  v_remaining text[];
  v_next      text[];
  v_tbl       text;
  v_pass      int;
  v_user_ids  uuid[];
  v_users_del int := 0;
BEGIN
  -- GUARD: only ever purge a flagged demo tenant. Never a real one.
  SELECT is_demo INTO v_is_demo FROM tenants WHERE id = p_tenant_id;
  IF v_is_demo IS NULL THEN
    RAISE EXCEPTION 'purge_demo_tenant: tenant % does not exist', p_tenant_id;
  END IF;
  IF NOT v_is_demo THEN
    RAISE EXCEPTION 'purge_demo_tenant: refusing to purge non-demo tenant %',
      p_tenant_id;
  END IF;

  -- Suspend FK triggers + the audit_log append-only trigger for this txn.
  PERFORM set_config('session_replication_role', 'replica', true);

  -- The demo user(s) that own this workspace (deleted last, only if orphaned).
  SELECT array_agg(user_id) INTO v_user_ids
  FROM memberships WHERE tenant_id = p_tenant_id;

  -- Every tenant-scoped table (has a tenant_id column), except tenants itself.
  SELECT array_agg(table_name::text) INTO v_tables
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND column_name = 'tenant_id'
    AND table_name <> 'tenants';

  v_remaining := coalesce(v_tables, ARRAY[]::text[]);
  FOR v_pass IN 1..25 LOOP
    EXIT WHEN array_length(v_remaining, 1) IS NULL;
    v_next := ARRAY[]::text[];
    FOREACH v_tbl IN ARRAY v_remaining LOOP
      BEGIN
        EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', v_tbl)
          USING p_tenant_id;
      EXCEPTION WHEN foreign_key_violation THEN
        -- Something still references this table's rows; retry next pass.
        v_next := array_append(v_next, v_tbl);
      END;
    END LOOP;
    v_remaining := v_next;
  END LOOP;
  IF array_length(v_remaining, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'purge_demo_tenant: unresolved FK ordering for tables %',
      v_remaining;
  END IF;

  -- Global tables the worker role cannot reach on its own.
  DELETE FROM memberships WHERE tenant_id = p_tenant_id;
  IF v_user_ids IS NOT NULL THEN
    DELETE FROM refresh_tokens WHERE user_id = ANY(v_user_ids);
    -- Only remove a user that no longer belongs to ANY workspace: a demo
    -- account belongs solely to its demo tenant, but this keeps a shared
    -- identity (should one ever exist) safe.
    WITH deleted AS (
      DELETE FROM users u
      WHERE u.id = ANY(v_user_ids)
        AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id)
      RETURNING 1
    )
    SELECT count(*)::int INTO v_users_del FROM deleted;
  END IF;

  -- Finally the tenant row itself (guard re-checked in the predicate).
  DELETE FROM tenants WHERE id = p_tenant_id AND is_demo;

  RETURN jsonb_build_object(
    'tenant_id', p_tenant_id,
    'tables_cleared', coalesce(array_length(v_tables, 1), 0),
    'users_deleted', v_users_del
  );
END
$$;

REVOKE ALL ON FUNCTION purge_demo_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_demo_tenant(uuid) TO jenga_worker;
GRANT EXECUTE ON FUNCTION purge_demo_tenant(uuid) TO jenga_app;
