/**
 * Industry foundation tests against jenga_test:
 *  - profile GET returns the default business_type 'general' and all 7
 *    optional modules (so existing tenants see the whole app),
 *  - PATCH sets a business type + a module subset and it persists,
 *  - PATCH with an unknown module key or unknown business type is rejected.
 */
import { randomUUID } from "node:crypto";
import type { TenantTokenClaims } from "@jenga/shared";
import { DbService } from "../src/db/db.service";
import { AuditService } from "../src/audit/audit.service";
import { SettingsController } from "../src/tenants/settings.controller";

process.env.APP_DB_URL =
  process.env.APP_DB_URL_TEST ??
  "postgres://jenga_app:app_dev_pw@localhost:5432/jenga_test";
process.env.WORKER_DB_URL =
  process.env.WORKER_DB_URL_TEST ??
  "postgres://jenga_worker:worker_dev_pw@localhost:5432/jenga_test";

describe("industry foundation (business type + module visibility)", () => {
  const db = new DbService();
  const audit = new AuditService();
  const settings = new SettingsController(db, audit);

  let tenant: string;
  let owner: string;
  let ownerClaims: TenantTokenClaims;

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    owner = (
      await db.query(
        `INSERT INTO users (email, password_hash, full_name)
         VALUES ($1, 'x', 'BizType Owner') RETURNING id`,
        [`biztype-owner-${suffix}@test.local`],
      )
    ).rows[0].id;
    const t = await db.query(
      "SELECT create_tenant_with_owner($1, $2, $3) AS id",
      ["biztype-co", `biztype-co-${suffix}`, owner],
    );
    tenant = t.rows[0].id;
    ownerClaims = { sub: owner, tid: tenant, rol: "owner", typ: "tenant" };
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  it("defaults: business_type 'general' + all 7 optional modules", async () => {
    const p = await settings.getProfile(ownerClaims);
    expect(p.business_type).toBe("general");
    expect([...p.enabled_modules].sort()).toEqual(
      ["controls", "crm", "documents", "finance", "pos", "projects", "quotes"],
    );
  });

  it("PATCH sets a type + module subset and persists", async () => {
    const saved = await settings.patchProfile(ownerClaims, {
      businessType: "restaurant",
      enabledModules: ["pos", "documents"],
    });
    expect(saved.business_type).toBe("restaurant");
    expect([...saved.enabled_modules].sort()).toEqual(["documents", "pos"]);

    // Coalesce: changing only the type leaves modules untouched.
    const again = await settings.patchProfile(ownerClaims, {
      businessType: "salon",
    });
    expect(again.business_type).toBe("salon");
    expect([...again.enabled_modules].sort()).toEqual(["documents", "pos"]);

    // Fresh GET confirms persistence.
    const p = await settings.getProfile(ownerClaims);
    expect(p.business_type).toBe("salon");
    expect([...p.enabled_modules].sort()).toEqual(["documents", "pos"]);
  });

  it("rejects an unknown business type", async () => {
    await expect(
      settings.patchProfile(ownerClaims, { businessType: "spaceship" }),
    ).rejects.toThrow(/businessType/);
  });

  it("rejects an unknown module key", async () => {
    await expect(
      settings.patchProfile(ownerClaims, {
        enabledModules: ["pos", "teleport"],
      }),
    ).rejects.toThrow(/enabledModules/);
  });
});
