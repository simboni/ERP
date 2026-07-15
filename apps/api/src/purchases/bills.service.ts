import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { AuditService } from "../audit/audit.service";
import { ControlsService } from "../controls/controls.service";
import { DbService } from "../db/db.service";
import { InvoiceLineInput } from "../invoicing/invoices.service";
import { LedgerService } from "../ledger/ledger.service";
import { mulRate } from "../payroll/calculator";
import { PAYOUT_PROVIDER, PayoutProvider } from "../payments/payout.provider";

export type SettlementMethod = "cash" | "bank" | "mpesa_b2c";
const SETTLEMENT_ACCOUNT: Record<SettlementMethod, string> = {
  cash: "1000",
  bank: "1020",
  mpesa_b2c: "1010",
};

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
    @Inject(PAYOUT_PROVIDER) private readonly payout: PayoutProvider,
    private readonly db: DbService,
    private readonly controls: ControlsService,
  ) {}

  /**
   * Settle an approved bill: DR Accounts Payable / CR cash|bank|M-Pesa.
   * For mpesa_b2c the provider call happens OUTSIDE any transaction
   * (two-phase, like every external call); the settlement posts only after
   * the payout is accepted, carrying the provider reference in the audit.
   */
  async pay(args: {
    tenantId: string;
    userId: string;
    billId: string;
    method: SettlementMethod;
    msisdn?: string;
  }): Promise<{ journalEntryId: string; providerRef: string | null }> {
    // Phase 1: validate state and capture the amount.
    const bill = await this.db.withTenant(
      args.tenantId,
      args.userId,
      async (client) => {
        const r = await client.query(
          `SELECT b.id, b.status, b.total_cents, b.supplier_invoice_no,
                  s.name AS supplier_name
           FROM bills b JOIN suppliers s ON s.id = b.supplier_id
           WHERE b.id = $1`,
          [args.billId],
        );
        return r.rows[0] as
          | {
              id: string;
              status: string;
              total_cents: string;
              supplier_invoice_no: string | null;
              supplier_name: string;
            }
          | undefined;
      },
    );
    if (!bill) throw new NotFoundException("Bill not found");
    if (bill.status !== "approved") {
      throw new BadRequestException(
        `Only approved bills can be paid (status: ${bill.status})`,
      );
    }

    // Approval-threshold gate (business controls): blocks BEFORE any money
    // moves. Files a pending request and throws 403 when sign-off is due.
    await this.controls.enforce({
      tenantId: args.tenantId,
      userId: args.userId,
      docType: "bill_payment",
      docId: args.billId,
      amountCents: Number(bill.total_cents),
    });

    // Phase 2: external payout for the M-Pesa rail.
    let providerRef: string | null = null;
    if (args.method === "mpesa_b2c") {
      if (!args.msisdn || !/^2547\d{8}$/.test(args.msisdn)) {
        throw new BadRequestException("msisdn (2547XXXXXXXX) required for M-Pesa payout");
      }
      const res = await this.payout.sendB2C({
        tenantId: args.tenantId,
        amountCents: Number(bill.total_cents),
        msisdn: args.msisdn,
        remarks: `Bill ${bill.supplier_invoice_no ?? bill.id}`,
      });
      providerRef = res.providerRef;
    }

    // Phase 3: post the settlement and flip status, atomically + idempotently.
    const journalEntryId = await this.db.withTenant(
      args.tenantId,
      args.userId,
      async (client) => {
        const locked = await client.query(
          "SELECT status FROM bills WHERE id = $1 FOR UPDATE",
          [args.billId],
        );
        if (locked.rows[0].status !== "approved") {
          throw new BadRequestException("Bill was settled concurrently");
        }
        const posting = await this.ledger.post(client, {
          tenantId: args.tenantId,
          postedBy: args.userId,
          entryDate: new Date().toISOString().slice(0, 10),
          memo: `Payment of bill ${bill.supplier_invoice_no ?? args.billId} to ${bill.supplier_name}`,
          sourceType: "bill_payment",
          sourceId: args.billId,
          idempotencyKey: `bill-payment:${args.billId}`,
          lines: [
            { accountCode: "2100", debitCents: Number(bill.total_cents) },
            {
              accountCode: SETTLEMENT_ACCOUNT[args.method],
              creditCents: Number(bill.total_cents),
            },
          ],
        });
        await client.query(
          "UPDATE bills SET status = 'paid' WHERE id = $1",
          [args.billId],
        );
        await this.audit.record(client, {
          tenantId: args.tenantId,
          actorUserId: args.userId,
          action: "bill.paid",
          entityType: "bill",
          entityId: args.billId,
          payload: {
            method: args.method,
            amountCents: Number(bill.total_cents),
            providerRef,
          },
        });
        return posting.entryId;
      },
    );
    return { journalEntryId, providerRef };
  }

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
