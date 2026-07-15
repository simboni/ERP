import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { AuditService } from "../audit/audit.service";
import { DbService } from "../db/db.service";
import { LedgerService } from "../ledger/ledger.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PaymentProvider } from "./provider";

export const PAYMENT_PROVIDER = "PAYMENT_PROVIDER";

/** Minimal shapes of the Daraja callbacks we consume (sandbox-compatible). */
export interface C2bConfirmation {
  TransID: string; // MpesaReceiptNumber
  TransAmount: string; // KES units, e.g. "2620.00"
  BusinessShortCode: string;
  BillRefNumber: string; // payer-entered account reference
  MSISDN: string;
}

export interface StkCallback {
  CheckoutRequestID: string;
  ResultCode: number; // 0 = success
  ResultDesc: string;
  MpesaReceiptNumber?: string;
}

function kesToCents(amount: string): number {
  const n = Math.round(Number(amount) * 100);
  if (!Number.isFinite(n) || n <= 0) {
    throw new BadRequestException(`Invalid amount: ${amount}`);
  }
  return n;
}

/**
 * Payments + the auto-reconciliation engine (differentiator D2).
 * Callbacks are processed exactly-once via payment_inbox; every confirmed
 * payment tries to match an open invoice (account reference -> invoice_no,
 * then exact amount). A match posts DR M-Pesa / CR Accounts Receivable and
 * marks the invoice paid — atomically. Non-matches stay in the exception
 * queue for manual matching.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  /** Register the tenant's paybill/till so callbacks can route to it. */
  async registerShortcode(
    client: PoolClient,
    tenantId: string,
    shortcode: string,
  ): Promise<void> {
    const res = await client.query(
      `INSERT INTO mpesa_shortcodes (shortcode, tenant_id)
       VALUES ($1, $2) ON CONFLICT (shortcode) DO NOTHING`,
      [shortcode, tenantId],
    );
    if ((res.rowCount ?? 0) === 0) {
      const owner = await client.query(
        "SELECT tenant_id FROM mpesa_shortcodes WHERE shortcode = $1",
        [shortcode],
      );
      if (owner.rows[0]?.tenant_id !== tenantId) {
        throw new BadRequestException("Shortcode is registered to another workspace");
      }
    }
  }

  /** Customer-present collection: STK push. Two-phase: persist, then call out. */
  async initiateStk(args: {
    tenantId: string;
    userId: string;
    amountCents: number;
    msisdn: string;
    accountRef: string;
    invoiceId?: string;
  }): Promise<{ id: string; providerRef: string; state: string }> {
    if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) {
      throw new BadRequestException("amountCents must be a positive integer");
    }
    const paymentId = await this.db.withTenant(
      args.tenantId,
      args.userId,
      async (client) => {
        const res = await client.query(
          `INSERT INTO payments
             (tenant_id, rail, state, amount_cents, msisdn, account_ref, invoice_id)
           VALUES ($1, 'mpesa_stk', 'initiated', $2, $3, $4, $5)
           RETURNING id`,
          [args.tenantId, args.amountCents, args.msisdn, args.accountRef, args.invoiceId ?? null],
        );
        return res.rows[0].id as string;
      },
    );

    // External call OUTSIDE any DB transaction (04-architecture.md §5).
    const { providerRef } = await this.provider.initiateStkPush({
      tenantId: args.tenantId,
      amountCents: args.amountCents,
      msisdn: args.msisdn,
      accountRef: args.accountRef,
    });

    await this.db.withTenant(args.tenantId, args.userId, (client) =>
      client.query(
        `UPDATE payments SET state = 'pending', provider_ref = $2 WHERE id = $1`,
        [paymentId, providerRef],
      ),
    );
    return { id: paymentId, providerRef, state: "pending" };
  }

  /** C2B paybill/till confirmation webhook (exactly-once via inbox). */
  async handleC2bConfirmation(event: C2bConfirmation): Promise<{ accepted: boolean }> {
    const inserted = await this.db.query(
      `INSERT INTO payment_inbox (provider_event_id, event_type, payload)
       VALUES ($1, 'c2b_confirmation', $2)
       ON CONFLICT (provider_event_id) DO NOTHING
       RETURNING id`,
      [`c2b:${event.TransID}`, JSON.stringify(event)],
    );
    if (!inserted.rows[0]) return { accepted: true }; // replay: already handled

    const route = await this.db.query(
      "SELECT tenant_id FROM mpesa_shortcodes WHERE shortcode = $1",
      [event.BusinessShortCode],
    );
    const tenantId: string | undefined = route.rows[0]?.tenant_id;
    if (!tenantId) {
      // Unknown shortcode: keep the inbox row unprocessed for operator review.
      return { accepted: true };
    }

    await this.db.withTenant(tenantId, null, async (client) => {
      const payment = await client.query(
        `INSERT INTO payments
           (tenant_id, rail, state, amount_cents, msisdn, account_ref,
            receipt_number, raw, confirmed_at)
         VALUES ($1, 'mpesa_c2b', 'confirmed', $2, $3, $4, $5, $6, now())
         ON CONFLICT (tenant_id, receipt_number) DO NOTHING
         RETURNING id`,
        [
          tenantId,
          kesToCents(event.TransAmount),
          event.MSISDN,
          event.BillRefNumber?.trim() ?? "",
          event.TransID,
          JSON.stringify(event),
        ],
      );
      if (payment.rows[0]) {
        await this.reconcile(client, tenantId, payment.rows[0].id);
      }
    });
    await this.db.query(
      "UPDATE payment_inbox SET processed_at = now() WHERE provider_event_id = $1",
      [`c2b:${event.TransID}`],
    );
    return { accepted: true };
  }

  /** STK result webhook (exactly-once via inbox). */
  async handleStkCallback(event: StkCallback): Promise<{ accepted: boolean }> {
    const inserted = await this.db.query(
      `INSERT INTO payment_inbox (provider_event_id, event_type, payload)
       VALUES ($1, 'stk_callback', $2)
       ON CONFLICT (provider_event_id) DO NOTHING
       RETURNING id`,
      [`stk:${event.CheckoutRequestID}`, JSON.stringify(event)],
    );
    if (!inserted.rows[0]) return { accepted: true };

    // provider_ref -> tenant: look up via a definer-free path. The payments
    // table is RLS-guarded, so resolve the tenant from the inbox side using
    // shortcode-independent metadata is impossible here; instead scan the
    // shortcode map's tenants. Cheap and correct: provider_ref is unique
    // per tenant, and STK pushes we initiated always have a payments row.
    const tenants = await this.db.query(
      "SELECT DISTINCT tenant_id FROM mpesa_shortcodes",
    );
    for (const row of tenants.rows as { tenant_id: string }[]) {
      const done = await this.db.withTenant(row.tenant_id, null, async (client) => {
        const p = await client.query(
          "SELECT id FROM payments WHERE provider_ref = $1",
          [event.CheckoutRequestID],
        );
        if (!p.rows[0]) return false;
        if (event.ResultCode === 0) {
          await client.query(
            `UPDATE payments
             SET state = 'confirmed', receipt_number = $2, raw = raw || $3::jsonb,
                 confirmed_at = now()
             WHERE id = $1`,
            [p.rows[0].id, event.MpesaReceiptNumber ?? null, JSON.stringify(event)],
          );
          await this.reconcile(client, row.tenant_id, p.rows[0].id);
        } else {
          await client.query(
            `UPDATE payments SET state = 'failed', last_error = $2 WHERE id = $1`,
            [p.rows[0].id, event.ResultDesc],
          );
        }
        return true;
      });
      if (done) break;
    }
    await this.db.query(
      "UPDATE payment_inbox SET processed_at = now() WHERE provider_event_id = $1",
      [`stk:${event.CheckoutRequestID}`],
    );
    return { accepted: true };
  }

  /**
   * Mark stale pending STK payments timeout_reconciling. The verified
   * Daraja pattern (02 §4): a payment can succeed AFTER the timeout, so
   * these are never failed outright — they await a Transaction Status
   * query (production Daraja adapter) or a late callback, either of which
   * still confirms them. Runs per tenant; scheduled sweep joins the
   * worker cadence when the production adapter lands.
   */
  async sweepTimeouts(
    client: PoolClient,
    olderThanMinutes = 3,
  ): Promise<{ swept: number }> {
    const res = await client.query(
      `UPDATE payments
       SET state = 'timeout_reconciling',
           last_error = 'No callback within ' || $1 || ' minutes; awaiting status query'
       WHERE state = 'pending'
         AND created_at < now() - make_interval(mins => $1)`,
      [olderThanMinutes],
    );
    return { swept: res.rowCount ?? 0 };
  }

  /**
   * Match a confirmed payment to an open invoice and post the receipt.
   * Partial payments are first-class: the allocation is capped at the
   * invoice's outstanding balance; the invoice becomes 'paid' only when
   * fully covered, and any overpayment stays visible as an AR credit
   * (the ledger always books the full amount received).
   */
  /**
   * POS cash tender: insert a confirmed cash payment pre-linked to the
   * invoice and post it through the normal reconcile path — same ledger
   * treatment as M-Pesa, different drawer account. Runs on the caller's
   * transaction so the sale (issue + payment) commits atomically.
   */
  async recordCashPayment(
    client: PoolClient,
    args: {
      tenantId: string;
      invoiceId: string;
      invoiceNo: number;
      amountCents: number;
    },
  ): Promise<{ paymentId: string }> {
    const res = await client.query(
      `INSERT INTO payments
         (tenant_id, rail, state, amount_cents, account_ref,
          receipt_number, invoice_id, confirmed_at)
       VALUES ($1, 'cash', 'confirmed', $2, $3, $4, $5, now())
       RETURNING id`,
      [
        args.tenantId,
        args.amountCents,
        String(args.invoiceNo),
        `CASH-${args.invoiceNo}`,
        args.invoiceId,
      ],
    );
    const paymentId = res.rows[0].id as string;
    const m = await this.reconcile(
      client,
      args.tenantId,
      paymentId,
      args.invoiceId,
    );
    if (!m.matched) {
      throw new BadRequestException("Cash payment failed to match invoice");
    }
    return { paymentId };
  }

  /**
   * Record a payment received OUTSIDE the M-Pesa STK flow — cash handed
   * over, a bank transfer/cheque, or an M-Pesa amount already in the till
   * that the operator is reconciling by hand. Supports partial amounts, so
   * an invoice can be settled in instalments across rails. Posts the
   * matching journal entry and advances the invoice's paid total.
   */
  async recordManualPayment(
    client: PoolClient,
    args: {
      tenantId: string;
      userId: string;
      invoiceId: string;
      rail: "cash" | "bank" | "mpesa";
      amountCents: number;
      reference?: string;
    },
  ): Promise<{ paymentId: string; allocatedCents?: number }> {
    if (!["cash", "bank", "mpesa"].includes(args.rail)) {
      throw new BadRequestException("rail must be cash | bank | mpesa");
    }
    if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) {
      throw new BadRequestException("amountCents must be a positive integer");
    }
    const invRes = await client.query(
      `SELECT invoice_no, total_cents, amount_paid_cents, status
       FROM invoices WHERE id = $1 FOR UPDATE`,
      [args.invoiceId],
    );
    const inv = invRes.rows[0];
    if (!inv) throw new NotFoundException("Invoice not found");
    if (inv.status !== "issued") {
      throw new BadRequestException(
        `Only issued invoices take payments (status: ${inv.status})`,
      );
    }
    // The reconcile engine stores the M-Pesa rail as 'mpesa_c2b'/'stk';
    // for a hand-keyed M-Pesa entry we use the plain 'mpesa' float rail.
    const railStored = args.rail === "mpesa" ? "mpesa" : args.rail;
    const ref =
      args.reference?.trim() ||
      `${args.rail.toUpperCase()}-${inv.invoice_no}`;
    const res = await client.query(
      `INSERT INTO payments
         (tenant_id, rail, state, amount_cents, account_ref,
          receipt_number, invoice_id, confirmed_at)
       VALUES ($1, $2, 'confirmed', $3, $4, $5, $6, now())
       RETURNING id`,
      [
        args.tenantId,
        railStored,
        args.amountCents,
        String(inv.invoice_no),
        ref,
        args.invoiceId,
      ],
    );
    const paymentId = res.rows[0].id as string;
    const m = await this.reconcile(
      client,
      args.tenantId,
      paymentId,
      args.invoiceId,
    );
    if (!m.matched) {
      throw new BadRequestException("Payment failed to match the invoice");
    }
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "payment.manual",
      entityType: "payment",
      entityId: paymentId,
      payload: {
        invoiceNo: Number(inv.invoice_no),
        rail: args.rail,
        amountCents: args.amountCents,
      },
    });
    return { paymentId, allocatedCents: m.allocatedCents };
  }

  async reconcile(
    client: PoolClient,
    tenantId: string,
    paymentId: string,
    forceInvoiceId?: string,
  ): Promise<{ matched: boolean; allocatedCents?: number }> {
    const pRes = await client.query(
      `SELECT id, rail, amount_cents, account_ref, invoice_id, journal_entry_id,
              state, receipt_number
       FROM payments WHERE id = $1 FOR UPDATE`,
      [paymentId],
    );
    const payment = pRes.rows[0];
    if (!payment) throw new NotFoundException("Payment not found");
    if (payment.state !== "confirmed") return { matched: false };
    if (payment.journal_entry_id) return { matched: true }; // already posted

    // Target: explicit manual match > pre-linked intent (STK) > ref parsing.
    const targetInvoiceId: string | null =
      forceInvoiceId ?? payment.invoice_id ?? null;

    let invoice:
      | {
          id: string;
          invoice_no: string;
          total_cents: string;
          amount_paid_cents: string;
        }
      | undefined;
    if (targetInvoiceId) {
      const r = await client.query(
        `SELECT id, invoice_no, total_cents, amount_paid_cents FROM invoices
         WHERE id = $1 AND status = 'issued' FOR UPDATE`,
        [targetInvoiceId],
      );
      invoice = r.rows[0];
      if (!invoice) {
        if (forceInvoiceId) throw new NotFoundException("Open invoice not found");
        return { matched: false }; // webhook path: to the exception queue
      }
    } else {
      const refDigits = /(\d+)\s*$/.exec(payment.account_ref ?? "")?.[1];
      if (!refDigits) return { matched: false };
      const r = await client.query(
        `SELECT id, invoice_no, total_cents, amount_paid_cents FROM invoices
         WHERE invoice_no = $1 AND status = 'issued'
         FOR UPDATE`,
        [Number(refDigits)],
      );
      invoice = r.rows[0];
      if (!invoice) return { matched: false };
    }

    const outstanding =
      Number(invoice.total_cents) - Number(invoice.amount_paid_cents);
    const received = Number(payment.amount_cents);
    const allocated = Math.min(received, outstanding);
    if (allocated <= 0) {
      if (forceInvoiceId) {
        throw new BadRequestException("Invoice is already fully paid");
      }
      return { matched: false };
    }

    // Book the FULL amount received; overpayment shows as an AR credit.
    // Debit account follows the rail: cash drawer, bank, or M-Pesa float.
    const debitAccount =
      payment.rail === "cash"
        ? "1000"
        : payment.rail === "bank"
          ? "1020"
          : "1010";
    const railLabel =
      payment.rail === "cash"
        ? "Cash"
        : payment.rail === "bank"
          ? "Bank"
          : "M-Pesa";
    const posting = await this.ledger.post(client, {
      tenantId,
      postedBy: null,
      entryDate: new Date().toISOString().slice(0, 10),
      memo: `${railLabel} ${payment.receipt_number ?? paymentId} for invoice ${invoice.invoice_no}`,
      sourceType: "payment",
      sourceId: paymentId,
      idempotencyKey: `payment:${paymentId}`,
      lines: [
        { accountCode: debitAccount, debitCents: received },
        { accountCode: "1100", creditCents: received },
      ],
    });
    await client.query(
      `UPDATE payments SET invoice_id = $2, journal_entry_id = $3 WHERE id = $1`,
      [paymentId, invoice.id, posting.entryId],
    );
    const newPaid = Number(invoice.amount_paid_cents) + allocated;
    await client.query(
      `UPDATE invoices
       SET amount_paid_cents = $2,
           status = CASE WHEN $2 >= total_cents THEN 'paid' ELSE status END
       WHERE id = $1`,
      [invoice.id, newPaid],
    );
    await this.audit.record(client, {
      tenantId,
      actorUserId: null,
      action: "payment.reconciled",
      entityType: "payment",
      entityId: paymentId,
      payload: {
        invoiceNo: Number(invoice.invoice_no),
        amountCents: Number(payment.amount_cents),
        allocatedCents: allocated,
        receipt: payment.receipt_number,
      },
    });

    // Receipt SMS to the payer, atomic with the reconciliation.
    const payerMsisdn = (
      await client.query("SELECT msisdn FROM payments WHERE id = $1", [paymentId])
    ).rows[0]?.msisdn as string | null;
    if (this.notifications && payerMsisdn) {
      const tenantRes = await client.query(
        "SELECT name FROM tenants WHERE id = $1",
        [tenantId],
      );
      await this.notifications.enqueue(client, tenantId, {
        channel: "sms",
        recipient: payerMsisdn,
        templateKey: "payment_received",
        payload: {
          businessName: tenantRes.rows[0]?.name ?? "Your supplier",
          amountKes: (Number(payment.amount_cents) / 100).toFixed(2),
          receipt: payment.receipt_number ?? "-",
          invoiceNo: Number(invoice.invoice_no),
        },
      });
    }
    return { matched: true, allocatedCents: allocated };
  }
}
