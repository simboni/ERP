import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { AuditService } from "../audit/audit.service";
import { InvoiceLineInput } from "../invoicing/invoices.service";
import { LedgerService } from "../ledger/ledger.service";
import { mulRate } from "../payroll/calculator";

export interface BillLineInput extends InvoiceLineInput {
  accountCode?: string; // expense/COGS account, default 6000
}

/**
 * Purchases: supplier bills with per-line VAT. approve() posts
 * DR expense accounts (net) / DR Input VAT (1300) / CR Accounts Payable —
 * atomically, once. Bills without an eTIMS control number remain legal to
 * record but are flagged: under s.23A the expense is NOT deductible and
 * the input VAT claim will fail KRA validation.
 */
@Injectable()
export class BillsService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  async createDraft(
    client: PoolClient,
    args: {
      tenantId: string;
      userId: string;
      supplierId: string;
      billDate: string;
      dueDate?: string;
      supplierInvoiceNo?: string;
      etimsControlNumber?: string;
      lines: BillLineInput[];
    },
  ): Promise<{ id: string; totalCents: number }> {
    if (!args.lines.length) {
      throw new BadRequestException("A bill needs at least one line");
    }
    const billRes = await client.query(
      `INSERT INTO bills
         (tenant_id, supplier_id, bill_date, due_date, supplier_invoice_no,
          etims_control_number, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        args.tenantId,
        args.supplierId,
        args.billDate,
        args.dueDate ?? null,
        args.supplierInvoiceNo?.trim() || null,
        args.etimsControlNumber?.trim() || null,
        args.userId,
      ],
    );
    const billId: string = billRes.rows[0].id;
    let subtotal = 0;
    let vat = 0;
    for (const line of args.lines) {
      const qtyThousandths = Math.round(line.quantity * 1000);
      const totalCents = Math.round((line.unitPriceCents * qtyThousandths) / 1000);
      const vatCents = line.vatRate === "0.16" ? mulRate(totalCents, "0.16") : 0;
      subtotal += totalCents;
      vat += vatCents;
      await client.query(
        `INSERT INTO bill_lines
           (tenant_id, bill_id, description, quantity, unit_price_cents,
            vat_rate, line_total_cents, vat_cents, account_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          args.tenantId,
          billId,
          line.description,
          line.quantity,
          line.unitPriceCents,
          line.vatRate,
          totalCents,
          vatCents,
          line.accountCode ?? "6000",
        ],
      );
    }
    await client.query(
      `UPDATE bills SET subtotal_cents = $2, vat_cents = $3, total_cents = $4
       WHERE id = $1`,
      [billId, subtotal, vat, subtotal + vat],
    );
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "bill.drafted",
      entityType: "bill",
      entityId: billId,
      payload: {
        supplierId: args.supplierId,
        totalCents: subtotal + vat,
        hasEtims: Boolean(args.etimsControlNumber),
      },
    });
    return { id: billId, totalCents: subtotal + vat };
  }

  async approve(
    client: PoolClient,
    args: { tenantId: string; userId: string; billId: string },
  ): Promise<{ journalEntryId: string }> {
    const billRes = await client.query(
      `SELECT id, status, subtotal_cents, vat_cents, total_cents, bill_date,
              supplier_invoice_no, etims_control_number
       FROM bills WHERE id = $1 FOR UPDATE`,
      [args.billId],
    );
    const bill = billRes.rows[0];
    if (!bill) throw new NotFoundException("Bill not found");
    if (bill.status !== "draft") {
      throw new BadRequestException("Only draft bills can be approved");
    }
    const linesRes = await client.query(
      `SELECT account_code, sum(line_total_cents)::bigint AS net
       FROM bill_lines WHERE bill_id = $1 GROUP BY account_code`,
      [args.billId],
    );
    const vat = Number(bill.vat_cents);
    const lines = linesRes.rows.map(
      (r: { account_code: string; net: string }) => ({
        accountCode: r.account_code,
        debitCents: Number(r.net),
        memo: `Bill ${bill.supplier_invoice_no ?? args.billId}`,
      }),
    ) as {
      accountCode: string;
      debitCents?: number;
      creditCents?: number;
      memo?: string;
    }[];
    if (vat > 0) {
      lines.push({ accountCode: "1300", debitCents: vat, memo: "Input VAT" });
    }
    lines.push({
      accountCode: "2100",
      creditCents: Number(bill.total_cents),
      memo: `Bill ${bill.supplier_invoice_no ?? args.billId}`,
    });

    const posting = await this.ledger.post(client, {
      tenantId: args.tenantId,
      postedBy: args.userId,
      entryDate: new Date(bill.bill_date).toISOString().slice(0, 10),
      memo: `Supplier bill ${bill.supplier_invoice_no ?? ""}`.trim(),
      sourceType: "bill",
      sourceId: args.billId,
      idempotencyKey: `bill:${args.billId}`,
      lines,
    });
    await client.query(
      `UPDATE bills SET status = 'approved', journal_entry_id = $2 WHERE id = $1`,
      [args.billId, posting.entryId],
    );
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "bill.approved",
      entityType: "bill",
      entityId: args.billId,
      payload: {
        totalCents: Number(bill.total_cents),
        etims: bill.etims_control_number ?? null,
      },
    });
    return { journalEntryId: posting.entryId };
  }
}
