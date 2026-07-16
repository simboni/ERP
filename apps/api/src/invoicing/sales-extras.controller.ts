import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
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
import { LedgerService } from "../ledger/ledger.service";
import { InvoiceLineInput } from "./invoices.service";
import { QuotesService } from "./quotes.service";
import { renderInvoicePdf } from "./invoice-pdf";

const SALES_ROLES = ["owner", "admin", "accountant", "cashier"] as const;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Quotations, sales reports and petty-cash expenses. */
@Controller("tenants/current")
@UseGuards(JwtAuthGuard, TenantContextGuard, RolesGuard)
export class SalesExtrasController {
  constructor(
    private readonly db: DbService,
    private readonly quotes: QuotesService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  @Get("customers/overview")
  async customersOverview(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT c.id, c.name, c.kra_pin, c.phone, c.email,
                count(inv.id) FILTER (WHERE inv.status IN ('issued','paid'))::int
                  AS invoice_count,
                coalesce(sum(inv.total_cents)
                  FILTER (WHERE inv.status IN ('issued','paid')), 0)::bigint
                  AS invoiced_cents,
                coalesce(sum(inv.total_cents - coalesce(inv.amount_paid_cents, 0))
                  FILTER (WHERE inv.status = 'issued'), 0)::bigint
                  AS outstanding_cents,
                max(inv.issue_date) AS last_invoice_date
         FROM customers c
         LEFT JOIN invoices inv ON inv.customer_id = c.id
         GROUP BY c.id
         ORDER BY c.name
         LIMIT 500`,
      );
      return res.rows;
    });
  }

  @Get("customers/:id/invoices")
  async customerInvoices(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) customerId: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT inv.id, inv.invoice_no, inv.status, inv.issue_date,
                inv.due_date, inv.total_cents,
                coalesce(inv.amount_paid_cents, 0)::bigint AS amount_paid_cents
         FROM invoices inv
         WHERE inv.customer_id = $1
         ORDER BY inv.created_at DESC
         LIMIT 200`,
        [customerId],
      );
      return res.rows;
    });
  }

  @Post("quotes")
  @Roles(...SALES_ROLES)
  async createQuote(
    @TenantClaims() claims: TenantTokenClaims,
    @Body()
    body: {
      branchId?: string;
      customerId?: string;
      validUntil?: string;
      lines?: InvoiceLineInput[];
    },
  ) {
    if (!body?.branchId || !body?.customerId || !Array.isArray(body?.lines)) {
      throw new BadRequestException("branchId, customerId and lines are required");
    }
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.quotes.createDraft(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        branchId: body.branchId!,
        customerId: body.customerId!,
        validUntil: body.validUntil,
        lines: body.lines!,
      }),
    );
  }

  @Post("quotes/:id/convert")
  @Roles(...SALES_ROLES)
  async convertQuote(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) quoteId: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.quotes.convert(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        quoteId,
      }),
    );
  }

  @Get("quotes")
  async listQuotes(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT q.id, q.quote_no, q.status, q.total_cents, q.valid_until,
                q.invoice_id, c.name AS customer_name, q.created_at
         FROM quotes q JOIN customers c ON c.id = q.customer_id
         ORDER BY q.created_at DESC LIMIT 100`,
      );
      return res.rows;
    });
  }

  @Get("quotes/:id")
  async quoteDetail(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) quoteId: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.quotes.getDetail(client, quoteId),
    );
  }

  @Get("quotes/:id/pdf")
  async quotePdf(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) quoteId: string,
    @Res() res: Response,
  ) {
    const data = await this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.quotes.getDetail(client, quoteId),
    );
    const pdf = await renderInvoicePdf({
      businessName: data.business_name,
      invoiceNo: `Q-${data.quote_no}`,
      status: data.status,
      issueDate: data.valid_until
        ? new Date(data.valid_until).toISOString().slice(0, 10)
        : null,
      customerName: data.customer_name,
      customerPin: data.customer_pin,
      logo: data.logo || null,
      lines: data.lines,
      subtotalCents: Number(data.subtotal_cents),
      vatCents: Number(data.vat_cents),
      totalCents: Number(data.total_cents),
      fiscal: { controlNumber: null, qrPayload: null, status: null },
      documentTitle: "QUOTATION",
      detailsTitle: "QUOTE DETAILS",
      dateLabel: "Valid Until",
      showFiscal: false,
    });
    res
      .status(200)
      .set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="quote-Q-${data.quote_no}.pdf"`,
      })
      .send(pdf);
  }

  @Patch("quotes/:id")
  @Roles(...SALES_ROLES)
  async updateQuote(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) quoteId: string,
    @Body()
    body: {
      customerId?: string;
      validUntil?: string | null;
      lines?: InvoiceLineInput[];
    },
  ) {
    if (!Array.isArray(body?.lines) || body.lines.length === 0) {
      throw new BadRequestException("lines are required");
    }
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.quotes.update(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        quoteId,
        customerId: body.customerId,
        validUntil: body.validUntil ?? null,
        lines: body.lines!,
      }),
    );
  }

  @Delete("quotes/:id")
  @Roles(...SALES_ROLES)
  async deleteQuote(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) quoteId: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.quotes.remove(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        quoteId,
      }),
    );
  }

  /** Sales report: issued+paid invoices grouped by day, customer or item. */
  @Get("reports/sales")
  @Roles("owner", "admin", "accountant")
  async salesReport(
    @TenantClaims() claims: TenantTokenClaims,
    @Query("period") period: string,
    @Query("groupBy") groupBy = "day",
  ) {
    if (!PERIOD_RE.test(period ?? "")) {
      throw new BadRequestException("period must be YYYY-MM");
    }
    if (!["day", "customer", "item"].includes(groupBy)) {
      throw new BadRequestException("groupBy must be day | customer | item");
    }
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      let rows;
      if (groupBy === "item") {
        rows = await client.query(
          `SELECT coalesce(i.name, il.description) AS label,
                  sum(il.quantity)::numeric AS quantity,
                  sum(il.line_total_cents)::bigint AS net_cents,
                  sum(il.vat_cents)::bigint AS vat_cents
           FROM invoice_lines il
           JOIN invoices inv ON inv.id = il.invoice_id
           LEFT JOIN items i ON i.id = il.item_id
           WHERE inv.status IN ('issued', 'paid')
             AND to_char(inv.issue_date, 'YYYY-MM') = $1
           GROUP BY 1 ORDER BY net_cents DESC`,
          [period],
        );
      } else if (groupBy === "customer") {
        rows = await client.query(
          `SELECT c.name AS label,
                  count(*)::int AS invoices,
                  sum(inv.subtotal_cents)::bigint AS net_cents,
                  sum(inv.vat_cents)::bigint AS vat_cents,
                  sum(inv.total_cents - inv.amount_paid_cents)::bigint AS outstanding_cents
           FROM invoices inv JOIN customers c ON c.id = inv.customer_id
           WHERE inv.status IN ('issued', 'paid')
             AND to_char(inv.issue_date, 'YYYY-MM') = $1
           GROUP BY c.name ORDER BY net_cents DESC`,
          [period],
        );
      } else {
        rows = await client.query(
          `SELECT to_char(inv.issue_date, 'YYYY-MM-DD') AS label,
                  count(*)::int AS invoices,
                  sum(inv.subtotal_cents)::bigint AS net_cents,
                  sum(inv.vat_cents)::bigint AS vat_cents
           FROM invoices inv
           WHERE inv.status IN ('issued', 'paid')
             AND to_char(inv.issue_date, 'YYYY-MM') = $1
           GROUP BY 1 ORDER BY 1`,
          [period],
        );
      }
      const totals = await client.query(
        `SELECT coalesce(sum(subtotal_cents), 0)::bigint AS net,
                coalesce(sum(vat_cents), 0)::bigint AS vat,
                coalesce(sum(total_cents), 0)::bigint AS gross,
                count(*)::int AS invoices
         FROM invoices
         WHERE status IN ('issued', 'paid')
           AND to_char(issue_date, 'YYYY-MM') = $1`,
        [period],
      );
      return { period, groupBy, rows: rows.rows, totals: totals.rows[0] };
    });
  }

  /** Petty-cash / direct expense: posts straight to the ledger. */
  @Post("expenses")
  @Roles("owner", "admin", "accountant", "cashier")
  async recordExpense(
    @TenantClaims() claims: TenantTokenClaims,
    @Body()
    body: {
      description?: string;
      amountCents?: number;
      paidVia?: "cash" | "mpesa" | "bank";
      accountCode?: string;
    },
  ) {
    const paidVia = body?.paidVia ?? "cash";
    if (!body?.description?.trim()) {
      throw new BadRequestException("description is required");
    }
    if (!Number.isInteger(body?.amountCents) || body!.amountCents! <= 0) {
      throw new BadRequestException("amountCents must be a positive integer");
    }
    if (!["cash", "mpesa", "bank"].includes(paidVia)) {
      throw new BadRequestException("paidVia must be cash | mpesa | bank");
    }
    const creditAccount = { cash: "1000", mpesa: "1010", bank: "1020" }[paidVia];
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const posting = await this.ledger.post(client, {
        tenantId: claims.tid,
        postedBy: claims.sub,
        entryDate: new Date().toISOString().slice(0, 10),
        memo: body.description!.trim(),
        sourceType: "expense",
        idempotencyKey: `expense:${claims.sub}:${Date.now()}:${Math.random()
          .toString(36)
          .slice(2, 8)}`,
        lines: [
          { accountCode: body.accountCode ?? "6000", debitCents: body.amountCents! },
          { accountCode: creditAccount, creditCents: body.amountCents! },
        ],
      });
      await this.audit.record(client, {
        tenantId: claims.tid,
        actorUserId: claims.sub,
        action: "expense.recorded",
        entityType: "journal_entry",
        entityId: posting.entryId,
        payload: { description: body.description, amountCents: body.amountCents, paidVia },
      });
      return { journalEntryId: posting.entryId, entryNo: posting.entryNo };
    });
  }

  @Get("expenses")
  async listExpenses(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT je.id, je.entry_no, je.entry_date, je.memo,
                sum(jl.debit_cents) FILTER (WHERE jl.debit_cents > 0)::bigint AS amount_cents
         FROM journal_entries je
         JOIN journal_lines jl ON jl.entry_id = je.id
         WHERE je.source_type = 'expense'
         GROUP BY je.id ORDER BY je.created_at DESC LIMIT 100`,
      );
      return res.rows;
    });
  }
}
