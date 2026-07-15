import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
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
        `SELECT id, sku, name, unit, cost_cents, price_cents, vat_rate,
                track_stock, reorder_level
         FROM items ORDER BY sku LIMIT 500`,
      );
      return res.rows;
    });
  }

  @Post("items/:id/reorder-level")
  @HttpCode(200)
  @Roles(...STOCK_ROLES)
  async setReorderLevel(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) itemId: string,
    @Body() body: { reorderLevel?: number },
  ) {
    if (!Number.isFinite(body?.reorderLevel) || body!.reorderLevel! < 0) {
      throw new BadRequestException("reorderLevel must be >= 0");
    }
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `UPDATE items SET reorder_level = $2 WHERE id = $1
         RETURNING id, sku, reorder_level`,
        [itemId, body!.reorderLevel],
      );
      if (!res.rows[0]) throw new BadRequestException("Item not found");
      return res.rows[0];
    });
  }

  /** Items at or below their reorder point, with open PO quantities. */
  @Get("stock/low")
  async lowStock(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT i.id AS item_id, i.sku, i.name, i.unit, i.reorder_level,
                coalesce(sum(sm.qty_delta), 0) AS on_hand,
                coalesce(max(oo.on_order), 0)  AS on_order
         FROM items i
         LEFT JOIN stock_movements sm ON sm.item_id = i.id
         LEFT JOIN (
           SELECT l.item_id, sum(l.quantity - l.qty_received) AS on_order
           FROM purchase_order_lines l
           JOIN purchase_orders po ON po.id = l.po_id
           WHERE po.status = 'sent'
           GROUP BY l.item_id
         ) oo ON oo.item_id = i.id
         WHERE i.track_stock AND i.reorder_level > 0
         GROUP BY i.id
         HAVING coalesce(sum(sm.qty_delta), 0) <= i.reorder_level
         ORDER BY i.sku`,
      );
      return res.rows.map((r) => ({
        ...r,
        on_hand: Number(r.on_hand),
        on_order: Number(r.on_order),
        reorder_level: Number(r.reorder_level),
        shortfall: Number(r.reorder_level) - Number(r.on_hand),
      }));
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
