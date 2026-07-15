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
import {
  JwtAuthGuard,
  Roles,
  RolesGuard,
  TenantClaims,
  TenantContextGuard,
} from "../auth/guards";
import { DbService } from "../db/db.service";
import { PoLineInput, PurchaseOrdersService } from "./purchase-orders.service";

const PURCHASE_ROLES = ["owner", "admin", "accountant", "storekeeper"] as const;
const CONVERT_ROLES = ["owner", "admin", "accountant"] as const;

@Controller("tenants/current")
@UseGuards(JwtAuthGuard, TenantContextGuard, RolesGuard)
export class PurchaseOrdersController {
  constructor(
    private readonly db: DbService,
    private readonly pos: PurchaseOrdersService,
  ) {}

  @Post("purchase-orders")
  @Roles(...PURCHASE_ROLES)
  async create(
    @TenantClaims() claims: TenantTokenClaims,
    @Body()
    body: {
      supplierId?: string;
      branchId?: string;
      expectedDate?: string;
      lines?: PoLineInput[];
    },
  ) {
    if (!body?.supplierId) {
      throw new BadRequestException("supplierId is required");
    }
    if (!Array.isArray(body?.lines) || body.lines.length === 0) {
      throw new BadRequestException("lines must be non-empty");
    }
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      let branchId = body.branchId;
      if (!branchId) {
        const br = await client.query(
          "SELECT id FROM branches ORDER BY created_at LIMIT 1",
        );
        if (!br.rows[0]) {
          throw new BadRequestException("Create a branch first");
        }
        branchId = br.rows[0].id;
      }
      return this.pos.createDraft(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        supplierId: body.supplierId!,
        branchId: branchId!,
        expectedDate: body.expectedDate,
        lines: body.lines!,
      });
    });
  }

  @Get("purchase-orders")
  async list(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT po.id, po.po_no, po.status, po.order_date, po.expected_date,
                po.total_cents, po.bill_id, s.name AS supplier_name,
                coalesce(sum(l.quantity), 0)      AS qty_ordered,
                coalesce(sum(l.qty_received), 0)  AS qty_received
         FROM purchase_orders po
         JOIN suppliers s ON s.id = po.supplier_id
         LEFT JOIN purchase_order_lines l ON l.po_id = po.id
         GROUP BY po.id, s.name
         ORDER BY po.created_at DESC
         LIMIT 200`,
      );
      return res.rows;
    });
  }

  @Get("purchase-orders/:id")
  async getOne(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) poId: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const header = await client.query(
        `SELECT po.*, s.name AS supplier_name
         FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
         WHERE po.id = $1`,
        [poId],
      );
      if (!header.rows[0]) {
        throw new BadRequestException("Purchase order not found");
      }
      const lines = await client.query(
        `SELECT id, item_id, description, quantity, qty_received,
                unit_cost_cents, vat_rate, line_total_cents, vat_cents
         FROM purchase_order_lines WHERE po_id = $1 ORDER BY id`,
        [poId],
      );
      return { ...header.rows[0], lines: lines.rows };
    });
  }

  @Post("purchase-orders/:id/send")
  @HttpCode(200)
  @Roles(...PURCHASE_ROLES)
  async send(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) poId: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.pos.send(client, { tenantId: claims.tid, userId: claims.sub, poId }),
    );
  }

  @Post("purchase-orders/:id/cancel")
  @HttpCode(200)
  @Roles(...CONVERT_ROLES)
  async cancel(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) poId: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.pos.cancel(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        poId,
      }),
    );
  }

  @Post("purchase-orders/:id/receive")
  @HttpCode(200)
  @Roles(...PURCHASE_ROLES)
  async receive(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) poId: string,
    @Body() body: { receipts?: { lineId: string; qty: number }[] },
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.pos.receive(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        poId,
        receipts: body?.receipts ?? [],
      }),
    );
  }

  @Post("purchase-orders/:id/convert-to-bill")
  @HttpCode(200)
  @Roles(...CONVERT_ROLES)
  async convertToBill(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) poId: string,
    @Body()
    body: {
      billDate?: string;
      supplierInvoiceNo?: string;
      etimsControlNumber?: string;
    },
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.pos.convertToBill(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        poId,
        billDate: body?.billDate,
        supplierInvoiceNo: body?.supplierInvoiceNo,
        etimsControlNumber: body?.etimsControlNumber,
      }),
    );
  }
}
