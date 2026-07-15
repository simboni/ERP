import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { Optional } from "@nestjs/common";
import { mulRate } from "../payroll/calculator";
import { FiscalService } from "../fiscal/fiscal.service";
import { LedgerService } from "../ledger/ledger.service";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { InventoryService } from "../inventory/inventory.service";

export interface InvoiceLineInput {
  description: string;
  quantity: number;
  unitPriceCents: number;
  vatRate: "0.16" | "0" | "exempt";
  /** Catalogue item: stock decrements and COGS posts at issue. */
  itemId?: string;
}

/**
 * Invoicing domain. Prices are VAT-EXCLUSIVE; VAT is computed per line
 * (16% standard, zero-rated, exempt) with integer math. issue() is the
 * atomic heart: totals + invoice number + ledger posting (DR AR / CR Sales
 * / CR VAT) + eTIMS enqueue commit or roll back together — an invoice can
 * never exist half-fiscalized or half-posted.
 */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly fiscal: FiscalService,
    private readonly audit: AuditService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly inventory?: InventoryService,
  ) {}

  computeLine(line: InvoiceLineInput): { totalCents: number; vatCents: number } {
    if (
      !Number.isInteger(line.unitPriceCents) ||
      line.unitPriceCents < 0 ||
      !(line.quantity > 0)
    ) {
      throw new BadRequestException("Invalid line quantity or unit price");
    }
    // quantity supports 3dp (e.g. 1.5 kg): scale to integer thousandths.
    const qtyThousandths = Math.round(line.quantity * 1000);
    const totalCents = Math.round(
      (line.unitPriceCents * qtyThousandths) / 1000,
    );
    const vatCents =
      line.vatRate === "0.16" ? mulRate(totalCents, "0.16") : 0;
    return { totalCents, vatCents };
  }

  async createDraft(
    client: PoolClient,
    args: {
      tenantId: string;
      userId: string;
      branchId: string;
      customerId: string;
      dueDate?: string;
      lines: InvoiceLineInput[];
    },
  ): Promise<{ id: string }> {
    if (!args.lines.length) {
      throw new BadRequestException("An invoice needs at least one line");
    }
    const invoiceRes = await client.query(
      `INSERT INTO invoices (tenant_id, branch_id, customer_id, due_date, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [args.tenantId, args.branchId, args.customerId, args.dueDate ?? null, args.userId],
    );
    const invoiceId: string = invoiceRes.rows[0].id;
    let subtotal = 0;
    let vat = 0;
    for (const line of args.lines) {
      const { totalCents, vatCents } = this.computeLine(line);
      subtotal += totalCents;
      vat += vatCents;
      await client.query(
        `INSERT INTO invoice_lines
           (tenant_id, invoice_id, description, quantity, unit_price_cents,
            vat_rate, line_total_cents, vat_cents, item_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          args.tenantId,
          invoiceId,
          line.description,
          line.quantity,
          line.unitPriceCents,
          line.vatRate,
          totalCents,
          vatCents,
          line.itemId ?? null,
        ],
      );
    }
    await client.query(
      `UPDATE invoices SET subtotal_cents = $2, vat_cents = $3, total_cents = $4
       WHERE id = $1`,
      [invoiceId, subtotal, vat, subtotal + vat],
    );
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "invoice.drafted",
      entityType: "invoice",
      entityId: invoiceId,
      payload: { totalCents: subtotal + vat, lines: args.lines.length },
    });
    return { id: invoiceId };
  }

  /**
   * Full-reversal credit note (v1): reverses the invoice's ledger entry
   * (and COGS/stock for item lines), fiscalizes a credit_note with KRA,
   * and marks the invoice credited — one atomic transaction. Paid invoices
   * leave the received money as an unallocated customer credit in AR
   * (surfaced by the AR report; refunds via B2C are a follow-up).
   */
  async creditNote(
    client: PoolClient,
    args: {
      tenantId: string;
      userId: string;
      invoiceId: string;
      reason: string;
      date: string;
    },
  ): Promise<{ creditNoteNo: number; fiscalDocumentId: string }> {
    const invRes = await client.query(
      `SELECT id, branch_id, customer_id, status, invoice_no,
              subtotal_cents, vat_cents, total_cents
       FROM invoices WHERE id = $1 FOR UPDATE`,
      [args.invoiceId],
    );
    const inv = invRes.rows[0];
    if (!inv) throw new NotFoundException("Invoice not found");
    if (!["issued", "paid"].includes(inv.status)) {
      throw new BadRequestException(
        `Only issued or paid invoices can be credited (status: ${inv.status})`,
      );
    }
    const subtotal = Number(inv.subtotal_cents);
    const vat = Number(inv.vat_cents);
    const total = Number(inv.total_cents);

    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('credit-note-no:' || $1))",
      [args.tenantId],
    );
    const noRes = await client.query(
      `SELECT coalesce(max(credit_note_no), 0) + 1 AS next
       FROM credit_notes WHERE tenant_id = $1`,
      [args.tenantId],
    );
    const creditNoteNo = Number(noRes.rows[0].next);

    // Reverse the revenue posting: DR Sales, DR VAT / CR AR.
    const lines = [
      { accountCode: "4000", debitCents: subtotal, memo: `CN ${creditNoteNo}` },
      { accountCode: "1100", creditCents: total, memo: `CN ${creditNoteNo}` },
    ];
    if (vat > 0) {
      lines.push({ accountCode: "2200", debitCents: vat, memo: `CN ${creditNoteNo}` });
    }
    const posting = await this.ledger.post(client, {
      tenantId: args.tenantId,
      postedBy: args.userId,
      entryDate: args.date,
      memo: `Credit note ${creditNoteNo} for invoice ${inv.invoice_no}: ${args.reason}`,
      sourceType: "credit_note",
      sourceId: args.invoiceId,
      idempotencyKey: `credit-note:${args.invoiceId}`,
      lines,
    });

    // Restore stock and reverse COGS for catalogue-item lines.
    if (this.inventory) {
      const itemLines = await client.query(
        `SELECT item_id, quantity FROM invoice_lines
         WHERE invoice_id = $1 AND item_id IS NOT NULL`,
        [args.invoiceId],
      );
      let cogsCents = 0;
      for (const line of itemLines.rows as { item_id: string; quantity: string }[]) {
        const qty = Number(line.quantity);
        await this.inventory.recordMovement(client, {
          tenantId: args.tenantId,
          itemId: line.item_id,
          branchId: inv.branch_id,
          qtyDelta: qty,
          reason: "adjustment",
          refType: "credit_note",
          refId: args.invoiceId,
          userId: args.userId,
        });
        const item = await client.query(
          "SELECT cost_cents FROM items WHERE id = $1",
          [line.item_id],
        );
        cogsCents += Math.round(Number(item.rows[0].cost_cents) * qty);
      }
      if (cogsCents > 0) {
        await this.ledger.post(client, {
          tenantId: args.tenantId,
          postedBy: args.userId,
          entryDate: args.date,
          memo: `COGS reversal for credit note ${creditNoteNo}`,
          sourceType: "credit_note_cogs",
          sourceId: args.invoiceId,
          idempotencyKey: `credit-note-cogs:${args.invoiceId}`,
          lines: [
            { accountCode: "1200", debitCents: cogsCents },
            { accountCode: "5000", creditCents: cogsCents },
          ],
        });
      }
    }

    // Fiscalize the credit note with KRA.
    const fiscalDoc = await this.fiscal.enqueue(client, args.tenantId, {
      branchId: inv.branch_id,
      docType: "credit_note",
      idempotencyKey: `credit-note:${args.invoiceId}`,
      payload: {
        creditNoteNo,
        originalInvoiceNo: Number(inv.invoice_no),
        issueDate: args.date,
        reason: args.reason,
        subtotalCents: subtotal,
        vatCents: vat,
        totalCents: total,
      },
    });

    const cnRes = await client.query(
      `INSERT INTO credit_notes
         (tenant_id, invoice_id, credit_note_no, reason, subtotal_cents,
          vat_cents, total_cents, journal_entry_id, fiscal_document_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        args.tenantId, args.invoiceId, creditNoteNo, args.reason,
        subtotal, vat, total, posting.entryId, fiscalDoc.id, args.userId,
      ],
    );
    await client.query(
      "UPDATE invoices SET status = 'credited' WHERE id = $1",
      [args.invoiceId],
    );
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "invoice.credited",
      entityType: "credit_note",
      entityId: cnRes.rows[0].id,
      payload: { creditNoteNo, invoiceNo: Number(inv.invoice_no), reason: args.reason },
    });
    return { creditNoteNo, fiscalDocumentId: fiscalDoc.id };
  }

  /**
   * Replace all lines on a DRAFT invoice — the edit path. Issued
   * documents are immutable (corrections go through credit notes), so
   * this guards on status and recomputes totals from scratch.
   */
  async replaceDraftLines(
    client: PoolClient,
    args: {
      tenantId: string;
      invoiceId: string;
      dueDate?: string;
      lines: InvoiceLineInput[];
    },
  ): Promise<{ id: string; totalCents: number }> {
    if (!args.lines.length) {
      throw new BadRequestException("An invoice needs at least one line");
    }
    const inv = await client.query(
      "SELECT id, status FROM invoices WHERE id = $1 FOR UPDATE",
      [args.invoiceId],
    );
    if (!inv.rows[0]) throw new NotFoundException("Invoice not found");
    if (inv.rows[0].status !== "draft") {
      throw new BadRequestException(
        "Only draft invoices can be edited — issue corrections as credit notes",
      );
    }
    await client.query("DELETE FROM invoice_lines WHERE invoice_id = $1", [
      args.invoiceId,
    ]);
    let subtotal = 0;
    let vat = 0;
    for (const line of args.lines) {
      const { totalCents, vatCents } = this.computeLine(line);
      subtotal += totalCents;
      vat += vatCents;
      await client.query(
        `INSERT INTO invoice_lines
           (tenant_id, invoice_id, description, quantity, unit_price_cents,
            vat_rate, line_total_cents, vat_cents, item_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          args.tenantId,
          args.invoiceId,
          line.description,
          line.quantity,
          line.unitPriceCents,
          line.vatRate,
          totalCents,
          vatCents,
          line.itemId ?? null,
        ],
      );
    }
    await client.query(
      `UPDATE invoices
       SET subtotal_cents = $2, vat_cents = $3, total_cents = $4,
           due_date = coalesce($5, due_date)
       WHERE id = $1`,
      [args.invoiceId, subtotal, vat, subtotal + vat, args.dueDate ?? null],
    );
    return { id: args.invoiceId, totalCents: subtotal + vat };
  }

  async issue(
    client: PoolClient,
    args: { tenantId: string; userId: string; invoiceId: string; issueDate: string },
  ): Promise<{
    invoiceNo: number;
    totalCents: number;
    journalEntryId: string;
    fiscalDocumentId: string;
  }> {
    const invRes = await client.query(
      `SELECT id, branch_id, customer_id, status, subtotal_cents, vat_cents, total_cents
       FROM invoices WHERE id = $1 FOR UPDATE`,
      [args.invoiceId],
    );
    const inv = invRes.rows[0];
    if (!inv) throw new NotFoundException("Invoice not found");
    if (inv.status !== "draft") {
      throw new BadRequestException(`Only draft invoices can be issued (status: ${inv.status})`);
    }
    const subtotal = Number(inv.subtotal_cents);
    const vat = Number(inv.vat_cents);
    const total = Number(inv.total_cents);
    if (total <= 0 || total !== subtotal + vat) {
      throw new BadRequestException("Invoice totals are invalid");
    }

    // Per-tenant invoice number.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('invoice-no:' || $1))",
      [args.tenantId],
    );
    const noRes = await client.query(
      `SELECT coalesce(max(invoice_no), 0) + 1 AS next
       FROM invoices WHERE tenant_id = $1`,
      [args.tenantId],
    );
    const invoiceNo = Number(noRes.rows[0].next);

    // Ledger: DR Accounts Receivable / CR Sales / CR VAT Payable.
    const lines = [
      { accountCode: "1100", debitCents: total, memo: `Invoice ${invoiceNo}` },
      { accountCode: "4000", creditCents: subtotal, memo: `Invoice ${invoiceNo}` },
    ];
    if (vat > 0) {
      lines.push({
        accountCode: "2200",
        creditCents: vat,
        memo: `VAT on invoice ${invoiceNo}`,
      });
    }
    const posting = await this.ledger.post(client, {
      tenantId: args.tenantId,
      postedBy: args.userId,
      entryDate: args.issueDate,
      memo: `Invoice ${invoiceNo}`,
      sourceType: "invoice",
      sourceId: args.invoiceId,
      idempotencyKey: `invoice:${args.invoiceId}`,
      lines,
    });

    // eTIMS: fiscalize atomically with the issue (02-kenya-compliance.md §1).
    const linesRes = await client.query(
      `SELECT description, quantity, unit_price_cents, vat_rate,
              line_total_cents, vat_cents, item_id
       FROM invoice_lines WHERE invoice_id = $1`,
      [args.invoiceId],
    );

    // Inventory: decrement stock and post COGS for catalogue-item lines,
    // atomic with the issue — overselling aborts the whole issue.
    if (this.inventory) {
      let cogsCents = 0;
      for (const line of linesRes.rows as {
        item_id: string | null;
        quantity: string;
      }[]) {
        if (!line.item_id) continue;
        const item = await client.query(
          "SELECT cost_cents FROM items WHERE id = $1",
          [line.item_id],
        );
        if (!item.rows[0]) throw new BadRequestException("Unknown item on invoice");
        const qty = Number(line.quantity);
        await this.inventory.recordMovement(client, {
          tenantId: args.tenantId,
          itemId: line.item_id,
          branchId: inv.branch_id,
          qtyDelta: -qty,
          reason: "sale",
          refType: "invoice",
          refId: args.invoiceId,
          userId: args.userId,
        });
        cogsCents += Math.round(Number(item.rows[0].cost_cents) * qty);
      }
      if (cogsCents > 0) {
        await this.ledger.post(client, {
          tenantId: args.tenantId,
          postedBy: args.userId,
          entryDate: args.issueDate,
          memo: `COGS for invoice ${invoiceNo}`,
          sourceType: "invoice_cogs",
          sourceId: args.invoiceId,
          idempotencyKey: `invoice-cogs:${args.invoiceId}`,
          lines: [
            { accountCode: "5000", debitCents: cogsCents },
            { accountCode: "1200", creditCents: cogsCents },
          ],
        });
      }
    }
    const customerRes = await client.query(
      `SELECT name, kra_pin, phone FROM customers WHERE id = $1`,
      [inv.customer_id],
    );
    const fiscalDoc = await this.fiscal.enqueue(client, args.tenantId, {
      branchId: inv.branch_id,
      docType: "invoice",
      idempotencyKey: `invoice:${args.invoiceId}`,
      payload: {
        invoiceNo,
        issueDate: args.issueDate,
        buyer: customerRes.rows[0] ?? null,
        subtotalCents: subtotal,
        vatCents: vat,
        totalCents: total,
        lines: linesRes.rows,
      },
    });

    await client.query(
      `UPDATE invoices
       SET status = 'issued', invoice_no = $2, issue_date = $3,
           journal_entry_id = $4, fiscal_document_id = $5
       WHERE id = $1`,
      [args.invoiceId, invoiceNo, args.issueDate, posting.entryId, fiscalDoc.id],
    );

    // Customer SMS commits atomically with the issue (notification outbox).
    const customerPhone: string | null = customerRes.rows[0]?.phone ?? null;
    if (this.notifications && customerPhone) {
      const tenantRes = await client.query(
        "SELECT name FROM tenants WHERE id = $1",
        [args.tenantId],
      );
      await this.notifications.enqueue(client, args.tenantId, {
        channel: "sms",
        recipient: customerPhone,
        templateKey: "invoice_issued",
        payload: {
          businessName: tenantRes.rows[0]?.name ?? "Your supplier",
          invoiceNo,
          totalKes: (total / 100).toFixed(2),
        },
      });
    }
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "invoice.issued",
      entityType: "invoice",
      entityId: args.invoiceId,
      payload: { invoiceNo, totalCents: total },
    });
    return {
      invoiceNo,
      totalCents: total,
      journalEntryId: posting.entryId,
      fiscalDocumentId: fiscalDoc.id,
    };
  }
}
