/**
 * Finance+ tests against jenga_test:
 *  - budget CRUD (upsert replaces, delete removes) and budget-vs-actual
 *    variance math off the journal,
 *  - straight-line depreciation posts once per asset per period (DR 6200 /
 *    CR 1500), is idempotent on re-run, respects the schedule window and
 *    the disposed flag, and the remainder month closes to cost - salvage,
 *  - recurring run drafts an invoice from the template lines and advances
 *    next_run_date one month; a second run in the same period drafts nothing.
 */
import { randomUUID } from "node:crypto";
import { DbService } from "../src/db/db.service";
import { AuditService } from "../src/audit/audit.service";
import { FiscalService } from "../src/fiscal/fiscal.service";
import { SandboxFiscalProvider } from "../src/fiscal/provider";
import {
  LedgerService,
  seedDefaultAccounts,
} from "../src/ledger/ledger.service";
import { InvoicesService } from "../src/invoicing/invoices.service";
import { addOneMonth, FinanceService } from "../src/finance/finance.service";

process.env.APP_DB_URL =
  process.env.APP_DB_URL_TEST ??
  "postgres://jenga_app:app_dev_pw@localhost:5432/jenga_test";
process.env.WORKER_DB_URL =
  process.env.WORKER_DB_URL_TEST ??
  "postgres://jenga_worker:worker_dev_pw@localhost:5432/jenga_test";

describe("finance+ (budgets, fixed assets, recurring invoices)", () => {
  const db = new DbService();
  const ledger = new LedgerService();
  const audit = new AuditService();
  const fiscal = new FiscalService(new SandboxFiscalProvider());
  const invoices = new InvoicesService(ledger, fiscal, audit);
  const finance = new FinanceService(ledger, invoices, audit);

  const year = new Date().getUTCFullYear();
  let tenant: string;
  let user: string;
  let branch: string;
  let customer: string;

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    const u = await db.query(
      `INSERT INTO users (email, password_hash, full_name)
       VALUES ($1, 'x', 'Finance Tester') RETURNING id`,
      [`finance-${suffix}@test.local`],
    );
    user = u.rows[0].id;
    const t = await db.query(
      "SELECT create_tenant_with_owner($1, $2, $3) AS id",
      ["finance-co", `finance-co-${suffix}`, user],
    );
    tenant = t.rows[0].id;
    await db.withTenant(tenant, user, async (c) => {
      await seedDefaultAccounts(c, tenant);
      branch = (
        await c.query(
          `INSERT INTO branches (tenant_id, code, name)
           VALUES ($1, 'HQ', 'Head Office') RETURNING id`,
          [tenant],
        )
      ).rows[0].id;
      customer = (
        await c.query(
          `INSERT INTO customers (tenant_id, name)
           VALUES ($1, 'Retainer Client Ltd') RETURNING id`,
          [tenant],
        )
      ).rows[0].id;
    });
  });

  afterAll(async () => {
    await fiscal.onModuleDestroy();
    await db.onModuleDestroy();
  });

  it("seeds the depreciation accounts (1500, 6200) by default", async () => {
    await db.withTenant(tenant, user, async (c) => {
      const res = await c.query(
        "SELECT code, type FROM accounts WHERE code IN ('1500','6200') ORDER BY code",
      );
      expect(res.rows).toEqual([
        expect.objectContaining({ code: "1500", type: "asset" }),
        expect.objectContaining({ code: "6200", type: "expense" }),
      ]);
    });
  });

  it("budget CRUD: upsert replaces, list scopes by year, delete removes", async () => {
    const first = await db.withTenant(tenant, user, (c) =>
      finance.upsertBudgets(c, {
        tenantId: tenant,
        userId: user,
        entries: [
          { accountCode: "4000", fiscalYear: year, month: 1, amountCents: 100_000_00 },
          { accountCode: "6000", fiscalYear: year, month: 0, amountCents: 240_000_00 },
        ],
      }),
    );
    expect(first.upserted).toBe(2);

    // Same key upserts in place — no duplicate row, amount replaced.
    await db.withTenant(tenant, user, (c) =>
      finance.upsertBudgets(c, {
        tenantId: tenant,
        userId: user,
        entries: [
          { accountCode: "4000", fiscalYear: year, month: 1, amountCents: 150_000_00 },
        ],
      }),
    );
    const rows = await db.withTenant(tenant, user, (c) =>
      finance.listBudgets(c, year),
    );
    expect(rows).toHaveLength(2);
    const sales = rows.find(
      (r: { account_code: string }) => r.account_code === "4000",
    );
    expect(Number(sales.amount_cents)).toBe(150_000_00);

    // Unknown / non-P&L codes are rejected.
    await expect(
      db.withTenant(tenant, user, (c) =>
        finance.upsertBudgets(c, {
          tenantId: tenant,
          userId: user,
          entries: [
            { accountCode: "1000", fiscalYear: year, month: 2, amountCents: 1 },
          ],
        }),
      ),
    ).rejects.toThrow(/non-P&L/);

    // Delete removes a row.
    const opex = rows.find(
      (r: { account_code: string }) => r.account_code === "6000",
    );
    await db.withTenant(tenant, user, (c) =>
      finance.deleteBudget(c, { tenantId: tenant, userId: user, budgetId: opex.id }),
    );
    const after = await db.withTenant(tenant, user, (c) =>
      finance.listBudgets(c, year),
    );
    expect(after).toHaveLength(1);
  });

  it("budget-vs-actual joins ledger actuals with correct variance math", async () => {
    // Budget: sales 4000 = 150 000 KES (set above). Actual: one issued
    // invoice, subtotal 30 000 KES + 16% VAT (VAT is not income).
    const draft = await db.withTenant(tenant, user, (c) =>
      invoices.createDraft(c, {
        tenantId: tenant,
        userId: user,
        branchId: branch,
        customerId: customer,
        lines: [
          {
            description: "Consulting",
            quantity: 1,
            unitPriceCents: 30_000_00,
            vatRate: "0.16",
          },
        ],
      }),
    );
    await db.withTenant(tenant, user, (c) =>
      invoices.issue(c, {
        tenantId: tenant,
        userId: user,
        invoiceId: draft.id,
        issueDate: `${year}-06-15`,
      }),
    );
    // Drain the fiscal queue so this spec leaves no pending backlog for
    // the (bounded) worker drains in later suites.
    for (let i = 0; i < 50 && (await fiscal.processOnce()); i++) {
      /* keep signing */
    }

    const report = await db.withTenant(tenant, user, (c) =>
      finance.budgetVsActual(c, year),
    );
    const sales = report.rows.find(
      (r: { code: string }) => r.code === "4000",
    );
    expect(Number(sales.budget_cents)).toBe(150_000_00);
    expect(Number(sales.actual_cents)).toBe(30_000_00);
    expect(Number(sales.variance_cents)).toBe(-120_000_00);
    expect(report.totals.budgetIncomeCents).toBe(150_000_00);
    expect(report.totals.actualIncomeCents).toBe(30_000_00);

    // A budget-only account still appears with zero actuals.
    await db.withTenant(tenant, user, (c) =>
      finance.upsertBudgets(c, {
        tenantId: tenant,
        userId: user,
        entries: [
          { accountCode: "6100", fiscalYear: year, month: 0, amountCents: 50_000_00 },
        ],
      }),
    );
    const report2 = await db.withTenant(tenant, user, (c) =>
      finance.budgetVsActual(c, year),
    );
    const wages = report2.rows.find(
      (r: { code: string }) => r.code === "6100",
    );
    expect(Number(wages.budget_cents)).toBe(50_000_00);
    expect(Number(wages.actual_cents)).toBe(0);
    expect(Number(wages.variance_cents)).toBe(-50_000_00);
  });

  it("depreciation posts once per period and is idempotent on re-run", async () => {
    // cost 90 000 00, salvage 9 000 00, life 7 → base 81 000 00,
    // monthly floor = 1 157 142, final month = 1 157 148.
    const asset = await db.withTenant(tenant, user, (c) =>
      finance.createAsset(c, {
        tenantId: tenant,
        userId: user,
        name: "Delivery van",
        costCents: 90_000_00,
        salvageCents: 9_000_00,
        acquiredDate: `${year}-01-10`,
        usefulLifeMonths: 7,
      }),
    );

    const run1 = await db.withTenant(tenant, user, (c) =>
      finance.runDepreciation(c, {
        tenantId: tenant,
        userId: user,
        period: `${year}-01`,
      }),
    );
    expect(run1.posted).toBe(1);
    expect(run1.totalCents).toBe(1_157_142);

    // Idempotent: same period again posts nothing, entry count unchanged.
    const countBefore = await db.withTenant(tenant, user, async (c) =>
      Number(
        (
          await c.query(
            "SELECT count(*) AS n FROM journal_entries WHERE source_type = 'depreciation'",
          )
        ).rows[0].n,
      ),
    );
    const run2 = await db.withTenant(tenant, user, (c) =>
      finance.runDepreciation(c, {
        tenantId: tenant,
        userId: user,
        period: `${year}-01`,
      }),
    );
    expect(run2.posted).toBe(0);
    expect(run2.skipped).toBeGreaterThanOrEqual(1);
    const countAfter = await db.withTenant(tenant, user, async (c) =>
      Number(
        (
          await c.query(
            "SELECT count(*) AS n FROM journal_entries WHERE source_type = 'depreciation'",
          )
        ).rows[0].n,
      ),
    );
    expect(countAfter).toBe(countBefore);

    // The entry uses the agreed key and accounts: DR 6200 / CR 1500.
    await db.withTenant(tenant, user, async (c) => {
      const entry = await c.query(
        `SELECT je.id FROM journal_entries je
         WHERE je.idempotency_key = $1`,
        [`asset:${asset.id}:dep:${year}-01`],
      );
      expect(entry.rows).toHaveLength(1);
      const lines = await c.query(
        `SELECT a.code, jl.debit_cents::bigint AS d, jl.credit_cents::bigint AS cr
         FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
         WHERE jl.entry_id = $1 ORDER BY a.code`,
        [entry.rows[0].id],
      );
      expect(lines.rows).toEqual([
        expect.objectContaining({ code: "1500", d: "0", cr: "1157142" }),
        expect.objectContaining({ code: "6200", d: "1157142", cr: "0" }),
      ]);
    });

    // Months 2..7: remainder month closes the schedule to base exactly.
    let total = run1.totalCents;
    for (let m = 2; m <= 7; m++) {
      const r = await db.withTenant(tenant, user, (c) =>
        finance.runDepreciation(c, {
          tenantId: tenant,
          userId: user,
          period: `${year}-0${m}`,
        }),
      );
      expect(r.posted).toBe(1);
      total += r.totalCents;
    }
    expect(total).toBe(81_000_00);

    // Outside the schedule window: month life+1 posts nothing.
    const beyond = await db.withTenant(tenant, user, (c) =>
      finance.runDepreciation(c, {
        tenantId: tenant,
        userId: user,
        period: `${year}-08`,
      }),
    );
    expect(beyond.posted).toBe(0);

    // Disposed assets are skipped entirely.
    await db.withTenant(tenant, user, (c) =>
      finance.updateAsset(c, {
        tenantId: tenant,
        userId: user,
        assetId: asset.id,
        disposed: true,
      }),
    );
    const disposedRun = await db.withTenant(tenant, user, (c) =>
      finance.runDepreciation(c, {
        tenantId: tenant,
        userId: user,
        period: `${year}-05`,
      }),
    );
    expect(disposedRun.posted).toBe(0);
    expect(disposedRun.skipped).toBe(0); // not even considered

    // Register shows accumulated + NBV off the journal.
    const register = await db.withTenant(tenant, user, (c) =>
      finance.listAssets(c),
    );
    const van = register.find((r: { id: string }) => r.id === asset.id);
    expect(Number(van.accumulated_cents)).toBe(81_000_00);
    expect(Number(van.nbv_cents)).toBe(9_000_00);
    expect(van.disposed).toBe(true);

    // Assets with posted depreciation cannot be deleted.
    await expect(
      db.withTenant(tenant, user, (c) =>
        finance.deleteAsset(c, {
          tenantId: tenant,
          userId: user,
          assetId: asset.id,
        }),
      ),
    ).rejects.toThrow(/disposed instead/);
  });

  it("recurring run drafts an invoice and advances next_run_date one month", async () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    const template = await db.withTenant(tenant, user, (c) =>
      finance.createTemplate(c, {
        tenantId: tenant,
        userId: user,
        customerId: customer,
        branchId: branch,
        nextRunDate: yesterday,
        lines: [
          {
            description: "Monthly retainer",
            quantity: 1,
            unitPriceCents: 85_000_00,
            vatRate: "0.16",
          },
          {
            description: "Storage fee",
            quantity: 2,
            unitPriceCents: 6_250_00,
            vatRate: "exempt",
          },
        ],
      }),
    );
    expect(template.active).toBe(true);

    const invoicesBefore = await db.withTenant(tenant, user, async (c) =>
      Number((await c.query("SELECT count(*) AS n FROM invoices")).rows[0].n),
    );
    const run1 = await db.withTenant(tenant, user, (c) =>
      finance.runRecurring(c, { tenantId: tenant, userId: user }),
    );
    expect(run1.drafted).toBe(1);

    await db.withTenant(tenant, user, async (c) => {
      const n = Number(
        (await c.query("SELECT count(*) AS n FROM invoices")).rows[0].n,
      );
      expect(n).toBe(invoicesBefore + 1);
      const inv = await c.query(
        `SELECT status, due_date, subtotal_cents::bigint AS subtotal,
                vat_cents::bigint AS vat, total_cents::bigint AS total
         FROM invoices ORDER BY created_at DESC LIMIT 1`,
      );
      expect(inv.rows[0].status).toBe("draft");
      const due =
        inv.rows[0].due_date instanceof Date
          ? inv.rows[0].due_date.toISOString().slice(0, 10)
          : String(inv.rows[0].due_date).slice(0, 10);
      expect(due).toBe(yesterday);
      // 85 000 + 2×6 250 = 97 500 net; VAT 16% on the retainer only.
      expect(Number(inv.rows[0].subtotal)).toBe(97_500_00);
      expect(Number(inv.rows[0].vat)).toBe(13_600_00);
      expect(Number(inv.rows[0].total)).toBe(111_100_00);

      const t = await c.query(
        "SELECT next_run_date, active FROM recurring_invoice_templates WHERE id = $1",
        [template.id],
      );
      const next =
        t.rows[0].next_run_date instanceof Date
          ? t.rows[0].next_run_date.toISOString().slice(0, 10)
          : String(t.rows[0].next_run_date).slice(0, 10);
      expect(next).toBe(addOneMonth(yesterday));
    });

    // Idempotent per period: nothing else is due, so a second run drafts 0.
    const run2 = await db.withTenant(tenant, user, (c) =>
      finance.runRecurring(c, { tenantId: tenant, userId: user }),
    );
    expect(run2.drafted).toBe(0);

    // Paused templates never run, even when due.
    await db.withTenant(tenant, user, (c) =>
      finance.updateTemplate(c, {
        tenantId: tenant,
        userId: user,
        templateId: template.id,
        active: false,
        nextRunDate: yesterday,
      }),
    );
    const run3 = await db.withTenant(tenant, user, (c) =>
      finance.runRecurring(c, { tenantId: tenant, userId: user }),
    );
    expect(run3.drafted).toBe(0);
  });
});
