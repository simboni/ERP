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
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { renderInvoicePdf } from "./invoice-pdf";
import type { TenantTokenClaims } from "@jenga/shared";
import {
  JwtAuthGuard,
  Roles,
  RolesGuard,
  TenantClaims,
  TenantContextGuard,
} from "../auth/guards";
import { DbService } from "../db/db.service";
import { LedgerService, seedDefaultAccounts } from "../ledger/ledger.service";
import { AuditService } from "../audit/audit.service";
import { InvoiceLineInput, InvoicesService } from "./invoices.service";

const SALES_ROLES = ["owner", "admin", "accountant", "cashier"] as const;

@Controller("tenants/current")
@UseGuards(JwtAuthGuard, TenantContextGuard, RolesGuard)
export class InvoicesController {
  constructor(
    private readonly db: DbService,
    private readonly invoices: InvoicesService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  @Post("accounts/seed-defaults")
  @Roles("owner", "admin", "accountant")
  async seedAccounts(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const created = await seedDefaultAccounts(client, claims.tid);
      if (created > 0) {
        await this.audit.record(client, {
          tenantId: claims.tid,
          actorUserId: claims.sub,
          action: "accounts.seeded",
          entityType: "account",
          payload: { created },
        });
      }
      return { created };
    });
  }

  @Get("accounts/trial-balance")
  @Roles("owner", "admin", "accountant")
  async trialBalance(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.ledger.trialBalance(client),
    );
  }

  @Patch("customers/:id")
  @Roles(...SALES_ROLES)
  async editCustomer(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) customerId: string,
    @Body()
    body: { name?: string; kraPin?: string; phone?: string; email?: string },
  ) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `UPDATE customers SET
           name    = coalesce($2, name),
           kra_pin = coalesce($3, kra_pin),
           phone   = coalesce($4, phone),
           email   = coalesce($5, email)
         WHERE id = $1
         RETURNING id, name, kra_pin, phone, email`,
        [
          customerId,
          body.name?.trim() || null,
          body.kraPin?.trim() || null,
          body.phone?.trim() || null,
          body.email?.trim() || null,
        ],
      );
      if (!res.rows[0]) throw new NotFoundException("Customer not found");
      return res.rows[0];
    });
  }

  @Post("customers")
  @Roles(...SALES_ROLES)
  async createCustomer(
    @TenantClaims() claims: TenantTokenClaims,
    @Body() body: { name?: string; kraPin?: string; phone?: string; email?: string },
  ) {
    if (!body?.name?.trim()) throw new BadRequestException("name is required");
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `INSERT INTO customers (tenant_id, name, kra_pin, phone, email)
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

  @Get("customers")
  async listCustomers(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT id, name, kra_pin, phone, email, created_at
         FROM customers ORDER BY name LIMIT 200`,
      );
      return res.rows;
    });
  }

  @Post("invoices")
  @Roles(...SALES_ROLES)
  async createInvoice(
    @TenantClaims() claims: TenantTokenClaims,
    @Body()
    body: {
      branchId?: string;
      customerId?: string;
      dueDate?: string;
      lines?: InvoiceLineInput[];
    },
  ) {
    if (!body?.branchId || !body?.customerId || !Array.isArray(body?.lines)) {
      throw new BadRequestException("branchId, customerId and lines are required");
    }
    for (const l of body.lines) {
      if (!l?.description?.trim() || !["0.16", "0", "exempt"].includes(l?.vatRate)) {
        throw new BadRequestException(
          "each line needs description and vatRate of 0.16 | 0 | exempt",
        );
      }
    }
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.invoices.createDraft(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        branchId: body.branchId!,
        customerId: body.customerId!,
        dueDate: body.dueDate,
        lines: body.lines!,
      }),
    );
  }

  @Post("invoices/:id/issue")
  @Roles(...SALES_ROLES)
  async issue(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) invoiceId: string,
  ) {
    const issueDate = new Date().toISOString().slice(0, 10);
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.invoices.issue(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        invoiceId,
        issueDate,
      }),
    );
  }

  /** Corrections are credit notes, never edits — accountant-level action. */
  @Post("invoices/:id/credit-note")
  @Roles("owner", "admin", "accountant")
  async creditNote(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) invoiceId: string,
    @Body() body: { reason?: string },
  ) {
    if (!body?.reason?.trim()) {
      throw new BadRequestException("reason is required");
    }
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.invoices.creditNote(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        invoiceId,
        reason: body.reason!.trim(),
        date: new Date().toISOString().slice(0, 10),
      }),
    );
  }

  @Get("invoices")
  async listInvoices(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT i.id, i.invoice_no, i.status, i.total_cents, i.vat_cents,
                i.issue_date, i.due_date, c.name AS customer_name,
                f.status AS fiscal_status, f.control_number
         FROM invoices i
         JOIN customers c ON c.id = i.customer_id
         LEFT JOIN fiscal_documents f ON f.id = i.fiscal_document_id
         ORDER BY i.created_at DESC LIMIT 100`,
      );
      return res.rows;
    });
  }

  @Get("invoices/:id/pdf")
  async invoicePdf(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) invoiceId: string,
    @Res() res: Response,
  ) {
    const data = await this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const inv = await client.query(
        `SELECT i.*, c.name AS customer_name, c.kra_pin AS customer_pin,
                t.name AS business_name,
                f.status AS fiscal_status, f.control_number, f.qr_payload
         FROM invoices i
         JOIN customers c ON c.id = i.customer_id
         JOIN tenants t ON t.id = i.tenant_id
         LEFT JOIN fiscal_documents f ON f.id = i.fiscal_document_id
         WHERE i.id = $1`,
        [invoiceId],
      );
      if (!inv.rows[0]) throw new NotFoundException();
      const lines = await client.query(
        `SELECT description, quantity, unit_price_cents, vat_rate,
                line_total_cents, vat_cents
         FROM invoice_lines WHERE invoice_id = $1`,
        [invoiceId],
      );
      return { ...inv.rows[0], lines: lines.rows };
    });
    const pdf = await renderInvoicePdf({
      businessName: data.business_name,
      invoiceNo: data.invoice_no,
      status: data.status,
      issueDate: data.issue_date
        ? new Date(data.issue_date).toISOString().slice(0, 10)
        : null,
      customerName: data.customer_name,
      customerPin: data.customer_pin,
      lines: data.lines,
      subtotalCents: Number(data.subtotal_cents),
      vatCents: Number(data.vat_cents),
      totalCents: Number(data.total_cents),
      fiscal: {
        controlNumber: data.control_number,
        qrPayload: data.qr_payload,
        status: data.fiscal_status,
      },
    });
    res
      .status(200)
      .set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="invoice-${data.invoice_no ?? "draft"}.pdf"`,
      })
      .send(pdf);
  }

  @Patch("invoices/:id")
  @Roles(...SALES_ROLES)
  async editDraft(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) invoiceId: string,
    @Body() body: { dueDate?: string; lines?: InvoiceLineInput[] },
  ) {
    if (!Array.isArray(body?.lines)) {
      throw new BadRequestException("lines are required");
    }
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.invoices.replaceDraftLines(client, {
        tenantId: claims.tid,
        invoiceId,
        dueDate: body.dueDate,
        lines: body.lines!,
      }),
    );
  }

  @Get("invoices/:id")
  async getInvoice(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) invoiceId: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const inv = await client.query(
        `SELECT i.*, c.name AS customer_name, c.kra_pin AS customer_pin,
                f.status AS fiscal_status, f.control_number, f.qr_payload
         FROM invoices i
         JOIN customers c ON c.id = i.customer_id
         LEFT JOIN fiscal_documents f ON f.id = i.fiscal_document_id
         WHERE i.id = $1`,
        [invoiceId],
      );
      if (!inv.rows[0]) throw new NotFoundException();
      const lines = await client.query(
        `SELECT description, quantity, unit_price_cents, vat_rate,
                line_total_cents, vat_cents
         FROM invoice_lines WHERE invoice_id = $1`,
        [invoiceId],
      );
      return { ...inv.rows[0], lines: lines.rows };
    });
  }
}
