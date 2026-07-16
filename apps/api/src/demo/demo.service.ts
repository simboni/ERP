import { Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { AuthService } from "../auth/auth.service";
import { DbService } from "../db/db.service";
import { InvoicesService } from "../invoicing/invoices.service";
import {
  BUSINESS_TYPE_LABELS,
  isBusinessType,
  presetModules,
} from "../tenants/industry.constants";

export interface DemoSession {
  userToken: string;
  refreshToken: string;
  tenantId: string;
  tenantName: string;
  email: string;
  expiresAt: string;
}

const DEMO_TTL_HOURS = 24;

/**
 * Self-expiring trial workspaces. A visitor gets a throwaway tenant seeded
 * with a little industry-flavoured sample data and a full session, so the
 * landing page can drop them straight into a running system. The tenant is
 * flagged is_demo with a 24h expiry; the purge worker reaps it after that.
 */
@Injectable()
export class DemoService {
  constructor(
    private readonly db: DbService,
    private readonly auth: AuthService,
    private readonly invoices: InvoicesService,
  ) {}

  async createDemo(businessTypeInput?: string): Promise<DemoSession> {
    const businessType = isBusinessType(businessTypeInput)
      ? (businessTypeInput as string)
      : "general";
    const modules = presetModules(businessType);
    const label = BUSINESS_TYPE_LABELS[businessType] ?? "Business";

    const suffix = randomBytes(5).toString("hex"); // 10 lowercase hex chars
    const email = `demo-${suffix}@jenga.demo`;
    // Strong throwaway password — the visitor never sees or needs it; they
    // ride the returned session tokens.
    const password = `Demo!${randomBytes(24).toString("base64url")}`;
    const tenantName = `Demo ${label}`;
    const tenantSlug = `demo-${suffix}`;

    // Identity + tenant + owner membership, atomically (reused as-is).
    const { userId, tenantId } = await this.auth.signup({
      email,
      password,
      fullName: "Demo User",
      tenantName,
      tenantSlug,
    });

    // Flag it demo, set the expiry, and apply the industry preset. Runs inside
    // the tenant's own RLS context so the tenant_self policy passes.
    const expiresAt = await this.db.withTenant(
      tenantId,
      userId,
      async (client) => {
        const res = await client.query(
          `UPDATE tenants
             SET is_demo = true,
                 demo_expires_at = now() + ($2 || ' hours')::interval,
                 business_type = $3,
                 enabled_modules = $4::text[]
           WHERE id = $1
           RETURNING demo_expires_at`,
          [tenantId, String(DEMO_TTL_HOURS), businessType, modules],
        );
        return res.rows[0].demo_expires_at as Date;
      },
    );

    // Populate the workspace so the first screen is never empty.
    await this.seedLight(tenantId, userId);

    // Issue a real session so the visitor is logged straight in. Reuses the
    // same login path the web token-storage flow already understands.
    const session = await this.auth.login(email, password);
    if ("mfaRequired" in session) {
      // A freshly created demo user never has MFA; defensive only.
      throw new Error("Unexpected MFA challenge for demo account");
    }

    return {
      userToken: session.accessToken,
      refreshToken: session.refreshToken,
      tenantId,
      tenantName,
      email,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /**
   * A light, fast seed (a handful of records across the core tables) so the
   * demo workspace opens populated without the cost of the full one-click
   * seeder. Best-effort per section: a failure never blocks entry.
   */
  private async seedLight(tenantId: string, userId: string): Promise<void> {
    await this.db.withTenant(tenantId, userId, async (client) => {
      // Branch (head office) for stock + invoices.
      const br = await client.query(
        `INSERT INTO branches (tenant_id, code, name)
         VALUES ($1, '00', 'Head Office') RETURNING id`,
        [tenantId],
      );
      const branchId: string = br.rows[0].id;

      const customerNames = [
        "Wanjiku Traders",
        "Otieno Supplies",
        "Achieng Enterprises",
        "Kamau Hardware",
        "Njeri Stores",
        "Mutua Ventures",
      ];
      const customerIds: string[] = [];
      for (let i = 0; i < customerNames.length; i++) {
        const c = await client.query(
          `INSERT INTO customers (tenant_id, name, phone, email)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [
            tenantId,
            customerNames[i],
            `+25470000000${i + 1}`,
            `customer${i + 1}@demo.jenga.co.ke`,
          ],
        );
        customerIds.push(c.rows[0].id);
      }

      const itemSpecs = [
        ["Maize flour 2kg", 18000],
        ["Cooking oil 1L", 32000],
        ["Sugar 1kg", 15000],
        ["Rice 5kg", 85000],
        ["Cement 50kg", 78000],
        ["LED bulb 9W", 45000],
      ] as const;
      const itemIds: { id: string; priceCents: number }[] = [];
      for (let i = 0; i < itemSpecs.length; i++) {
        const [name, price] = itemSpecs[i];
        const it = await client.query(
          `INSERT INTO items (tenant_id, sku, name, unit, cost_cents,
                              price_cents, vat_rate, track_stock)
           VALUES ($1, $2, $3, 'pcs', $4, $5, '0.16', true) RETURNING id`,
          [
            tenantId,
            `SKU-${String(i + 1).padStart(3, "0")}`,
            name,
            Math.floor(price * 0.7),
            price,
          ],
        );
        itemIds.push({ id: it.rows[0].id, priceCents: price });
        await client.query(
          `INSERT INTO stock_movements (tenant_id, item_id, branch_id,
                                        qty_delta, reason, created_by)
           VALUES ($1, $2, $3, $4, 'adjustment', $5)`,
          [tenantId, it.rows[0].id, branchId, 500, userId],
        );
      }

      for (const name of [
        "Grace Wanjiru",
        "John Ochieng",
        "Mary Adhiambo",
        "David Kiprop",
      ]) {
        await client.query(
          `INSERT INTO employees (tenant_id, full_name, kra_pin, msisdn,
                                  gross_cents)
           VALUES ($1, $2, $3, $4, $5)`,
          [tenantId, name, "A012345678Z", "+254700111222", 6000000],
        );
      }

      for (let i = 0; i < 3; i++) {
        await client.query(
          `INSERT INTO suppliers (tenant_id, name, phone, email)
           VALUES ($1, $2, $3, $4)`,
          [
            tenantId,
            `Nairobi Distributors Ltd #${i + 1}`,
            `+25470122200${i + 1}`,
            `supplier${i + 1}@demo.jenga.co.ke`,
          ],
        );
      }

      // A couple of draft invoices via the real service (no ledger/fiscal for
      // drafts) so the sales list opens with something on it.
      for (let i = 0; i < 2; i++) {
        const item = itemIds[i % itemIds.length];
        await this.invoices.createDraft(client, {
          tenantId,
          userId,
          branchId,
          customerId: customerIds[i % customerIds.length],
          lines: [
            {
              description: "",
              quantity: i + 2,
              unitPriceCents: item.priceCents,
              vatRate: "0.16",
              itemId: item.id,
            },
          ],
        });
      }
    });
  }
}
