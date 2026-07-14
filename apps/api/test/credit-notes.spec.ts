/**
 * Credit note + timeout sweep tests: full reversal reverses revenue, VAT,
 * COGS and stock atomically and fiscalizes a credit_note doc; double
 * crediting blocked; timeout sweep flips only stale pending payments.
 */
import { randomUUID } from "node:crypto";
import { DbService } from "../src/db/db.service";
import { AuditService } from "../src/audit/audit.service";
import { FiscalService } from "../src/fiscal/fiscal.service";
import { SandboxFiscalProvider } from "../src/fiscal/provider";
import { LedgerService, seedDefaultAccounts } from "../src/ledger/ledger.service";
import { InvoicesService } from "../src/invoicing/invoices.service";
import { InventoryService } from "../src/inventory/inventory.service";
import { PaymentsService } from "../src/payments/payments.service";
import { SandboxPaymentProvider } from "../src/payments/provider";

process.env.APP_DB_URL =
  process.env.APP_DB_URL_TEST ??
  "postgres://jenga_app:app_dev_pw@localhost:5432/jenga_test";
process.env.WORKER_DB_URL =
  process.env.WORKER_DB_URL_TEST ??
  "postgres://jenga_worker:worker_dev_pw@localhost:5432/jenga_test";

describe("credit notes + timeout sweep", () => {
  const db = new DbService();
  const ledger = new LedgerService();
  const audit = new AuditService();
  const fiscal = new FiscalService(new SandboxFiscalProvider());
  const inventory = new InventoryService();
  const invoices = new InvoicesService(ledger, fiscal, audit, undefined, inventory);
  const payments = new PaymentsService(db, ledger, audit, new SandboxPaymentProvider());

  let tenant: string;
  let user: string;
  let branch: string;
  let customer: string;
  let item: string;

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    const u = await db.query(
      `INSERT INTO users (email, password_hash, full_name)
       VALUES ($1, 'x', 'CN Tester') RETURNING id`,
      [`cn-${suffix}@test.local`],
    );
    user = u.rows[0].id;
    const t = await db.query(
      "SELECT create_tenant_with_owner($1, $2, $3) AS id",
      ["cn-co", `cn-co-${suffix}`, user],
    );
    tenant = t.rows[0].id;
    await db.withTenant(tenant, user, async (c) => {
      await seedDefaultAccounts(c, tenant);
      branch = (
        await c.query(
          `INSERT INTO branches (tenant_id, code, name) VALUES ($1, 'HQ', 'HQ') RETURNING id`,
          [tenant],
        )
      ).rows[0].id;
      customer = (
        await c.query(
          `INSERT INTO customers (tenant_id, name) VALUES ($1, 'CN Customer') RETURNING id`,
          [tenant],
        )
      ).rows[0].id;
      item = (
        await c.query(
          `INSERT INTO items (tenant_id, sku, name, cost_cents, price_cents)
           VALUES ($1, 'RICE-25', 'Rice 25kg', 300_000, 400_000) RETURNING id`,
          [tenant],
        )
      ).rows[0].id;
      await inventory.recordMovement(c, {
        tenantId: tenant, itemId: item, branchId: branch,
        qtyDelta: 20, reason: "purchase", userId: user,
      });
    });
  });

  afterAll(async () => {
    await fiscal.onModuleDestroy();
    await db.onModuleDestroy();
  });

  test("full-reversal credit note: ledger, VAT, stock, COGS and fiscal doc", async () => {
    const draft = await db.withTenant(tenant, user, (c) =>
      invoices.createDraft(c, {
        tenantId: tenant, userId: user, branchId: branch, customerId: customer,
        lines: [
          { description: "Rice 25kg", quantity: 5, unitPriceCents: 400_000, vatRate: "0.16", itemId: item },
        ],
      }),
    );
    await db.withTenant(tenant, user, (c) =>
      invoices.issue(c, {
        tenantId: tenant, userId: user, invoiceId: draft.id, issueDate: "2026-07-14",
      }),
    );

    const cn = await db.withTenant(tenant, user, (c) =>
      invoices.creditNote(c, {
        tenantId: tenant, userId: user, invoiceId: draft.id,
        reason: "Goods returned damaged", date: "2026-07-14",
      }),
    );
    expect(cn.creditNoteNo).toBe(1);

    const state = await db.withTenant(tenant, user, async (c) => {
      const inv = await c.query("SELECT status FROM invoices WHERE id = $1", [draft.id]);
      const tb = await ledger.trialBalance(c);
      const stock = await c.query(
        `SELECT coalesce(sum(qty_delta), 0) AS on_hand FROM stock_movements WHERE item_id = $1`,
        [item],
      );
      const fdoc = await c.query(
        "SELECT doc_type FROM fiscal_documents WHERE id = $1",
        [cn.fiscalDocumentId],
      );
      return {
        status: inv.rows[0].status,
        balances: Object.fromEntries(tb.map((a) => [a.code, a.balanceCents])),
        onHand: Number(stock.rows[0].on_hand),
        fiscalDocType: fdoc.rows[0].doc_type,
      };
    });
    expect(state.status).toBe("credited");
    // Everything nets back to pre-sale: AR, Sales, VAT, COGS all zero;
    // stock restored to 20.
    expect(state.balances["1100"]).toBe(0);
    expect(state.balances["4000"]).toBe(0);
    expect(state.balances["2200"]).toBe(0);
    expect(state.balances["5000"]).toBe(0);
    expect(state.onHand).toBe(20);
    expect(state.fiscalDocType).toBe("credit_note");

    // A second credit note on the same invoice is refused.
    await expect(
      db.withTenant(tenant, user, (c) =>
        invoices.creditNote(c, {
          tenantId: tenant, userId: user, invoiceId: draft.id,
          reason: "again", date: "2026-07-14",
        }),
      ),
    ).rejects.toThrow(/Only issued or paid/);
  });

  test("draft invoices cannot be credited", async () => {
    const draft = await db.withTenant(tenant, user, (c) =>
      invoices.createDraft(c, {
        tenantId: tenant, userId: user, branchId: branch, customerId: customer,
        lines: [{ description: "x", quantity: 1, unitPriceCents: 1000, vatRate: "0" }],
      }),
    );
    await expect(
      db.withTenant(tenant, user, (c) =>
        invoices.creditNote(c, {
          tenantId: tenant, userId: user, invoiceId: draft.id,
          reason: "nope", date: "2026-07-14",
        }),
      ),
    ).rejects.toThrow(/Only issued or paid/);
  });

  test("timeout sweep flips only stale pending payments", async () => {
    await db.withTenant(tenant, user, async (c) => {
      // A stale pending payment (backdated) and a fresh one.
      await c.query(
        `INSERT INTO payments (tenant_id, rail, state, amount_cents, provider_ref, created_at)
         VALUES ($1, 'mpesa_stk', 'pending', 1000, 'stale-ref', now() - interval '10 minutes'),
                ($1, 'mpesa_stk', 'pending', 2000, 'fresh-ref', now())`,
        [tenant],
      );
      const result = await payments.sweepTimeouts(c, 3);
      expect(result.swept).toBe(1);
      const states = await c.query(
        `SELECT provider_ref, state FROM payments
         WHERE provider_ref IN ('stale-ref', 'fresh-ref') ORDER BY provider_ref`,
      );
      expect(states.rows).toEqual([
        { provider_ref: "fresh-ref", state: "pending" },
        { provider_ref: "stale-ref", state: "timeout_reconciling" },
      ]);
    });
  });
});
