import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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
import { LedgerService } from "../ledger/ledger.service";
import { InvoiceLineInput } from "./invoices.service";
import { QuotesService } from "./quotes.service";

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
