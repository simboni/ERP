import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
import { BillLineInput, BillsService } from "./bills.service";

const PURCHASE_ROLES = ["owner", "admin", "accountant", "storekeeper"] as const;

@Controller("tenants/current")
@UseGuards(JwtAuthGuard, TenantContextGuard, RolesGuard)
export class BillsController {
  constructor(
    private readonly db: DbService,
    private readonly bills: BillsService,
  ) {}

  @Post("suppliers")
  @Roles(...PURCHASE_ROLES)
  async createSupplier(
    @TenantClaims() claims: TenantTokenClaims,
    @Body() body: { name?: string; kraPin?: string; phone?: string; email?: string },
  ) {
    if (!body?.name?.trim()) throw new BadRequestException("name is required");
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `INSERT INTO suppliers (tenant_id, name, kra_pin, phone, email)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, kra_pin, phone, email, created_at`,
        [
          claims.tid,
          body.name!.trim(),
          body.kraPin?.trim() || null,
          body.phone?.trim() || null,
          body.email?.trim() || null,
        ],
      );
      return res.rows[0];
    });
  }

  @Get("suppliers")
  async listSuppliers(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        "SELECT id, name, kra_pin, phone, email FROM suppliers ORDER BY name LIMIT 200",
      );
      return res.rows;
    });
  }

  @Post("bills")
  @Roles(...PURCHASE_ROLES)
  async createBill(
    @TenantClaims() claims: TenantTokenClaims,
    @Body()
    body: {
      supplierId?: string;
      billDate?: string;
      dueDate?: string;
      supplierInvoiceNo?: string;
      etimsControlNumber?: string;
      lines?: BillLineInput[];
    },
  ) {
    if (!body?.supplierId || !body?.billDate || !Array.isArray(body?.lines)) {
      throw new BadRequestException("supplierId, billDate and lines are required");
    }
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.bills.createDraft(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        supplierId: body.supplierId!,
        billDate: body.billDate!,
        dueDate: body.dueDate,
        supplierInvoiceNo: body.supplierInvoiceNo,
        etimsControlNumber: body.etimsControlNumber,
        lines: body.lines!,
      }),
    );
  }

  /** Maker-checker: broader roles draft, owner/admin/accountant approve. */
  @Post("bills/:id/approve")
  @Roles("owner", "admin", "accountant")
  async approve(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) billId: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.bills.approve(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        billId,
      }),
    );
  }

  @Get("bills")
  async listBills(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT b.id, b.status, b.bill_date, b.due_date, b.total_cents,
                b.vat_cents, b.supplier_invoice_no, b.etims_control_number,
                s.name AS supplier_name
         FROM bills b JOIN suppliers s ON s.id = b.supplier_id
         ORDER BY b.bill_date DESC LIMIT 100`,
      );
      return res.rows;
    });
  }
}
