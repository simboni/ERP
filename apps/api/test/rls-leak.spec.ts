/**
 * Cross-tenant leak tests — the CI security gate from 05-security.md §5.
 * These hit PostgreSQL directly as the runtime role (jenga_app) and attack
 * the RLS policies: wrong tenant context, no context, cross-tenant writes,
 * audit-log tampering. Any leaked row fails the build.
 *
 * Requires jenga_test migrated (pnpm db:migrate:test).
 */
import { randomUUID } from "node:crypto";
import { Pool, PoolClient } from "pg";

const APP_DB_URL =
  process.env.APP_DB_URL_TEST ??
  "postgres://jenga_app:app_dev_pw@localhost:5432/jenga_test";

describe("RLS tenant isolation", () => {
  let pool: Pool;
  let tenantA: string;
  let tenantB: string;
  let userA: string;
  let userB: string;

  const asTenant = async <T>(
    tenantId: string | null,
    userId: string | null,
    fn: (c: PoolClient) => Promise<T>,
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.current_tenant', $1, true), set_config('app.current_user', $2, true)",
        [tenantId ?? "", userId ?? ""],
      );
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: APP_DB_URL, max: 4 });
    const suffix = randomUUID().slice(0, 8);

    const mkUser = async (label: string): Promise<string> => {
      const res = await pool.query(
        `INSERT INTO users (email, password_hash, full_name)
         VALUES ($1, 'x', $2) RETURNING id`,
        [`${label}-${suffix}@test.local`, label],
      );
      return res.rows[0].id;
    };
    userA = await mkUser("user-a");
    userB = await mkUser("user-b");

    const mkTenant = async (label: string, owner: string): Promise<string> => {
      const res = await pool.query(
        "SELECT create_tenant_with_owner($1, $2, $3) AS id",
        [label, `${label}-${suffix}`, owner],
      );
      return res.rows[0].id;
    };
    tenantA = await mkTenant("tenant-a", userA);
    tenantB = await mkTenant("tenant-b", userB);
  });

  afterAll(async () => {
    await pool.end();
  });

  test("no tenant context => zero rows from every tenant table", async () => {
    await asTenant(null, null, async (c) => {
      for (const table of ["tenants", "memberships", "audit_log"]) {
        const res = await c.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect({ table, n: res.rows[0].n }).toEqual({ table, n: 0 });
      }
    });
  });

  test("tenant A context cannot read tenant B rows", async () => {
    await asTenant(tenantA, userA, async (c) => {
      const tenants = await c.query("SELECT id FROM tenants");
      expect(tenants.rows.map((r) => r.id)).toEqual([tenantA]);

      const members = await c.query(
        "SELECT tenant_id FROM memberships WHERE tenant_id = $1",
        [tenantB],
      );
      expect(members.rowCount).toBe(0);

      // Even without a WHERE clause, only tenant A rows are visible.
      const all = await c.query("SELECT DISTINCT tenant_id FROM memberships");
      expect(all.rows).toEqual([{ tenant_id: tenantA }]);
    });
  });

  test("cannot INSERT a membership into another tenant (WITH CHECK)", async () => {
    await expect(
      asTenant(tenantA, userA, (c) =>
        c.query(
          "INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'viewer')",
          [tenantB, userA],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  test("cross-tenant UPDATE affects zero rows", async () => {
    const res = await asTenant(tenantA, userA, (c) =>
      c.query("UPDATE memberships SET role = 'admin' WHERE tenant_id = $1", [
        tenantB,
      ]),
    );
    expect(res.rowCount).toBe(0);
    // And tenant B's owner really is untouched.
    const check = await asTenant(tenantB, userB, (c) =>
      c.query("SELECT role FROM memberships WHERE tenant_id = $1", [tenantB]),
    );
    expect(check.rows).toEqual([{ role: "owner" }]);
  });

  test("audit log is tenant-scoped and append-only", async () => {
    await asTenant(tenantA, userA, (c) =>
      c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, hash)
         VALUES ($1, $2, 'test.event', 'test', 'h1')`,
        [tenantA, userA],
      ),
    );

    // Tenant B sees none of tenant A's audit entries.
    const fromB = await asTenant(tenantB, userB, (c) =>
      c.query("SELECT count(*)::int AS n FROM audit_log"),
    );
    expect(fromB.rows[0].n).toBe(0);

    // Cross-tenant audit insert is rejected.
    await expect(
      asTenant(tenantA, userA, (c) =>
        c.query(
          `INSERT INTO audit_log (tenant_id, action, entity_type, hash)
           VALUES ($1, 'evil', 'test', 'h2')`,
          [tenantB],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);

    // UPDATE/DELETE are blocked at the grant level for the app role.
    await expect(
      asTenant(tenantA, userA, (c) =>
        c.query("UPDATE audit_log SET action = 'tampered'"),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      asTenant(tenantA, userA, (c) => c.query("DELETE FROM audit_log")),
    ).rejects.toThrow(/permission denied/i);
  });

  test("user context alone exposes only own memberships, not the tenant's", async () => {
    await asTenant(null, userA, async (c) => {
      const rows = await c.query("SELECT tenant_id, user_id FROM memberships");
      expect(rows.rows).toEqual([{ tenant_id: tenantA, user_id: userA }]);
      const tenants = await c.query("SELECT id FROM tenants ORDER BY id");
      expect(tenants.rows.map((r) => r.id)).toEqual([tenantA]);
    });
  });

  test("app role cannot bypass: no BYPASSRLS, no table ownership, no tenant INSERT", async () => {
    const attrs = await pool.query(
      "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user",
    );
    expect(attrs.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });

    const owned = await pool.query(
      `SELECT count(*)::int AS n FROM pg_tables
       WHERE schemaname = 'public' AND tableowner = current_user`,
    );
    expect(owned.rows[0].n).toBe(0);

    await expect(
      asTenant(tenantA, userA, (c) =>
        c.query("INSERT INTO tenants (name, slug) VALUES ('evil', 'evil')"),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});
