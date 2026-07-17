import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import type { TenantTokenClaims } from "@jenga/shared";
import { renderReceiptPdf } from "./receipt-pdf";
import {
  JwtAuthGuard,
  Roles,
  RolesGuard,
  TenantClaims,
  TenantContextGuard,
} from "../auth/guards";
import { DbService } from "../db/db.service";
import {
  C2bConfirmation,
  PaymentsService,
  StkCallback,
} from "./payments.service";

@Controller("tenants/current/payments")
@UseGuards(JwtAuthGuard, TenantContextGuard, RolesGuard)
export class PaymentsController {
  constructor(
    private readonly db: DbService,
    private readonly payments: PaymentsService,
  ) {}

  @Post("shortcodes")
  @Roles("owner", "admin")
  async registerShortcode(
    @TenantClaims() claims: TenantTokenClaims,
    @Body() body: { shortcode?: string },
  ) {
    if (!body?.shortcode?.trim() || !/^\d{5,7}$/.test(body.shortcode.trim())) {
      throw new BadRequestException("shortcode must be 5-7 digits");
    }
    await this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.payments.registerShortcode(client, claims.tid, body.shortcode!.trim()),
    );
    return { shortcode: body.shortcode.trim() };
  }

  @Post("stk")
  @Roles("owner", "admin", "accountant", "cashier")
  async initiateStk(
    @TenantClaims() claims: TenantTokenClaims,
    @Body()
    body: {
      amountCents?: number;
      msisdn?: string;
      accountRef?: string;
      invoiceId?: string;
    },
  ) {
    if (!body?.msisdn || !/^2547\d{8}$/.test(body.msisdn)) {
      throw new BadRequestException("msisdn must be 2547XXXXXXXX");
    }
    if (!body?.accountRef?.trim()) {
      throw new BadRequestException("accountRef is required");
    }
    return this.payments.initiateStk({
      tenantId: claims.tid,
      userId: claims.sub,
      amountCents: body.amountCents ?? 0,
      msisdn: body.msisdn,
      accountRef: body.accountRef.trim(),
      invoiceId: body.invoiceId,
    });
  }

  @Get()
  async list(
    @TenantClaims() claims: TenantTokenClaims,
    @Query("invoiceId") invoiceId?: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = invoiceId
        ? await client.query(
            `SELECT id, rail, state, amount_cents, msisdn, account_ref,
                    receipt_number, invoice_id, confirmed_at, created_at
             FROM payments WHERE invoice_id = $1
             ORDER BY created_at DESC LIMIT 100`,
            [invoiceId],
          )
        : await client.query(
            `SELECT id, rail, state, amount_cents, msisdn, account_ref,
                    receipt_number, invoice_id, confirmed_at, created_at
             FROM payments ORDER BY created_at DESC LIMIT 100`,
          );
      return res.rows;
    });
  }

  /**
   * Official receipt for one payment — issued for EVERY confirmed payment,
   * partial or full. Shows the amount received plus the invoice's running
   * position so instalment payers get proof of payment with balance due.
   */
  @Get(":id/receipt.pdf")
  async receiptPdf(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) paymentId: string,
    @Res() res: Response,
  ) {
    const data = await this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const r = await client.query(
        `SELECT p.id, p.rail, p.state, p.amount_cents, p.receipt_number,
                p.confirmed_at,
                i.invoice_no, i.total_cents, i.amount_paid_cents,
                c.name AS customer_name, c.kra_pin AS customer_pin,
                t.name AS business_name, t.logo
         FROM payments p
         JOIN invoices i ON i.id = p.invoice_id
         JOIN customers c ON c.id = i.customer_id
         JOIN tenants t ON t.id = p.tenant_id
         WHERE p.id = $1`,
        [paymentId],
      );
      return r.rows[0];
    });
    if (!data) {
      throw new NotFoundException(
        "Payment not found or not yet matched to an invoice",
      );
    }
    if (data.state !== "confirmed") {
      throw new BadRequestException(
        `Receipts are only issued for confirmed payments (state: ${data.state})`,
      );
    }
    const pdf = await renderReceiptPdf({
      businessName: data.business_name,
      logo: data.logo || null,
      receiptNumber: data.receipt_number ?? data.id,
      paymentDate: data.confirmed_at
        ? new Date(data.confirmed_at).toISOString().slice(0, 10)
        : null,
      rail: data.rail,
      customerName: data.customer_name,
      customerPin: data.customer_pin,
      invoiceNo: data.invoice_no,
      amountReceivedCents: Number(data.amount_cents),
      invoiceTotalCents: Number(data.total_cents),
      amountPaidToDateCents: Number(data.amount_paid_cents),
    });
    res
      .status(200)
      .set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="receipt-${String(
          data.receipt_number ?? data.invoice_no,
        ).replace(/["\\\r\n]/g, "_")}.pdf"`,
      })
      .send(pdf);
  }

  /** Exception queue: confirmed money that matched no invoice. */
  @Get("unmatched")
  @Roles("owner", "admin", "accountant")
  async unmatched(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT id, rail, amount_cents, msisdn, account_ref, receipt_number,
                confirmed_at
         FROM payments
         WHERE state = 'confirmed' AND invoice_id IS NULL
         ORDER BY confirmed_at`,
      );
      return res.rows;
    });
  }

  /** Single payment state — the POS polls this while an STK push is out. */
  @Get(":id")
  async getOne(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) paymentId: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT id, rail, state, amount_cents, receipt_number, invoice_id,
                last_error, confirmed_at
         FROM payments WHERE id = $1`,
        [paymentId],
      );
      if (!res.rows[0]) throw new BadRequestException("Payment not found");
      return res.rows[0];
    });
  }

  @Post("sweep-timeouts")
  @Roles("owner", "admin", "accountant")
  async sweepTimeouts(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.payments.sweepTimeouts(client),
    );
  }

  @Post(":id/match")
  @Roles("owner", "admin", "accountant")
  async manualMatch(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) paymentId: string,
    @Body() body: { invoiceId?: string },
  ) {
    if (!body?.invoiceId) throw new BadRequestException("invoiceId is required");
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.payments.reconcile(client, claims.tid, paymentId, body.invoiceId),
    );
  }
}

/**
 * Public Daraja webhooks. No JWT: Safaricom calls these. Defence layers:
 * exactly-once inbox dedupe, shortcode->tenant routing, and (production)
 * source IP allowlisting + HTTPS per the Daraja go-live requirements.
 */
@Controller("webhooks/mpesa")
export class MpesaWebhookController {
  constructor(private readonly payments: PaymentsService) {}

  @Post("c2b/confirmation")
  @HttpCode(200)
  async c2bConfirmation(@Body() body: C2bConfirmation) {
    if (!body?.TransID || !body?.BusinessShortCode || !body?.TransAmount) {
      // Ack with the Daraja-expected shape; never 500 at Safaricom.
      return { ResultCode: "C2B00012", ResultDesc: "Rejected" };
    }
    await this.payments.handleC2bConfirmation(body);
    return { ResultCode: "0", ResultDesc: "Accepted" };
  }

  @Post("stk")
  @HttpCode(200)
  async stkCallback(@Body() body: { Body?: { stkCallback?: StkCallback } }) {
    const cb = body?.Body?.stkCallback;
    if (!cb?.CheckoutRequestID) {
      return { ResultCode: 1, ResultDesc: "Rejected" };
    }
    await this.payments.handleStkCallback(cb);
    return { ResultCode: 0, ResultDesc: "Accepted" };
  }
}
