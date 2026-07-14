import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { AuditService } from "../audit/audit.service";
import { InvoiceLineInput, InvoicesService } from "./invoices.service";

/**
 * Quotations: no ledger, no stock, no fiscalization — a priced promise.
 * convert() turns an open quote into a DRAFT invoice reusing its lines;
 * the normal issue flow (posting + eTIMS) takes over from there.
 */
@Injectable()
export class QuotesService {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly audit: AuditService,
  ) {}

  async createDraft(
    client: PoolClient,
    args: {
      tenantId: string;
      userId: string;
      branchId: string;
      customerId: string;
      validUntil?: string;
      lines: InvoiceLineInput[];
    },
  ): Promise<{ id: string; quoteNo: number; totalCents: number }> {
    if (!args.lines.length) {
      throw new BadRequestException("A quote needs at least one line");
    }
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('quote-no:' || $1))",
      [args.tenantId],
    );
    const noRes = await client.query(
      "SELECT coalesce(max(quote_no), 0) + 1 AS next FROM quotes WHERE tenant_id = $1",
      [args.tenantId],
    );
    const quoteNo = Number(noRes.rows[0].next);

    const quoteRes = await client.query(
      `INSERT INTO quotes (tenant_id, branch_id, customer_id, quote_no, valid_until, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [args.tenantId, args.branchId, args.customerId, quoteNo, args.validUntil ?? null, args.userId],
    );
    const quoteId: string = quoteRes.rows[0].id;
    let subtotal = 0;
    let vat = 0;
    for (const line of args.lines) {
      const { totalCents, vatCents } = this.invoices.computeLine(line);
      subtotal += totalCents;
      vat += vatCents;
      await client.query(
        `INSERT INTO quote_lines
           (tenant_id, quote_id, description, quantity, unit_price_cents,
            vat_rate, line_total_cents, vat_cents, item_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          args.tenantId, quoteId, line.description, line.quantity,
          line.unitPriceCents, line.vatRate, totalCents, vatCents,
          line.itemId ?? null,
        ],
      );
    }
    await client.query(
      `UPDATE quotes SET subtotal_cents = $2, vat_cents = $3, total_cents = $4 WHERE id = $1`,
      [quoteId, subtotal, vat, subtotal + vat],
    );
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "quote.created",
      entityType: "quote",
      entityId: quoteId,
      payload: { quoteNo, totalCents: subtotal + vat },
    });
    return { id: quoteId, quoteNo, totalCents: subtotal + vat };
  }

  async convert(
    client: PoolClient,
    args: { tenantId: string; userId: string; quoteId: string },
  ): Promise<{ invoiceId: string }> {
    const qRes = await client.query(
      `SELECT id, branch_id, customer_id, status, quote_no, valid_until
       FROM quotes WHERE id = $1 FOR UPDATE`,
      [args.quoteId],
    );
    const quote = qRes.rows[0];
    if (!quote) throw new NotFoundException("Quote not found");
    if (!["draft", "sent", "accepted"].includes(quote.status)) {
      throw new BadRequestException(
        `Quote cannot be converted (status: ${quote.status})`,
      );
    }
    if (quote.valid_until && new Date(quote.valid_until) < new Date()) {
      await client.query("UPDATE quotes SET status = 'expired' WHERE id = $1", [
        args.quoteId,
      ]);
      throw new BadRequestException("Quote has expired; issue a fresh one");
    }
    const lines = await client.query(
      `SELECT description, quantity, unit_price_cents, vat_rate, item_id
       FROM quote_lines WHERE quote_id = $1`,
      [args.quoteId],
    );
    const draft = await this.invoices.createDraft(client, {
      tenantId: args.tenantId,
      userId: args.userId,
      branchId: quote.branch_id,
      customerId: quote.customer_id,
      lines: lines.rows.map(
        (l: {
          description: string;
          quantity: string;
          unit_price_cents: string;
          vat_rate: "0.16" | "0" | "exempt";
          item_id: string | null;
        }) => ({
          description: l.description,
          quantity: Number(l.quantity),
          unitPriceCents: Number(l.unit_price_cents),
          vatRate: l.vat_rate,
          itemId: l.item_id ?? undefined,
        }),
      ),
    });
    await client.query(
      `UPDATE quotes SET status = 'converted', invoice_id = $2 WHERE id = $1`,
      [args.quoteId, draft.id],
    );
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "quote.converted",
      entityType: "quote",
      entityId: args.quoteId,
      payload: { quoteNo: Number(quote.quote_no), invoiceId: draft.id },
    });
    return { invoiceId: draft.id };
  }
}
