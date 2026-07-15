import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { BillLineInput, BillsService, SettlementMethod } from "./bills.service";

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

  @Patch("suppliers/:id")
  @Roles(...PURCHASE_ROLES)
  async editSupplier(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) supplierId: string,
    @Body()
    body: { name?: string; kraPin?: string; phone?: string; email?: string },
  ) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `UPDATE suppliers SET
           name    = coalesce($2, name),
           kra_pin = coalesce($3, kra_pin),
           phone   = coalesce($4, phone),
           email   = coalesce($5, email)
         WHERE id = $1
         RETURNING id, name, kra_pin, phone, email`,
        [
          supplierId,
          body.name?.trim() || null,
          body.kraPin?.trim() || null,
          body.phone?.trim() || null,
          body.email?.trim() || null,
        ],
      );
      if (!res.rows[0]) throw new NotFoundException("Supplier not found");
      return res.rows[0];
    });
  }

  @Get("suppliers/:id/bills")
  async supplierBills(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) supplierId: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT id, status, bill_date, due_date, total_cents, vat_cents,
                supplier_invoice_no
         FROM bills WHERE supplier_id = $1
         ORDER BY bill_date DESC LIMIT 500`,
        [supplierId],
      );
      return res.rows;
    });
  }

  @Get("suppliers/overview")
  async suppliersOverview(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT s.id, s.name, s.kra_pin, s.phone, s.email,
                count(b.id) FILTER (WHERE b.status IN ('approved','paid'))::int
                  AS bill_count,
                coalesce(sum(b.total_cents)
                  FILTER (WHERE b.status IN ('approved','paid')), 0)::bigint
                  AS billed_cents,
                coalesce(sum(b.total_cents)
                  FILTER (WHERE b.status = 'approved'), 0)::bigint
                  AS unpaid_cents,
                max(b.bill_date) AS last_bill_date
         FROM suppliers s
         LEFT JOIN bills b ON b.supplier_id = s.id
         GROUP BY s.id
         ORDER BY s.name
         LIMIT 500`,
      );
      return res.rows;
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

  /** Money leaves the business here: owner/admin only (maker-checker). */
  @Post("bills/:id/pay")
  @Roles("owner", "admin")
  async pay(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) billId: string,
    @Body() body: { method?: SettlementMethod; msisdn?: string },
  ) {
    if (!body?.method || !["cash", "bank", "mpesa_b2c"].includes(body.method)) {
      throw new BadRequestException("method must be cash | bank | mpesa_b2c");
    }
    return this.bills.pay({
      tenantId: claims.tid,
      userId: claims.sub,
      billId,
      method: body.method,
      msisdn: body.msisdn,
    });
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
