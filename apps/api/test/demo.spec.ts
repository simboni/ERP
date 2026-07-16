/**
 * Self-expiring DEMO tenants, against jenga_test:
 *  - POST /auth/demo creates a tenant flagged is_demo with a ~24h expiry and
 *    the industry preset modules, seeded with sample data, and hands back a
 *    session whose userToken authenticates,
 *  - purgeExpired() (after back-dating the expiry) erases the tenant and ALL
 *    of its rows across the tenant-scoped tables plus its demo user,
 *  - purge REFUSES to touch a real (non-demo) tenant.
 */
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import request from "supertest";

// The purge worker's background interval must stay off; the test drives the
// purge methods directly and deterministically.
process.env.DEMO_PURGE_ENABLED = "false";
process.env.APP_DB_URL =
  process.env.APP_DB_URL_TEST ??
  "postgres://jenga_app:app_dev_pw@localhost:5432/jenga_test";
process.env.WORKER_DB_URL =
  process.env.WORKER_DB_URL_TEST ??
  "postgres://jenga_worker:worker_dev_pw@localhost:5432/jenga_test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
import { AppModule } from "../src/app.module";
import { DemoPurgeService } from "../src/demo/demo-purge.service";

// A superuser connection for assertions that must see across RLS.
const admin = new Pool({
  connectionString:
    process.env.ADMIN_DB_URL_TEST ??
    "postgres://postgres:postgres@127.0.0.1:5432/jenga_test",
  max: 2,
});

const countFor = async (table: string, tenantId: string): Promise<number> => {
  const r = await admin.query(
    `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
    [tenantId],
  );
  return r.rows[0].n;
};

describe("demo tenants (self-expiring trials)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let purge: DemoPurgeService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    http = app.getHttpServer();
    purge = app.get(DemoPurgeService);
  });

  afterAll(async () => {
    await app.close();
    await admin.end();
  });

  test("POST /auth/demo creates a seeded, flagged, expiring workspace", async () => {
    const res = await request(http)
      .post("/auth/demo")
      .send({ businessType: "restaurant" });
    expect(res.status).toBe(201);

    const body = res.body as {
      userToken: string;
      refreshToken: string;
      tenantId: string;
      tenantName: string;
      email: string;
      expiresAt: string;
    };
    expect(body.userToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(body.tenantId).toBeTruthy();
    expect(body.tenantName).toBe("Demo Restaurant");
    expect(body.email).toMatch(/^demo-[0-9a-f]+@jenga\.demo$/);

    // Expiry ~24h out (allow a minute of slack for the round trip).
    const ms = new Date(body.expiresAt).getTime() - Date.now();
    expect(ms).toBeGreaterThan(23.9 * 3600 * 1000);
    expect(ms).toBeLessThan(24.1 * 3600 * 1000);

    // Flagged is_demo with the restaurant preset ["pos","documents"].
    const t = await admin.query(
      `SELECT is_demo, business_type, enabled_modules, demo_expires_at
       FROM tenants WHERE id = $1`,
      [body.tenantId],
    );
    expect(t.rows[0].is_demo).toBe(true);
    expect(t.rows[0].business_type).toBe("restaurant");
    expect([...t.rows[0].enabled_modules].sort()).toEqual(["documents", "pos"]);

    // Seeded: the workspace is not empty on first load.
    expect(await countFor("customers", body.tenantId)).toBeGreaterThan(0);
    expect(await countFor("items", body.tenantId)).toBeGreaterThan(0);
    expect(await countFor("employees", body.tenantId)).toBeGreaterThan(0);
    expect(await countFor("invoices", body.tenantId)).toBeGreaterThan(0);

    // The userToken authenticates: exchange it for a tenant-scoped token.
    const tok = await request(http)
      .post("/auth/tenant-token")
      .set("Authorization", `Bearer ${body.userToken}`)
      .send({ tenantId: body.tenantId });
    expect(tok.status).toBe(200);
    expect(tok.body.accessToken).toBeTruthy();
  });

  test("purgeExpired erases an expired demo tenant and ALL its data", async () => {
    const res = await request(http)
      .post("/auth/demo")
      .send({ businessType: "retail" });
    expect(res.status).toBe(201);
    const tenantId: string = res.body.tenantId;
    const email: string = res.body.email;

    // Confirm it has data before we reap it.
    expect(await countFor("customers", tenantId)).toBeGreaterThan(0);
    const userRow = await admin.query(
      "SELECT id FROM users WHERE lower(email) = lower($1)",
      [email],
    );
    const userId: string = userRow.rows[0].id;

    // Back-date the expiry so the scan picks it up.
    await admin.query(
      "UPDATE tenants SET demo_expires_at = now() - interval '1 hour' WHERE id = $1",
      [tenantId],
    );

    const purged = await purge.purgeExpired();
    expect(purged).toContain(tenantId);

    // Tenant row gone.
    const t = await admin.query("SELECT 1 FROM tenants WHERE id = $1", [
      tenantId,
    ]);
    expect(t.rowCount).toBe(0);

    // Every scoped table empty for that tenant (spot-check a few).
    expect(await countFor("customers", tenantId)).toBe(0);
    expect(await countFor("items", tenantId)).toBe(0);
    expect(await countFor("invoices", tenantId)).toBe(0);
    expect(await countFor("stock_movements", tenantId)).toBe(0);

    // Membership + the demo user itself are gone.
    const m = await admin.query(
      "SELECT 1 FROM memberships WHERE tenant_id = $1",
      [tenantId],
    );
    expect(m.rowCount).toBe(0);
    const u = await admin.query("SELECT 1 FROM users WHERE id = $1", [userId]);
    expect(u.rowCount).toBe(0);
  });

  test("purge REFUSES to touch a real (non-demo) tenant", async () => {
    const suffix = randomUUID().slice(0, 8);
    const owner = (
      await admin.query(
        `INSERT INTO users (email, password_hash, full_name)
         VALUES ($1, 'x', 'Real Owner') RETURNING id`,
        [`real-owner-${suffix}@test.local`],
      )
    ).rows[0].id;
    const realTenant = (
      await admin.query("SELECT create_tenant_with_owner($1, $2, $3) AS id", [
        "Real Co",
        `real-co-${suffix}`,
        owner,
      ])
    ).rows[0].id;

    // Direct purge of a real tenant is refused by the DB guard.
    await expect(purge.purgeTenant(realTenant)).rejects.toThrow(/non-demo/);

    // And the scan never selects it (it is not is_demo), even if expired-ish.
    const stillThere = await admin.query("SELECT 1 FROM tenants WHERE id = $1", [
      realTenant,
    ]);
    expect(stillThere.rowCount).toBe(1);

    // Cleanup.
    await admin.query("DELETE FROM memberships WHERE tenant_id = $1", [
      realTenant,
    ]);
    await admin.query("DELETE FROM tenants WHERE id = $1", [realTenant]);
    await admin.query("DELETE FROM users WHERE id = $1", [owner]);
  });
});
