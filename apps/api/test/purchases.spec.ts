/**
 * Purchases tests: bill draft/approve posting (DR expense / DR input VAT /
 * CR AP), eTIMS deductibility surfacing in the VAT3 draft, idempotent
 * approval, RLS isolation, and books still net to zero.
 */
import { randomUUID } from "node:crypto";
import { DbService } from "../src/db/db.service";
import { AuditService } from "../src/audit/audit.service";
import { LedgerService, seedDefaultAccounts } from "../src/ledger/ledger.service";
import { BillsService } from "../src/purchases/bills.service";
import { SandboxPayoutProvider } from "../src/payments/payout.provider";
import { ComplianceService } from "../src/compliance/compliance.service";

process.env.APP_DB_URL =
  process.env.APP_DB_URL_TEST ??
  "postgres://jenga_app:app_dev_pw@localhost:5432/jenga_test";

describe("purchases + input VAT", () => {
  const db = new DbService();
  const ledger = new LedgerService();
  const audit = new AuditService();
  const bills = new BillsService(ledger, audit, new SandboxPayoutProvider(), db);
  const compliance = new ComplianceService();

  let tenant: string;
  let user: string;
  let supplier: string;

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    const u = await db.query(
      `INSERT INTO users (email, password_hash, full_name)
       VALUES ($1, 'x', 'Bills Tester') RETURNING id`,
      [`bills-${suffix}@test.local`],
    );
    user = u.rows[0].id;
    const t = await db.query(
      "SELECT create_tenant_with_owner($1, $2, $3) AS id",
      ["bills-co", `bills-co-${suffix}`, user],
    );
    tenant = t.rows[0].id;
    await db.withTenant(tenant, user, async (c) => {
      await seedDefaultAccounts(c, tenant);
      const s = await c.query(
        `INSERT INTO suppliers (tenant_id, name, kra_pin)
         VALUES ($1, 'Bidco Distributors', 'P051999888B') RETURNING id`,
        [tenant],
      );
      supplier = s.rows[0].id;
    });
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  test("approve posts DR expense/COGS + DR input VAT / CR AP", async () => {
    const draft = await db.withTenant(tenant, user, (c) =>
      bills.createDraft(c, {
        tenantId: tenant,
        userId: user,
        supplierId: supplier,
        billDate: "2026-06-10",
        supplierInvoiceNo: "BD-778",
        etimsControlNumber: "KRAMW009999999",
        lines: [
          { description: "Cooking oil stock", quantity: 10, unitPriceCents: 300_000, vatRate: "0.16", accountCode: "5000" },
          { description: "Delivery", quantity: 1, unitPriceCents: 50_000, vatRate: "0.16" },
        ],
      }),
    );
    // net 30,000 + 500 = 30,500; VAT 4,880; total 35,380
    expect(draft.totalCents).toBe(3_538_000);

    const approved = await db.withTenant(tenant, user, (c) =>
      bills.approve(c, { tenantId: tenant, userId: user, billId: draft.id }),
    );
    const lines = await db.withTenant(tenant, user, async (c) => {
      const r = await c.query(
        `SELECT a.code, jl.debit_cents, jl.credit_cents
         FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
         WHERE jl.entry_id = $1 ORDER BY a.code`,
        [approved.journalEntryId],
      );
      return r.rows.map((x) => ({ code: x.code, d: Number(x.debit_cents), c: Number(x.credit_cents) }));
    });
    expect(lines).toEqual([
      { code: "1300", d: 488_000, c: 0 },
      { code: "2100", d: 0, c: 3_538_000 },
      { code: "5000", d: 3_000_000, c: 0 },
      { code: "6000", d: 50_000, c: 0 },
    ]);

    await expect(
      db.withTenant(tenant, user, (c) =>
        bills.approve(c, { tenantId: tenant, userId: user, billId: draft.id }),
      ),
    ).rejects.toThrow(/Only draft/);
  });

  test("VAT3 draft includes input VAT and flags bills missing eTIMS", async () => {
    // A second approved bill WITHOUT an eTIMS control number.
    const noEtims = await db.withTenant(tenant, user, (c) =>
      bills.createDraft(c, {
        tenantId: tenant,
        userId: user,
        supplierId: supplier,
        billDate: "2026-06-15",
        lines: [
          { description: "Casual repairs", quantity: 1, unitPriceCents: 100_000, vatRate: "0.16" },
        ],
      }),
    );
    await db.withTenant(tenant, user, (c) =>
      bills.approve(c, { tenantId: tenant, userId: user, billId: noEtims.id }),
    );

    const draft = await db.withTenant(tenant, user, (c) =>
      compliance.vatReturnDraft(c, "2026-06"),
    );
    // Only the eTIMS-backed bill's VAT qualifies for the input claim.
    expect(draft.inputVatCents).toBe(488_000);
    expect(draft.billsMissingEtims).toBe(1);
    expect(draft.outputVatCents).toBe(0); // no sales for this tenant
    expect(draft.netVatCents).toBe(-488_000);
  });

  test("bill settlement: M-Pesa B2C payout clears AP and marks paid", async () => {
    const draft = await db.withTenant(tenant, user, (c) =>
      bills.createDraft(c, {
        tenantId: tenant,
        userId: user,
        supplierId: supplier,
        billDate: "2026-06-20",
        supplierInvoiceNo: "BD-800",
        etimsControlNumber: "KRAMW008888888",
        lines: [
          { description: "Restock", quantity: 1, unitPriceCents: 500_000, vatRate: "0" },
        ],
      }),
    );
    // Cannot pay a draft.
    await expect(
      bills.pay({ tenantId: tenant, userId: user, billId: draft.id, method: "cash" }),
    ).rejects.toThrow(/Only approved/);

    await db.withTenant(tenant, user, (c) =>
      bills.approve(c, { tenantId: tenant, userId: user, billId: draft.id }),
    );
    const paid = await bills.pay({
      tenantId: tenant,
      userId: user,
      billId: draft.id,
      method: "mpesa_b2c",
      msisdn: "254722334455",
    });
    expect(paid.providerRef).toMatch(/^AG_SBX_/);

    const state = await db.withTenant(tenant, user, async (c) => {
      const b = await c.query("SELECT status FROM bills WHERE id = $1", [draft.id]);
      const lines = await c.query(
        `SELECT a.code, jl.debit_cents, jl.credit_cents
         FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
         WHERE jl.entry_id = $1 ORDER BY a.code`,
        [paid.journalEntryId],
      );
      return { status: b.rows[0].status, lines: lines.rows };
    });
    expect(state.status).toBe("paid");
    expect(
      state.lines.map((l) => ({ code: l.code, d: Number(l.debit_cents), c: Number(l.credit_cents) })),
    ).toEqual([
      { code: "1010", d: 0, c: 500_000 },
      { code: "2100", d: 500_000, c: 0 },
    ]);

    // Cannot pay twice.
    await expect(
      bills.pay({ tenantId: tenant, userId: user, billId: draft.id, method: "cash" }),
    ).rejects.toThrow(/Only approved/);
  });

  test("books still net to zero and bills are RLS-isolated", async () => {
    const tb = await db.withTenant(tenant, user, (c) => ledger.trialBalance(c));
    expect(tb.reduce((s, a) => s + a.balanceCents, 0)).toBe(0);

    const suffix = randomUUID().slice(0, 8);
    const t2 = await db.query(
      "SELECT create_tenant_with_owner($1, $2, $3) AS id",
      ["bills-other", `bills-other-${suffix}`, user],
    );
    await db.withTenant(t2.rows[0].id, user, async (c) => {
      for (const table of ["suppliers", "bills", "bill_lines"]) {
        const r = await c.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect({ table, n: r.rows[0].n }).toEqual({ table, n: 0 });
      }
    });
  });
});
