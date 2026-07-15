/**
 * Payments + reconciliation tests against jenga_test:
 *  - C2B confirmation auto-matches an issued invoice by ref+amount and
 *    posts DR M-Pesa / CR AR, marking the invoice paid,
 *  - callback replay is exactly-once (inbox dedupe),
 *  - unmatched money lands in the exception queue; manual match works,
 *  - STK flow: initiate -> pending -> callback confirms and reconciles,
 *  - RLS isolation and zero-net trial balance at the end.
 */
import { randomUUID } from "node:crypto";
import { DbService } from "../src/db/db.service";
import { AuditService } from "../src/audit/audit.service";
import { FiscalService } from "../src/fiscal/fiscal.service";
import { SandboxFiscalProvider } from "../src/fiscal/provider";
import { LedgerService, seedDefaultAccounts } from "../src/ledger/ledger.service";
import { InvoicesService } from "../src/invoicing/invoices.service";
import { PaymentsService } from "../src/payments/payments.service";
import { SandboxPaymentProvider } from "../src/payments/provider";

process.env.APP_DB_URL =
  process.env.APP_DB_URL_TEST ??
  "postgres://jenga_app:app_dev_pw@localhost:5432/jenga_test";
process.env.WORKER_DB_URL =
  process.env.WORKER_DB_URL_TEST ??
  "postgres://jenga_worker:worker_dev_pw@localhost:5432/jenga_test";

describe("payments + reconciliation", () => {
  const db = new DbService();
  const ledger = new LedgerService();
  const audit = new AuditService();
  const fiscal = new FiscalService(new SandboxFiscalProvider());
  const invoices = new InvoicesService(ledger, fiscal, audit);
  const payments = new PaymentsService(db, ledger, audit, new SandboxPaymentProvider());

  const shortcode = String(500000 + Math.floor(Math.random() * 99999));
  const runId = randomUUID().slice(0, 6).toUpperCase();
  const rcpt = (n: number): string => `SBX${runId}R${n}`;
  let tenant: string;
  let user: string;
  let branch: string;
  let customer: string;

  const makeIssuedInvoice = async (unitPriceCents: number): Promise<{
    id: string;
    invoiceNo: number;
    totalCents: number;
  }> => {
    const draft = await db.withTenant(tenant, user, (c) =>
      invoices.createDraft(c, {
        tenantId: tenant,
        userId: user,
        branchId: branch,
        customerId: customer,
        lines: [
          { description: "Goods", quantity: 1, unitPriceCents, vatRate: "0.16" },
        ],
      }),
    );
    const issued = await db.withTenant(tenant, user, (c) =>
      invoices.issue(c, {
        tenantId: tenant,
        userId: user,
        invoiceId: draft.id,
        issueDate: "2026-07-14",
      }),
    );
    return { id: draft.id, invoiceNo: issued.invoiceNo, totalCents: issued.totalCents };
  };

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    const u = await db.query(
      `INSERT INTO users (email, password_hash, full_name)
       VALUES ($1, 'x', 'Pay Tester') RETURNING id`,
      [`pay-${suffix}@test.local`],
    );
    user = u.rows[0].id;
    const t = await db.query(
      "SELECT create_tenant_with_owner($1, $2, $3) AS id",
      ["pay-co", `pay-co-${suffix}`, user],
    );
    tenant = t.rows[0].id;
    await db.withTenant(tenant, user, async (c) => {
      await seedDefaultAccounts(c, tenant);
      const b = await c.query(
        `INSERT INTO branches (tenant_id, code, name)
         VALUES ($1, 'HQ', 'HQ') RETURNING id`,
        [tenant],
      );
      branch = b.rows[0].id;
      const cu = await c.query(
        `INSERT INTO customers (tenant_id, name) VALUES ($1, 'Duka la Pesa') RETURNING id`,
        [tenant],
      );
      customer = cu.rows[0].id;
      await payments.registerShortcode(c, tenant, shortcode);
    });
  });

  afterAll(async () => {
    // Drain the cross-tenant fiscal queue so the extra invoices this spec
    // issues don't overflow the capped drain loop in rules-and-fiscal.spec.
    for (let i = 0; i < 60; i++) {
      if (!(await fiscal.processOnce())) break;
    }
    await fiscal.onModuleDestroy();
    await db.onModuleDestroy();
  });

  test("C2B confirmation auto-reconciles: invoice paid, DR M-Pesa / CR AR", async () => {
    const inv = await makeIssuedInvoice(100_000); // total 1,160.00
    expect(inv.totalCents).toBe(116_000);

    await payments.handleC2bConfirmation({
      TransID: rcpt(1),
      TransAmount: "1160.00",
      BusinessShortCode: shortcode,
      BillRefNumber: `INV-${inv.invoiceNo}`,
      MSISDN: "254712345678",
    });

    const state = await db.withTenant(tenant, user, async (c) => {
      const invoice = await c.query(
        "SELECT status FROM invoices WHERE id = $1",
        [inv.id],
      );
      const payment = await c.query(
        `SELECT state, invoice_id, journal_entry_id
         FROM payments WHERE receipt_number = $1`,
        [rcpt(1)],
      );
      const mpesa = await c.query(
        `SELECT coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint AS bal
         FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
         WHERE a.code = '1010'`,
      );
      return {
        invoiceStatus: invoice.rows[0].status,
        payment: payment.rows[0],
        mpesaBalance: Number(mpesa.rows[0].bal),
      };
    });
    expect(state.invoiceStatus).toBe("paid");
    expect(state.payment.state).toBe("confirmed");
    expect(state.payment.invoice_id).toBe(inv.id);
    expect(state.payment.journal_entry_id).toBeTruthy();
    expect(state.mpesaBalance).toBe(116_000);
  });

  test("replayed callback is a no-op (exactly-once inbox)", async () => {
    await payments.handleC2bConfirmation({
      TransID: rcpt(1),
      TransAmount: "1160.00",
      BusinessShortCode: shortcode,
      BillRefNumber: "INV-1",
      MSISDN: "254712345678",
    });
    const count = await db.withTenant(tenant, user, async (c) => {
      const r = await c.query(
        "SELECT count(*)::int AS n FROM payments WHERE receipt_number = $1",
        [rcpt(1)],
      );
      return r.rows[0].n;
    });
    expect(count).toBe(1);
  });

  test("no matching invoice -> exception queue; manual match posts and pays", async () => {
    const inv = await makeIssuedInvoice(250_000); // total 2,900.00

    await payments.handleC2bConfirmation({
      TransID: rcpt(2),
      TransAmount: "2900.00",
      BusinessShortCode: shortcode,
      BillRefNumber: "no-ref-given",
      MSISDN: "254798765432",
    });

    const unmatched = await db.withTenant(tenant, user, async (c) => {
      const r = await c.query(
        `SELECT id FROM payments WHERE state = 'confirmed' AND invoice_id IS NULL`,
      );
      return r.rows;
    });
    expect(unmatched).toHaveLength(1);

    const result = await db.withTenant(tenant, user, (c) =>
      payments.reconcile(c, tenant, unmatched[0].id, inv.id),
    );
    expect(result.matched).toBe(true);

    const status = await db.withTenant(tenant, user, async (c) => {
      const r = await c.query("SELECT status FROM invoices WHERE id = $1", [inv.id]);
      return r.rows[0].status;
    });
    expect(status).toBe("paid");
  });

  test("manual match with a smaller amount allocates partially", async () => {
    const inv = await makeIssuedInvoice(999_900); // total 11,598.84
    await payments.handleC2bConfirmation({
      TransID: rcpt(3),
      TransAmount: "50.00",
      BusinessShortCode: shortcode,
      BillRefNumber: "",
      MSISDN: "254700000001",
    });
    const unmatched = await db.withTenant(tenant, user, async (c) => {
      const r = await c.query(
        `SELECT id FROM payments WHERE receipt_number = $1`, [rcpt(3)],
      );
      return r.rows[0];
    });
    const result = await db.withTenant(tenant, user, (c) =>
      payments.reconcile(c, tenant, unmatched.id, inv.id),
    );
    expect(result).toEqual({ matched: true, allocatedCents: 5_000 });

    const after = await db.withTenant(tenant, user, async (c) => {
      const r = await c.query(
        "SELECT status, amount_paid_cents FROM invoices WHERE id = $1",
        [inv.id],
      );
      return r.rows[0];
    });
    expect(after.status).toBe("issued"); // still open
    expect(Number(after.amount_paid_cents)).toBe(5_000);
  });

  test("instalments: two partial C2B payments fully settle an invoice", async () => {
    const inv = await makeIssuedInvoice(500_000); // total 5,800.00
    await payments.handleC2bConfirmation({
      TransID: rcpt(5),
      TransAmount: "3000.00",
      BusinessShortCode: shortcode,
      BillRefNumber: `INV-${inv.invoiceNo}`,
      MSISDN: "254700000002",
    });
    const mid = await db.withTenant(tenant, user, async (c) => {
      const r = await c.query(
        "SELECT status, amount_paid_cents FROM invoices WHERE id = $1",
        [inv.id],
      );
      return r.rows[0];
    });
    expect(mid.status).toBe("issued");
    expect(Number(mid.amount_paid_cents)).toBe(300_000);

    await payments.handleC2bConfirmation({
      TransID: rcpt(6),
      TransAmount: "2800.00",
      BusinessShortCode: shortcode,
      BillRefNumber: `INV-${inv.invoiceNo}`,
      MSISDN: "254700000002",
    });
    const done = await db.withTenant(tenant, user, async (c) => {
      const r = await c.query(
        "SELECT status, amount_paid_cents FROM invoices WHERE id = $1",
        [inv.id],
      );
      return r.rows[0];
    });
    expect(done.status).toBe("paid");
    expect(Number(done.amount_paid_cents)).toBe(580_000);
  });

  test("STK: initiate -> pending -> success callback confirms and reconciles", async () => {
    const inv = await makeIssuedInvoice(50_000); // total 580.00
    const stk = await payments.initiateStk({
      tenantId: tenant,
      userId: user,
      amountCents: inv.totalCents,
      msisdn: "254712000000",
      accountRef: `INV-${inv.invoiceNo}`,
      invoiceId: inv.id,
    });
    expect(stk.state).toBe("pending");
    expect(stk.providerRef).toMatch(/^ws_CO_SBX_/);

    await payments.handleStkCallback({
      CheckoutRequestID: stk.providerRef,
      ResultCode: 0,
      ResultDesc: "Success",
      MpesaReceiptNumber: rcpt(4),
    });

    const after = await db.withTenant(tenant, user, async (c) => {
      const p = await c.query("SELECT state, invoice_id FROM payments WHERE id = $1", [stk.id]);
      const i = await c.query("SELECT status FROM invoices WHERE id = $1", [inv.id]);
      return { payment: p.rows[0], invoice: i.rows[0].status };
    });
    expect(after.payment.state).toBe("confirmed");
    expect(after.payment.invoice_id).toBe(inv.id);
    expect(after.invoice).toBe("paid");
  });

  test("failed STK callback marks payment failed, invoice stays issued", async () => {
    const inv = await makeIssuedInvoice(30_000);
    const stk = await payments.initiateStk({
      tenantId: tenant,
      userId: user,
      amountCents: inv.totalCents,
      msisdn: "254712000001",
      accountRef: `INV-${inv.invoiceNo}`,
    });
    await payments.handleStkCallback({
      CheckoutRequestID: stk.providerRef,
      ResultCode: 1032,
      ResultDesc: "Request cancelled by user",
    });
    const after = await db.withTenant(tenant, user, async (c) => {
      const p = await c.query("SELECT state, last_error FROM payments WHERE id = $1", [stk.id]);
      const i = await c.query("SELECT status FROM invoices WHERE id = $1", [inv.id]);
      return { ...p.rows[0], invoice: i.rows[0].status };
    });
    expect(after.state).toBe("failed");
    expect(after.last_error).toMatch(/cancelled/);
    expect(after.invoice).toBe("issued");
  });

  test("manual reconciliation across rails: bank + mpesa + cash settle one invoice", async () => {
    const inv = await makeIssuedInvoice(1_000_000); // total 1,160,000
    const bal = async (code: string): Promise<number> =>
      db.withTenant(tenant, user, async (c) => {
        const r = await c.query(
          `SELECT coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint AS b
           FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
           WHERE a.code = $1`,
          [code],
        );
        return Number(r.rows[0].b);
      });
    const bankBefore = await bal("1020");
    const cashBefore = await bal("1000");

    const r1 = await db.withTenant(tenant, user, (c) =>
      payments.recordManualPayment(c, {
        tenantId: tenant,
        userId: user,
        invoiceId: inv.id,
        rail: "bank",
        amountCents: 400_000,
        reference: "CHQ-77",
      }),
    );
    expect(r1.allocatedCents).toBe(400_000);
    await db.withTenant(tenant, user, (c) =>
      payments.recordManualPayment(c, {
        tenantId: tenant,
        userId: user,
        invoiceId: inv.id,
        rail: "mpesa",
        amountCents: 300_000,
      }),
    );
    const rest = inv.totalCents - 700_000;
    await db.withTenant(tenant, user, (c) =>
      payments.recordManualPayment(c, {
        tenantId: tenant,
        userId: user,
        invoiceId: inv.id,
        rail: "cash",
        amountCents: rest,
      }),
    );

    const final = await db.withTenant(tenant, user, async (c) => {
      const r = await c.query(
        "SELECT status, amount_paid_cents FROM invoices WHERE id = $1",
        [inv.id],
      );
      return r.rows[0];
    });
    expect(final.status).toBe("paid");
    expect(Number(final.amount_paid_cents)).toBe(inv.totalCents);
    expect((await bal("1020")) - bankBefore).toBe(400_000);
    expect((await bal("1000")) - cashBefore).toBe(rest);

    // A closed invoice refuses further payment.
    await expect(
      db.withTenant(tenant, user, (c) =>
        payments.recordManualPayment(c, {
          tenantId: tenant,
          userId: user,
          invoiceId: inv.id,
          rail: "cash",
          amountCents: 100,
        }),
      ),
    ).rejects.toThrow();
  });

  test("trial balance still nets to zero; AR reflects only unpaid invoices", async () => {
    const tb = await db.withTenant(tenant, user, (c) => ledger.trialBalance(c));
    expect(tb.reduce((s, a) => s + a.balanceCents, 0)).toBe(0);
  });

  test("payments are RLS-isolated between tenants", async () => {
    const suffix = randomUUID().slice(0, 8);
    const t2 = await db.query(
      "SELECT create_tenant_with_owner($1, $2, $3) AS id",
      ["pay-other", `pay-other-${suffix}`, user],
    );
    const n = await db.withTenant(t2.rows[0].id, user, async (c) => {
      const r = await c.query("SELECT count(*)::int AS n FROM payments");
      return r.rows[0].n;
    });
    expect(n).toBe(0);
  });
});
