/**
 * Compliance surface tests: VAT3 draft figures from real invoices in a
 * period (rate breakdown, output VAT, fiscalization coverage) and the
 * statutory deadline feed math (9th, 20th, 9-working-days rules).
 */
import { randomUUID } from "node:crypto";
import { DbService } from "../src/db/db.service";
import { AuditService } from "../src/audit/audit.service";
import { FiscalService } from "../src/fiscal/fiscal.service";
import { SandboxFiscalProvider } from "../src/fiscal/provider";
import { LedgerService, seedDefaultAccounts } from "../src/ledger/ledger.service";
import { InvoicesService } from "../src/invoicing/invoices.service";
import { ComplianceService } from "../src/compliance/compliance.service";

process.env.APP_DB_URL =
  process.env.APP_DB_URL_TEST ??
  "postgres://jenga_app:app_dev_pw@localhost:5432/jenga_test";
process.env.WORKER_DB_URL =
  process.env.WORKER_DB_URL_TEST ??
  "postgres://jenga_worker:worker_dev_pw@localhost:5432/jenga_test";

describe("compliance surface", () => {
  const db = new DbService();
  const ledger = new LedgerService();
  const audit = new AuditService();
  const fiscal = new FiscalService(new SandboxFiscalProvider());
  const invoices = new InvoicesService(ledger, fiscal, audit);
  const compliance = new ComplianceService();

  let tenant: string;
  let user: string;
  let branch: string;
  let customer: string;

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    const u = await db.query(
      `INSERT INTO users (email, password_hash, full_name)
       VALUES ($1, 'x', 'VAT Tester') RETURNING id`,
      [`vat-${suffix}@test.local`],
    );
    user = u.rows[0].id;
    const t = await db.query(
      "SELECT create_tenant_with_owner($1, $2, $3) AS id",
      ["vat-co", `vat-co-${suffix}`, user],
    );
    tenant = t.rows[0].id;
    await db.withTenant(tenant, user, async (c) => {
      await seedDefaultAccounts(c, tenant);
      const b = await c.query(
        `INSERT INTO branches (tenant_id, code, name) VALUES ($1, 'HQ', 'HQ') RETURNING id`,
        [tenant],
      );
      branch = b.rows[0].id;
      const cu = await c.query(
        `INSERT INTO customers (tenant_id, name) VALUES ($1, 'VAT Customer') RETURNING id`,
        [tenant],
      );
      customer = cu.rows[0].id;
    });

    // Mixed-rate invoice issued in June 2026 + one in July (outside period).
    const mk = async (issueDate: string, unitPriceCents: number, vatRate: "0.16" | "0" | "exempt") => {
      const d = await db.withTenant(tenant, user, (c) =>
        invoices.createDraft(c, {
          tenantId: tenant, userId: user, branchId: branch, customerId: customer,
          lines: [{ description: "x", quantity: 1, unitPriceCents, vatRate }],
        }),
      );
      await db.withTenant(tenant, user, (c) =>
        invoices.issue(c, { tenantId: tenant, userId: user, invoiceId: d.id, issueDate }),
      );
    };
    await mk("2026-06-05", 1_000_000, "0.16"); // 10,000 + 1,600 VAT
    await mk("2026-06-20", 500_000, "0");      // 5,000 zero-rated
    await mk("2026-06-25", 200_000, "exempt"); // 2,000 exempt
    await mk("2026-07-02", 999_900, "0.16");   // July — excluded from June return
  });

  afterAll(async () => {
    await fiscal.onModuleDestroy();
    await db.onModuleDestroy();
  });

  test("VAT3 draft: rate breakdown, output VAT, fiscalization coverage", async () => {
    const draft = await db.withTenant(tenant, user, (c) =>
      compliance.vatReturnDraft(c, "2026-06"),
    );
    expect(draft.salesVatable16Cents).toBe(1_000_000);
    expect(draft.salesZeroRatedCents).toBe(500_000);
    expect(draft.salesExemptCents).toBe(200_000);
    expect(draft.outputVatCents).toBe(160_000);
    expect(draft.inputVatCents).toBe(0); // no purchases recorded here
    expect(draft.netVatCents).toBe(160_000);
    expect(draft.billsMissingEtims).toBe(0);
    expect(draft.invoicesTotal).toBe(3);
    // Worker hasn't run in this suite; none signed yet.
    expect(draft.invoicesFiscalized).toBe(0);

    await expect(
      db.withTenant(tenant, user, (c) => compliance.vatReturnDraft(c, "junk")),
    ).rejects.toThrow(/YYYY-MM/);
  });

  test("deadline feed: 9th, 20th and 9-working-day rules", () => {
    // asOf mid-July 2026 -> filings for period 2026-07 due in August.
    const asOf = new Date(Date.UTC(2026, 6, 14));
    const deadlines = compliance.deadlines(asOf);
    const byKey = Object.fromEntries(deadlines.map((d) => [d.key, d]));

    expect(byKey.paye.dueDate).toBe("2026-08-09");
    expect(byKey.nssf.dueDate).toBe("2026-08-09");
    expect(byKey.shif.dueDate).toBe("2026-08-09");
    expect(byKey.vat3.dueDate).toBe("2026-08-20");
    // 9 working days after Fri 31 Jul 2026: Mon 3 Aug is day 1 (1-2 Aug is
    // the weekend), so day 9 lands Thu 13 Aug 2026.
    expect(byKey.ahl_remit.dueDate).toBe("2026-08-13");
    expect(byKey.paye.daysRemaining).toBe(26);
    expect(deadlines.every((d) => !d.overdue)).toBe(true);
    // Sorted soonest-first.
    expect(deadlines[0].dueDate <= deadlines[deadlines.length - 1].dueDate).toBe(true);
  });
});
