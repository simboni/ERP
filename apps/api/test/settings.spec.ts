/**
 * Settings hub tests against jenga_test:
 *  - business profile GET returns the tenant defaults and a read-only
 *    next-invoice/next-quote peek,
 *  - profile PATCH is owner/admin only, coalesces (only touches provided
 *    fields), trims, clears on empty string, validates currency / month /
 *    payment terms, and persists,
 *  - branch CRUD: create with contact details, list, PATCH edit, single
 *    default enforcement, and soft-deactivate.
 */
import { randomUUID } from "node:crypto";
import { ForbiddenException } from "@nestjs/common";
import type { TenantTokenClaims } from "@jenga/shared";
import { DbService } from "../src/db/db.service";
import { AuditService } from "../src/audit/audit.service";
import { FiscalService } from "../src/fiscal/fiscal.service";
import { SandboxFiscalProvider } from "../src/fiscal/provider";
import { FiscalController } from "../src/fiscal/fiscal.controller";
import { SettingsController } from "../src/tenants/settings.controller";
import { RolesGuard } from "../src/auth/guards";
import { Reflector } from "@nestjs/core";

process.env.APP_DB_URL =
  process.env.APP_DB_URL_TEST ??
  "postgres://jenga_app:app_dev_pw@localhost:5432/jenga_test";
process.env.WORKER_DB_URL =
  process.env.WORKER_DB_URL_TEST ??
  "postgres://jenga_worker:worker_dev_pw@localhost:5432/jenga_test";

describe("settings hub (business profile + branch CRUD)", () => {
  const db = new DbService();
  const audit = new AuditService();
  const settings = new SettingsController(db, audit);
  const fiscal = new FiscalController(
    db,
    new FiscalService(new SandboxFiscalProvider()),
    audit,
  );
  // A stand-in to prove @Roles metadata is honoured by the shared guard.
  const rolesGuard = new RolesGuard(new Reflector());

  let tenant: string;
  let owner: string;
  let cashier: string;
  let ownerClaims: TenantTokenClaims;
  let cashierClaims: TenantTokenClaims;

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    const mkUser = async (name: string) =>
      (
        await db.query(
          `INSERT INTO users (email, password_hash, full_name)
           VALUES ($1, 'x', $2) RETURNING id`,
          [`settings-${name}-${suffix}@test.local`, `Settings ${name}`],
        )
      ).rows[0].id as string;
    owner = await mkUser("Owner");
    cashier = await mkUser("Cashier");
    const t = await db.query(
      "SELECT create_tenant_with_owner($1, $2, $3) AS id",
      ["settings-co", `settings-co-${suffix}`, owner],
    );
    tenant = t.rows[0].id;
    ownerClaims = { sub: owner, tid: tenant, rol: "owner", typ: "tenant" };
    cashierClaims = { sub: cashier, tid: tenant, rol: "cashier", typ: "tenant" };
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  it("profile GET returns defaults plus a numbering peek", async () => {
    const p = await settings.getProfile(ownerClaims);
    expect(p.currency).toBe("KES");
    expect(p.fiscal_year_start_month).toBe(1);
    expect(p.default_vat_rate).toBe("16");
    expect(p.prices_vat_inclusive).toBe(false);
    expect(p.default_payment_terms_days).toBe(30);
    expect(p.next_invoice_no).toBe(1);
    expect(p.next_quote_no).toBe(1);
  });

  it("profile PATCH persists, trims, and coalesces", async () => {
    const saved = await settings.patchProfile(ownerClaims, {
      legal_name: "  Acme Traders Ltd  ",
      kra_pin: "P051234567X",
      vat_number: "0123456789",
      phone: "+254700000000",
      email: "hello@acme.co.ke",
      postal_address: "P.O. Box 1 Nairobi",
      physical_address: "Biashara St",
      invoice_prefix: "INV-",
      quote_prefix: "QTE-",
      invoice_footer: "Thank you for your business",
      currency: "kes",
      fiscal_year_start_month: 7,
      default_vat_rate: "16",
      prices_vat_inclusive: true,
      default_payment_terms_days: 14,
    });
    expect(saved.legal_name).toBe("Acme Traders Ltd"); // trimmed
    expect(saved.currency).toBe("KES"); // upper-cased
    expect(saved.fiscal_year_start_month).toBe(7);
    expect(saved.prices_vat_inclusive).toBe(true);
    expect(saved.default_payment_terms_days).toBe(14);

    // A second PATCH touching one field leaves the rest intact (coalesce).
    const again = await settings.patchProfile(ownerClaims, { phone: "0711" });
    expect(again.phone).toBe("0711");
    expect(again.legal_name).toBe("Acme Traders Ltd");
    expect(again.kra_pin).toBe("P051234567X");

    // Re-read from a fresh GET confirms persistence.
    const p = await settings.getProfile(ownerClaims);
    expect(p.vat_number).toBe("0123456789");
    expect(p.invoice_prefix).toBe("INV-");

    // Empty string clears the value to NULL.
    const cleared = await settings.patchProfile(ownerClaims, {
      invoice_footer: "   ",
    });
    expect(cleared.invoice_footer).toBeNull();
  });

  it("profile PATCH validates inputs and forbids non-admins", async () => {
    await expect(
      settings.patchProfile(ownerClaims, { name: "  " }),
    ).rejects.toThrow(/blank/);
    await expect(
      settings.patchProfile(ownerClaims, { currency: "kenya" }),
    ).rejects.toThrow(/ISO/);
    await expect(
      settings.patchProfile(ownerClaims, { fiscal_year_start_month: 13 }),
    ).rejects.toThrow(/1–12/);
    await expect(
      settings.patchProfile(ownerClaims, { default_payment_terms_days: -1 }),
    ).rejects.toThrow(/non-negative/);
    await expect(settings.patchProfile(ownerClaims, {})).rejects.toThrow(
      /No editable fields/,
    );

    // The @Roles("owner","admin") on patchProfile is enforced by RolesGuard.
    const ctx = {
      getHandler: () => settings.patchProfile,
      getClass: () => SettingsController,
      switchToHttp: () => ({ getRequest: () => ({ claims: cashierClaims }) }),
    } as never;
    expect(() => rolesGuard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it("branch CRUD: create, list, edit, single default, deactivate", async () => {
    const hq = await fiscal.createBranch(ownerClaims, {
      code: "HQ",
      name: "Head Office",
      phone: "0700111222",
      address: "CBD",
      isDefault: true,
    });
    expect(hq.is_default).toBe(true);
    expect(hq.active).toBe(true);
    expect(hq.phone).toBe("0700111222");

    const shop = await fiscal.createBranch(ownerClaims, {
      code: "SHOP2",
      name: "Westlands Shop",
    });
    expect(shop.is_default).toBe(false);

    let list = await fiscal.listBranches(ownerClaims);
    expect(list).toHaveLength(2);
    expect(list[0].is_default).toBe(true); // default sorts first

    // Promote the second branch: the first must lose default (unique index).
    const promoted = await fiscal.updateBranch(ownerClaims, shop.id, {
      isDefault: true,
      phone: "0722333444",
    });
    expect(promoted.is_default).toBe(true);
    expect(promoted.phone).toBe("0722333444");
    list = await fiscal.listBranches(ownerClaims);
    const hqAfter = list.find((b: { id: string }) => b.id === hq.id);
    expect(hqAfter.is_default).toBe(false);

    // Deactivate (soft delete) keeps the row for referential integrity.
    const off = await fiscal.updateBranch(ownerClaims, hq.id, {
      active: false,
    });
    expect(off.active).toBe(false);

    // Non-admins cannot create branches (guard metadata).
    const ctx = {
      getHandler: () => fiscal.createBranch,
      getClass: () => FiscalController,
      switchToHttp: () => ({ getRequest: () => ({ claims: cashierClaims }) }),
    } as never;
    expect(() => rolesGuard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
