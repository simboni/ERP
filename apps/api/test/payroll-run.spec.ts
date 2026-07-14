/**
 * Payroll run integration tests against jenga_test:
 *  - draft computes each employee via the rules store as-of the period
 *    (July 2026 = NSSF Year 4), matching the unit-tested calculator values,
 *  - commit posts a balanced DR wages / CR statutory / CR net entry,
 *  - recomputing drafts is allowed, committing twice is not,
 *  - maker-checker roles enforced at the controller layer (covered by RBAC
 *    tests elsewhere); here we verify service-level lifecycle + RLS.
 */
import { randomUUID } from "node:crypto";
import { DbService } from "../src/db/db.service";
import { AuditService } from "../src/audit/audit.service";
import { LedgerService, seedDefaultAccounts } from "../src/ledger/ledger.service";
import { RulesService } from "../src/rules/rules.service";
import { PayrollService } from "../src/payroll/payroll.service";

process.env.APP_DB_URL =
  process.env.APP_DB_URL_TEST ??
  "postgres://jenga_app:app_dev_pw@localhost:5432/jenga_test";

describe("payroll runs", () => {
  const db = new DbService();
  const ledger = new LedgerService();
  const audit = new AuditService();
  const payroll = new PayrollService(new RulesService(db), ledger, audit);

  let tenant: string;
  let user: string;

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    const u = await db.query(
      `INSERT INTO users (email, password_hash, full_name)
       VALUES ($1, 'x', 'Payroll Tester') RETURNING id`,
      [`payroll-${suffix}@test.local`],
    );
    user = u.rows[0].id;
    const t = await db.query(
      "SELECT create_tenant_with_owner($1, $2, $3) AS id",
      ["payroll-co", `payroll-co-${suffix}`, user],
    );
    tenant = t.rows[0].id;
    await db.withTenant(tenant, user, async (c) => {
      await seedDefaultAccounts(c, tenant);
      for (const [name, gross] of [
        ["Amina Odhiambo", 5_000_000], // 50,000.00
        ["Brian Kiptoo", 2_000_000],   // 20,000.00
      ] as const) {
        await c.query(
          `INSERT INTO employees (tenant_id, full_name, gross_cents)
           VALUES ($1, $2, $3)`,
          [tenant, name, gross],
        );
      }
    });
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  let runId: string;

  test("draft run computes verified July-2026 values per employee", async () => {
    const draft = await db.withTenant(tenant, user, (c) =>
      payroll.draftRun(c, { tenantId: tenant, userId: user, period: "2026-07" }),
    );
    runId = draft.runId;
    expect(draft.employeeCount).toBe(2);
    // From payroll-calc.spec: net 39,029.15 (50k) + 17,950.00 (20k)
    expect(draft.netCents).toBe(3_902_915 + 1_795_000);

    const items = await db.withTenant(tenant, user, async (c) => {
      const r = await c.query(
        `SELECT pi.gross_cents, pi.paye_cents, pi.nssf_emp_cents, pi.shif_cents,
                pi.ahl_emp_cents, pi.net_cents, e.full_name
         FROM payroll_items pi JOIN employees e ON e.id = pi.employee_id
         WHERE pi.run_id = $1 ORDER BY e.full_name`,
        [runId],
      );
      return r.rows;
    });
    const amina = items[0];
    expect(Number(amina.paye_cents)).toBe(584_585);
    expect(Number(amina.nssf_emp_cents)).toBe(300_000);
    expect(Number(amina.shif_cents)).toBe(137_500);
    expect(Number(amina.ahl_emp_cents)).toBe(75_000);
    const brian = items[1];
    expect(Number(brian.paye_cents)).toBe(0);
    expect(Number(brian.net_cents)).toBe(1_795_000);
  });

  test("re-drafting the same period recomputes instead of duplicating", async () => {
    const again = await db.withTenant(tenant, user, (c) =>
      payroll.draftRun(c, { tenantId: tenant, userId: user, period: "2026-07" }),
    );
    expect(again.runId).toBe(runId);
    const count = await db.withTenant(tenant, user, async (c) => {
      const r = await c.query(
        "SELECT count(*)::int AS n FROM payroll_runs WHERE period = '2026-07'",
      );
      return r.rows[0].n;
    });
    expect(count).toBe(1);
  });

  test("commit posts a balanced wages/statutory/net entry and freezes the run", async () => {
    const committed = await db.withTenant(tenant, user, (c) =>
      payroll.commit(c, { tenantId: tenant, userId: user, runId }),
    );
    const lines = await db.withTenant(tenant, user, async (c) => {
      const r = await c.query(
        `SELECT a.code, jl.debit_cents, jl.credit_cents
         FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
         WHERE jl.entry_id = $1 ORDER BY a.code`,
        [committed.journalEntryId],
      );
      return r.rows.map((x) => ({
        code: x.code,
        d: Number(x.debit_cents),
        c: Number(x.credit_cents),
      }));
    });
    // Gross 70,000; employer adds: NSSF 4,200 (3,000+1,200) + AHL 1,050 + NITA 100
    const employerCost = 7_000_000 + 420_000 + 105_000 + 10_000;
    // Statutory: PAYE 5,845.85 + NSSF emp 4,200 + NSSF er 4,200 + SHIF 1,925
    //          + AHL emp 1,050 + AHL er 1,050 + NITA 100
    const statutory =
      584_585 + 420_000 + 420_000 + 192_500 + 105_000 + 105_000 + 10_000;
    const net = 3_902_915 + 1_795_000;
    expect(lines).toEqual([
      { code: "2300", d: 0, c: statutory },
      { code: "2310", d: 0, c: net },
      { code: "6100", d: employerCost, c: 0 },
    ]);
    expect(employerCost).toBe(statutory + net); // balanced by construction

    await expect(
      db.withTenant(tenant, user, (c) =>
        payroll.commit(c, { tenantId: tenant, userId: user, runId }),
      ),
    ).rejects.toThrow(/Only draft/);
    await expect(
      db.withTenant(tenant, user, (c) =>
        payroll.draftRun(c, { tenantId: tenant, userId: user, period: "2026-07" }),
      ),
    ).rejects.toThrow(/already committed/);
  });

  test("January 2026 period resolves NSSF Year 3 (rules-as-of correctness)", async () => {
    const rules = await payroll.resolveRules("2026-01");
    expect(rules.nssf.uelCents).toBe(7_200_000);
    const feb = await payroll.resolveRules("2026-02");
    expect(feb.nssf.uelCents).toBe(10_800_000);
  });

  test("payroll data is RLS-isolated", async () => {
    const suffix = randomUUID().slice(0, 8);
    const t2 = await db.query(
      "SELECT create_tenant_with_owner($1, $2, $3) AS id",
      ["payroll-other", `payroll-other-${suffix}`, user],
    );
    await db.withTenant(t2.rows[0].id, user, async (c) => {
      for (const table of ["employees", "payroll_runs", "payroll_items"]) {
        const r = await c.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect({ table, n: r.rows[0].n }).toEqual({ table, n: 0 });
      }
    });
  });
});
