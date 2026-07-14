import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { AuditService } from "../audit/audit.service";
import { DbService } from "../db/db.service";
import { LedgerService } from "../ledger/ledger.service";
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
   * Match a confirmed payment to an open invoice and post the receipt.
   * Match rule v1: account_ref parses to the invoice number (with optional
   * INV- prefix) AND amounts are exactly equal AND invoice is issued.
   */
  async reconcile(
    client: PoolClient,
    tenantId: string,
    paymentId: string,
    forceInvoiceId?: string,
  ): Promise<{ matched: boolean }> {
    const pRes = await client.query(
      `SELECT id, amount_cents, account_ref, invoice_id, journal_entry_id,
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

    let invoice: { id: string; invoice_no: string; total_cents: string } | undefined;
    if (targetInvoiceId) {
      const r = await client.query(
        `SELECT id, invoice_no, total_cents FROM invoices
         WHERE id = $1 AND status = 'issued' FOR UPDATE`,
        [targetInvoiceId],
      );
      invoice = r.rows[0];
      const mismatch =
        invoice && Number(invoice.total_cents) !== Number(payment.amount_cents);
      if (!invoice || mismatch) {
        if (forceInvoiceId) {
          if (!invoice) throw new NotFoundException("Open invoice not found");
          throw new BadRequestException(
            "Amount mismatch: partial payments land in a later piece",
          );
        }
        return { matched: false }; // webhook path: to the exception queue
      }
    } else {
      const refDigits = /(\d+)\s*$/.exec(payment.account_ref ?? "")?.[1];
      if (!refDigits) return { matched: false };
      const r = await client.query(
        `SELECT id, invoice_no, total_cents FROM invoices
         WHERE invoice_no = $1 AND status = 'issued' AND total_cents = $2
         FOR UPDATE`,
        [Number(refDigits), payment.amount_cents],
      );
      invoice = r.rows[0];
      if (!invoice) return { matched: false };
    }

    const posting = await this.ledger.post(client, {
      tenantId,
      postedBy: null,
      entryDate: new Date().toISOString().slice(0, 10),
      memo: `M-Pesa ${payment.receipt_number ?? paymentId} for invoice ${invoice.invoice_no}`,
      sourceType: "payment",
      sourceId: paymentId,
      idempotencyKey: `payment:${paymentId}`,
      lines: [
        { accountCode: "1010", debitCents: Number(payment.amount_cents) },
        { accountCode: "1100", creditCents: Number(payment.amount_cents) },
      ],
    });
    await client.query(
      `UPDATE payments SET invoice_id = $2, journal_entry_id = $3 WHERE id = $1`,
      [paymentId, invoice.id, posting.entryId],
    );
    await client.query(
      `UPDATE invoices SET status = 'paid' WHERE id = $1`,
      [invoice.id],
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
        receipt: payment.receipt_number,
      },
    });
    return { matched: true };
  }
}
