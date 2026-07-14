import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { TenantTokenClaims } from "@jenga/shared";
import { AuditService } from "../audit/audit.service";
import {
  JwtAuthGuard,
  Roles,
  RolesGuard,
  TenantClaims,
  TenantContextGuard,
} from "../auth/guards";
import { DbService } from "../db/db.service";
import { InventoryService } from "./inventory.service";

const STOCK_ROLES = ["owner", "admin", "storekeeper", "accountant"] as const;

@Controller("tenants/current")
@UseGuards(JwtAuthGuard, TenantContextGuard, RolesGuard)
export class InventoryController {
  constructor(
    private readonly db: DbService,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
  ) {}

  @Post("items")
  @Roles(...STOCK_ROLES)
  async createItem(
    @TenantClaims() claims: TenantTokenClaims,
    @Body()
    body: {
      sku?: string;
      name?: string;
      unit?: string;
      costCents?: number;
      priceCents?: number;
      vatRate?: "0.16" | "0" | "exempt";
      trackStock?: boolean;
    },
  ) {
    if (!body?.sku?.trim() || !body?.name?.trim()) {
      throw new BadRequestException("sku and name are required");
    }
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `INSERT INTO items (tenant_id, sku, name, unit, cost_cents, price_cents, vat_rate, track_stock)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, sku, name, unit, cost_cents, price_cents, vat_rate, track_stock`,
        [
          claims.tid,
          body.sku!.trim(),
          body.name!.trim(),
          body.unit?.trim() || "pcs",
          body.costCents ?? 0,
          body.priceCents ?? 0,
          body.vatRate ?? "0.16",
          body.trackStock ?? true,
        ],
      );
      return res.rows[0];
    });
  }

  @Get("items")
  async listItems(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT id, sku, name, unit, cost_cents, price_cents, vat_rate, track_stock
         FROM items ORDER BY sku LIMIT 500`,
      );
      return res.rows;
    });
  }

  /** Goods received / stock adjustments. */
  @Post("stock/movements")
  @Roles(...STOCK_ROLES)
  async move(
    @TenantClaims() claims: TenantTokenClaims,
    @Body()
    body: {
      itemId?: string;
      branchId?: string;
      qtyDelta?: number;
      reason?: "purchase" | "adjustment";
    },
  ) {
    if (
      !body?.itemId ||
      !body?.branchId ||
      !body?.qtyDelta ||
      !["purchase", "adjustment"].includes(body?.reason ?? "")
    ) {
      throw new BadRequestException(
        "itemId, branchId, qtyDelta and reason (purchase|adjustment) are required",
      );
    }
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const result = await this.inventory.recordMovement(client, {
        tenantId: claims.tid,
        itemId: body.itemId!,
        branchId: body.branchId!,
        qtyDelta: body.qtyDelta!,
        reason: body.reason!,
        userId: claims.sub,
      });
      await this.audit.record(client, {
        tenantId: claims.tid,
        actorUserId: claims.sub,
        action: `stock.${body.reason}`,
        entityType: "stock_movement",
        entityId: body.itemId,
        payload: { qtyDelta: body.qtyDelta, branchId: body.branchId },
      });
      return result;
    });
  }

  @Get("stock/levels")
  async levels(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.inventory.stockLevels(client),
    );
  }
}
