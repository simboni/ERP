import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { TenantTokenClaims } from "@jenga/shared";
import {
  JwtAuthGuard,
  Roles,
  RolesGuard,
  TenantClaims,
  TenantContextGuard,
} from "../auth/guards";
import { DbService } from "../db/db.service";
import { seedDefaultAccounts } from "../ledger/ledger.service";
import { PaymentsService } from "../payments/payments.service";
import { InvoicesService, InvoiceLineInput } from "./invoices.service";

const POS_ROLES = ["owner", "admin", "accountant", "cashier"] as const;

/**
 * Point of sale: one call turns a cart into an issued (fiscalized,
 * stock-decremented, ledger-posted) invoice, optionally settled in cash
 * in the same transaction. Prices always come from the catalog — the
 * client never supplies amounts. M-Pesa STK is intentionally NOT here:
 * external calls stay outside DB transactions, so the client sequences
 * pos/sales -> payments/stk -> poll payments/:id.
 */
@Controller("tenants/current/pos")
@UseGuards(JwtAuthGuard, TenantContextGuard, RolesGuard)
export class PosController {
  constructor(
    private readonly db: DbService,
    private readonly invoices: InvoicesService,
    private readonly payments: PaymentsService,
  ) {}

  @Post("sales")
  @Roles(...POS_ROLES)
  async sell(
    @TenantClaims() claims: TenantTokenClaims,
    @Body()
    body: {
      branchId?: string;
      customerId?: string;
      payMethod?: "cash" | "mpesa_stk";
      lines?: { itemId?: string; quantity?: number }[];
      tenderedCents?: number;
    },
  ) {
    if (!body?.branchId) throw new BadRequestException("branchId is required");
    if (!["cash", "mpesa_stk"].includes(body?.payMethod ?? "")) {
      throw new BadRequestException("payMethod must be cash | mpesa_stk");
    }
    const cart = (body.lines ?? []).filter(
      (l) => l?.itemId && Number.isFinite(l.quantity) && l.quantity! > 0,
    );
    if (cart.length === 0) {
      throw new BadRequestException("The cart is empty");
    }

    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      await seedDefaultAccounts(client, claims.tid);

      // Walk-in default customer, race-safe per tenant.
      let customerId = body.customerId ?? null;
      if (!customerId) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext('pos-walkin:' || $1))",
          [claims.tid],
        );
        const existing = await client.query(
          `SELECT id FROM customers WHERE name = 'Walk-in Customer'
           ORDER BY created_at LIMIT 1`,
        );
        customerId =
          existing.rows[0]?.id ??
          (
            await client.query(
              `INSERT INTO customers (tenant_id, name)
               VALUES ($1, 'Walk-in Customer') RETURNING id`,
              [claims.tid],
            )
          ).rows[0].id;
      }

      // Server-side pricing from the catalog.
      const itemIds = cart.map((l) => l.itemId!);
      const itemsRes = await client.query(
        `SELECT id, name, price_cents, vat_rate FROM items
         WHERE id = ANY($1::uuid[]) AND active`,
        [itemIds],
      );
      const byId = new Map<string, (typeof itemsRes.rows)[number]>(
        itemsRes.rows.map((r) => [r.id, r]),
      );
      const lines: InvoiceLineInput[] = cart.map((l) => {
        const item = byId.get(l.itemId!);
        if (!item) {
          throw new BadRequestException(`Unknown item ${l.itemId}`);
        }
        return {
          description: item.name,
          quantity: l.quantity!,
          unitPriceCents: Number(item.price_cents),
          vatRate: item.vat_rate,
          itemId: item.id,
        };
      });

      const draft = await this.invoices.createDraft(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        branchId: body.branchId!,
        customerId: customerId!,
        lines,
      });
      const issued = await this.invoices.issue(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        invoiceId: draft.id,
        issueDate: new Date().toISOString().slice(0, 10),
      });

      let changeCents = 0;
      if (body.payMethod === "cash") {
        if (body.tenderedCents !== undefined) {
          if (
            !Number.isInteger(body.tenderedCents) ||
            body.tenderedCents < issued.totalCents
          ) {
            throw new BadRequestException(
              "Tendered amount is less than the total",
            );
          }
          changeCents = body.tenderedCents - issued.totalCents;
        }
        await this.payments.recordCashPayment(client, {
          tenantId: claims.tid,
          invoiceId: draft.id,
          invoiceNo: issued.invoiceNo,
          amountCents: issued.totalCents,
        });
      }

      const inv = await client.query(
        `SELECT subtotal_cents, vat_cents FROM invoices WHERE id = $1`,
        [draft.id],
      );
      return {
        invoiceId: draft.id,
        invoiceNo: issued.invoiceNo,
        totalCents: issued.totalCents,
        subtotalCents: Number(inv.rows[0].subtotal_cents),
        vatCents: Number(inv.rows[0].vat_cents),
        paid: body.payMethod === "cash",
        changeCents,
        lines: lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unitPriceCents: l.unitPriceCents,
        })),
      };
    });
  }
}
