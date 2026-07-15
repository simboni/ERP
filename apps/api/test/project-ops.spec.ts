/**
 * Project Operations tests against jenga_test:
 *  - project CRUD (PATCH merges fields) and the delete guard (no delete
 *    once time or expenses are logged),
 *  - time entry / expense CRUD with validation, and the billed-lock (no
 *    edit/delete once billed_invoice_id is set),
 *  - profitability math: billed (invoice subtotal), unbilled (billable
 *    unbilled hours x rate + billable unbilled expenses), cost (all hours
 *    x rate + all expenses), margin and budget consumption,
 *  - bill endpoint: one DRAFT invoice per run, one line per time entry /
 *    expense with correct totals + 16% VAT, billed_invoice_id stamped in
 *    the same transaction, and a second run with nothing to bill rejects.
 * Billing only drafts (no issue), so the fiscal queue stays empty.
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
import { ProjectsService } from "../src/projects/projects.service";

process.env.APP_DB_URL =
  process.env.APP_DB_URL_TEST ??
  "postgres://jenga_app:app_dev_pw@localhost:5432/jenga_test";
process.env.WORKER_DB_URL =
  process.env.WORKER_DB_URL_TEST ??
  "postgres://jenga_worker:worker_dev_pw@localhost:5432/jenga_test";

describe("project ops (projects, time, expenses, billing)", () => {
  const db = new DbService();
  const ledger = new LedgerService();
  const audit = new AuditService();
  const fiscal = new FiscalService(new SandboxFiscalProvider());
  const invoices = new InvoicesService(ledger, fiscal, audit);
  const projects = new ProjectsService(invoices, audit);

  let tenant: string;
  let user: string;
  let branch: string;
  let customer: string;
  let employee: string;

  const ctx = () => ({ tenantId: tenant, userId: user });

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    const u = await db.query(
      `INSERT INTO users (email, password_hash, full_name)
       VALUES ($1, 'x', 'Project Tester') RETURNING id`,
      [`projects-${suffix}@test.local`],
    );
    user = u.rows[0].id;
    const t = await db.query(
      "SELECT create_tenant_with_owner($1, $2, $3) AS id",
      ["project-co", `project-co-${suffix}`, user],
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
           VALUES ($1, 'Fit-out Client Ltd') RETURNING id`,
          [tenant],
        )
      ).rows[0].id;
      employee = (
        await c.query(
          `INSERT INTO employees (tenant_id, full_name, gross_cents)
           VALUES ($1, 'Wanjiku Site Lead', 8000000) RETURNING id`,
          [tenant],
        )
      ).rows[0].id;
    });
  });

  afterAll(async () => {
    await fiscal.onModuleDestroy();
    await db.onModuleDestroy();
  });

  it("project CRUD: create, patch, list rollups; delete only before work is logged", async () => {
    const proj = await db.withTenant(tenant, user, (c) =>
      projects.createProject(c, {
        ...ctx(),
        name: "Office fit-out",
        customerId: customer,
        budgetCents: 500_000_00,
        hourlyRateCents: 2_500_00,
      }),
    );
    expect(proj.status).toBe("active");
    expect(Number(proj.budget_cents)).toBe(500_000_00);

    // Validation: empty name, negative money, unknown customer.
    await expect(
      db.withTenant(tenant, user, (c) =>
        projects.createProject(c, { ...ctx(), name: "  " }),
      ),
    ).rejects.toThrow(/name/);
    await expect(
      db.withTenant(tenant, user, (c) =>
        projects.createProject(c, { ...ctx(), name: "x", budgetCents: -5 }),
      ),
    ).rejects.toThrow(/budgetCents/);
    await expect(
      db.withTenant(tenant, user, (c) =>
        projects.createProject(c, {
          ...ctx(),
          name: "x",
          customerId: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/customerId/);

    // PATCH merges: only the provided fields change.
    const patched = await db.withTenant(tenant, user, (c) =>
      projects.updateProject(c, {
        ...ctx(),
        projectId: proj.id,
        status: "completed",
        hourlyRateCents: 3_000_00,
      }),
    );
    expect(patched.status).toBe("completed");
    expect(Number(patched.hourly_rate_cents)).toBe(3_000_00);
    expect(patched.name).toBe("Office fit-out");
    expect(Number(patched.budget_cents)).toBe(500_000_00);
    await expect(
      db.withTenant(tenant, user, (c) =>
        projects.updateProject(c, {
          ...ctx(),
          projectId: proj.id,
          status: "haunted",
        }),
      ),
    ).rejects.toThrow(/status/);
    await db.withTenant(tenant, user, (c) =>
      projects.updateProject(c, { ...ctx(), projectId: proj.id, status: "active" }),
    );

    // List carries the rollups (zero before any work is logged).
    const list = await db.withTenant(tenant, user, (c) =>
      projects.listProjects(c),
    );
    const row = list.find((r: { id: string }) => r.id === proj.id);
    expect(row.customer_name).toBe("Fit-out Client Ltd");
    expect(Number(row.hours)).toBe(0);
    expect(Number(row.unbilled_cents)).toBe(0);

    // A project with no work deletes cleanly.
    const scratch = await db.withTenant(tenant, user, (c) =>
      projects.createProject(c, { ...ctx(), name: "Scratch" }),
    );
    await db.withTenant(tenant, user, (c) =>
      projects.deleteProject(c, { ...ctx(), projectId: scratch.id }),
    );
    await expect(
      db.withTenant(tenant, user, (c) => projects.getProject(c, scratch.id)),
    ).rejects.toThrow(/not found/);

    // Once time is logged, delete is guarded.
    await db.withTenant(tenant, user, (c) =>
      projects.addTime(c, {
        ...ctx(),
        projectId: proj.id,
        entryDate: "2026-07-01",
        hours: 2,
        note: "Site survey",
        employeeId: employee,
      }),
    );
    await expect(
      db.withTenant(tenant, user, (c) =>
        projects.deleteProject(c, { ...ctx(), projectId: proj.id }),
      ),
    ).rejects.toThrow(/archive/);
  });

  it("time entry CRUD validates hours/date and edits until billed", async () => {
    const proj = await db.withTenant(tenant, user, (c) =>
      projects.createProject(c, { ...ctx(), name: "Time CRUD" }),
    );
    for (const bad of [0, -1, 25, 1.234]) {
      await expect(
        db.withTenant(tenant, user, (c) =>
          projects.addTime(c, {
            ...ctx(),
            projectId: proj.id,
            entryDate: "2026-07-02",
            hours: bad,
          }),
        ),
      ).rejects.toThrow(/hours/);
    }
    await expect(
      db.withTenant(tenant, user, (c) =>
        projects.addTime(c, {
          ...ctx(),
          projectId: proj.id,
          entryDate: "02/07/2026",
          hours: 1,
        }),
      ),
    ).rejects.toThrow(/YYYY-MM-DD/);

    const entry = await db.withTenant(tenant, user, (c) =>
      projects.addTime(c, {
        ...ctx(),
        projectId: proj.id,
        entryDate: "2026-07-02",
        hours: 1.5,
        note: "Design review",
        employeeId: employee,
      }),
    );
    expect(entry.billable).toBe(true);

    const updated = await db.withTenant(tenant, user, (c) =>
      projects.updateTime(c, {
        ...ctx(),
        projectId: proj.id,
        entryId: entry.id,
        hours: 2.25,
        billable: false,
      }),
    );
    expect(Number(updated.hours)).toBe(2.25);
    expect(updated.billable).toBe(false);
    expect(updated.note).toBe("Design review"); // untouched fields survive

    await db.withTenant(tenant, user, (c) =>
      projects.deleteTime(c, { ...ctx(), projectId: proj.id, entryId: entry.id }),
    );
    const remaining = await db.withTenant(tenant, user, (c) =>
      projects.listTime(c, proj.id),
    );
    expect(remaining).toHaveLength(0);
  });

  it("expense CRUD validates amounts and edits until billed", async () => {
    const proj = await db.withTenant(tenant, user, (c) =>
      projects.createProject(c, { ...ctx(), name: "Expense CRUD" }),
    );
    await expect(
      db.withTenant(tenant, user, (c) =>
        projects.addExpense(c, {
          ...ctx(),
          projectId: proj.id,
          expenseDate: "2026-07-03",
          description: "Transport",
          amountCents: 0,
        }),
      ),
    ).rejects.toThrow(/amountCents/);
    await expect(
      db.withTenant(tenant, user, (c) =>
        projects.addExpense(c, {
          ...ctx(),
          projectId: proj.id,
          expenseDate: "2026-07-03",
          description: "  ",
          amountCents: 100,
        }),
      ),
    ).rejects.toThrow(/description/);

    const exp = await db.withTenant(tenant, user, (c) =>
      projects.addExpense(c, {
        ...ctx(),
        projectId: proj.id,
        expenseDate: "2026-07-03",
        description: "Transport",
        amountCents: 25_000_00,
      }),
    );
    const updated = await db.withTenant(tenant, user, (c) =>
      projects.updateExpense(c, {
        ...ctx(),
        projectId: proj.id,
        expenseId: exp.id,
        amountCents: 30_000_00,
      }),
    );
    expect(Number(updated.amount_cents)).toBe(30_000_00);
    expect(updated.description).toBe("Transport");

    await db.withTenant(tenant, user, (c) =>
      projects.deleteExpense(c, {
        ...ctx(),
        projectId: proj.id,
        expenseId: exp.id,
      }),
    );
    const remaining = await db.withTenant(tenant, user, (c) =>
      projects.listExpenses(c, proj.id),
    );
    expect(remaining).toHaveLength(0);
  });

  it("bill creates one draft invoice with a line per entry/expense and stamps billed_invoice_id", async () => {
    const proj = await db.withTenant(tenant, user, (c) =>
      projects.createProject(c, {
        ...ctx(),
        name: "Billable works",
        customerId: customer,
        hourlyRateCents: 2_500_00,
      }),
    );
    await db.withTenant(tenant, user, async (c) => {
      await projects.addTime(c, {
        ...ctx(),
        projectId: proj.id,
        entryDate: "2026-07-01",
        hours: 2,
        note: "Site survey",
        employeeId: employee,
      });
      await projects.addTime(c, {
        ...ctx(),
        projectId: proj.id,
        entryDate: "2026-07-02",
        hours: 1.5,
        note: "",
      });
      await projects.addTime(c, {
        ...ctx(),
        projectId: proj.id,
        entryDate: "2026-07-03",
        hours: 3,
        note: "Internal QA",
        billable: false,
      });
      await projects.addExpense(c, {
        ...ctx(),
        projectId: proj.id,
        expenseDate: "2026-07-04",
        description: "Materials delivery",
        amountCents: 25_000_00,
      });
      await projects.addExpense(c, {
        ...ctx(),
        projectId: proj.id,
        expenseDate: "2026-07-05",
        description: "Team lunch",
        amountCents: 5_000_00,
        billable: false,
      });
    });

    const res = await db.withTenant(tenant, user, (c) =>
      projects.billUnbilled(c, {
        ...ctx(),
        projectId: proj.id,
        branchId: branch,
      }),
    );
    expect(res.timeEntries).toBe(2);
    expect(res.expenses).toBe(1);
    // 2h + 1.5h @ 2 500 KES/h = 500 000 + 375 000; expense 2 500 000.
    expect(res.subtotalCents).toBe(500_000 + 375_000 + 2_500_000);

    await db.withTenant(tenant, user, async (c) => {
      const inv = await c.query(
        `SELECT status, subtotal_cents::bigint AS subtotal,
                vat_cents::bigint AS vat, total_cents::bigint AS total,
                customer_id
         FROM invoices WHERE id = $1`,
        [res.invoiceId],
      );
      expect(inv.rows[0].status).toBe("draft");
      expect(inv.rows[0].customer_id).toBe(customer);
      expect(Number(inv.rows[0].subtotal)).toBe(3_375_000);
      expect(Number(inv.rows[0].vat)).toBe(540_000); // 16% on every line
      expect(Number(inv.rows[0].total)).toBe(3_915_000);

      const lines = await c.query(
        `SELECT description, quantity::numeric AS quantity,
                unit_price_cents::bigint AS unit_price,
                line_total_cents::bigint AS line_total, vat_rate
         FROM invoice_lines WHERE invoice_id = $1 ORDER BY description`,
        [res.invoiceId],
      );
      expect(lines.rows).toHaveLength(3);
      const survey = lines.rows.find((l: { description: string }) =>
        l.description.includes("Site survey"),
      );
      expect(survey.description).toBe("2026-07-01 — Site survey (2h)");
      expect(Number(survey.quantity)).toBe(2);
      expect(Number(survey.unit_price)).toBe(250_000);
      expect(Number(survey.line_total)).toBe(500_000);
      expect(survey.vat_rate).toBe("0.16");
      const noteless = lines.rows.find((l: { description: string }) =>
        l.description.includes("Time"),
      );
      expect(noteless.description).toBe("2026-07-02 — Time (1.5h)");
      expect(Number(noteless.line_total)).toBe(375_000);
      const materials = lines.rows.find((l: { description: string }) =>
        l.description.includes("Materials"),
      );
      expect(materials.description).toBe("2026-07-04 — Materials delivery");
      expect(Number(materials.quantity)).toBe(1);
      expect(Number(materials.line_total)).toBe(2_500_000);

      // Billable rows are stamped; non-billable rows stay unbilled.
      const time = await c.query(
        `SELECT billable, billed_invoice_id FROM project_time_entries
         WHERE project_id = $1 ORDER BY entry_date`,
        [proj.id],
      );
      expect(time.rows[0].billed_invoice_id).toBe(res.invoiceId);
      expect(time.rows[1].billed_invoice_id).toBe(res.invoiceId);
      expect(time.rows[2].billable).toBe(false);
      expect(time.rows[2].billed_invoice_id).toBeNull();
      const exp = await c.query(
        `SELECT billable, billed_invoice_id FROM project_expenses
         WHERE project_id = $1 ORDER BY expense_date`,
        [proj.id],
      );
      expect(exp.rows[0].billed_invoice_id).toBe(res.invoiceId);
      expect(exp.rows[1].billed_invoice_id).toBeNull();
    });

    // Billed rows are locked against edit and delete.
    const billedEntry = await db.withTenant(tenant, user, async (c) =>
      (
        await c.query(
          `SELECT id FROM project_time_entries
           WHERE project_id = $1 AND billed_invoice_id IS NOT NULL LIMIT 1`,
          [proj.id],
        )
      ).rows[0].id,
    );
    await expect(
      db.withTenant(tenant, user, (c) =>
        projects.updateTime(c, {
          ...ctx(),
          projectId: proj.id,
          entryId: billedEntry,
          hours: 9,
        }),
      ),
    ).rejects.toThrow(/already billed/);
    await expect(
      db.withTenant(tenant, user, (c) =>
        projects.deleteTime(c, {
          ...ctx(),
          projectId: proj.id,
          entryId: billedEntry,
        }),
      ),
    ).rejects.toThrow(/already billed/);
    const billedExpense = await db.withTenant(tenant, user, async (c) =>
      (
        await c.query(
          `SELECT id FROM project_expenses
           WHERE project_id = $1 AND billed_invoice_id IS NOT NULL LIMIT 1`,
          [proj.id],
        )
      ).rows[0].id,
    );
    await expect(
      db.withTenant(tenant, user, (c) =>
        projects.updateExpense(c, {
          ...ctx(),
          projectId: proj.id,
          expenseId: billedExpense,
          amountCents: 1,
        }),
      ),
    ).rejects.toThrow(/already billed/);
    await expect(
      db.withTenant(tenant, user, (c) =>
        projects.deleteExpense(c, {
          ...ctx(),
          projectId: proj.id,
          expenseId: billedExpense,
        }),
      ),
    ).rejects.toThrow(/already billed/);

    // Second run: everything billable is billed already.
    await expect(
      db.withTenant(tenant, user, (c) =>
        projects.billUnbilled(c, {
          ...ctx(),
          projectId: proj.id,
          branchId: branch,
        }),
      ),
    ).rejects.toThrow(/Nothing to bill/);

    // New work after the first run bills onto a NEW draft with only that line.
    await db.withTenant(tenant, user, (c) =>
      projects.addTime(c, {
        ...ctx(),
        projectId: proj.id,
        entryDate: "2026-07-06",
        hours: 4,
        note: "Snag fixes",
      }),
    );
    const second = await db.withTenant(tenant, user, (c) =>
      projects.billUnbilled(c, {
        ...ctx(),
        projectId: proj.id,
        branchId: branch,
      }),
    );
    expect(second.invoiceId).not.toBe(res.invoiceId);
    expect(second.timeEntries).toBe(1);
    expect(second.expenses).toBe(0);
    expect(second.subtotalCents).toBe(1_000_000);
    await db.withTenant(tenant, user, async (c) => {
      const n = await c.query(
        "SELECT count(*) AS n FROM invoice_lines WHERE invoice_id = $1",
        [second.invoiceId],
      );
      expect(Number(n.rows[0].n)).toBe(1);
    });
  });

  it("billing requires a customer on the project", async () => {
    const proj = await db.withTenant(tenant, user, (c) =>
      projects.createProject(c, {
        ...ctx(),
        name: "Internal works",
        hourlyRateCents: 1_000_00,
      }),
    );
    await db.withTenant(tenant, user, (c) =>
      projects.addTime(c, {
        ...ctx(),
        projectId: proj.id,
        entryDate: "2026-07-07",
        hours: 1,
      }),
    );
    await expect(
      db.withTenant(tenant, user, (c) =>
        projects.billUnbilled(c, {
          ...ctx(),
          projectId: proj.id,
          branchId: branch,
        }),
      ),
    ).rejects.toThrow(/no customer/);
  });

  it("profitability: billed/unbilled/cost/margin and budget consumption", async () => {
    // rate 2 000 KES/h, budget 100 000 KES.
    const proj = await db.withTenant(tenant, user, (c) =>
      projects.createProject(c, {
        ...ctx(),
        name: "Margin check",
        customerId: customer,
        budgetCents: 100_000_00,
        hourlyRateCents: 2_000_00,
      }),
    );
    await db.withTenant(tenant, user, async (c) => {
      await projects.addTime(c, {
        ...ctx(),
        projectId: proj.id,
        entryDate: "2026-07-01",
        hours: 2,
        note: "Billable work",
      });
      await projects.addTime(c, {
        ...ctx(),
        projectId: proj.id,
        entryDate: "2026-07-02",
        hours: 3,
        note: "Internal",
        billable: false,
      });
      await projects.addExpense(c, {
        ...ctx(),
        projectId: proj.id,
        expenseDate: "2026-07-03",
        description: "Rebillable materials",
        amountCents: 30_000_00,
      });
      await projects.addExpense(c, {
        ...ctx(),
        projectId: proj.id,
        expenseDate: "2026-07-04",
        description: "Own tooling",
        amountCents: 20_000_00,
        billable: false,
      });
    });

    const before = await db.withTenant(tenant, user, (c) =>
      projects.profitability(c, proj.id),
    );
    expect(before.hours).toBe(5);
    // labour: 5h x 2 000 = 10 000; expenses 50 000 → cost 60 000 KES.
    expect(before.laborCostCents).toBe(1_000_000);
    expect(before.expenseCents).toBe(5_000_000);
    expect(before.costCents).toBe(6_000_000);
    expect(before.billedCents).toBe(0);
    // unbilled: 2h x 2 000 + 30 000 = 34 000 KES.
    expect(before.unbilledCents).toBe(3_400_000);
    expect(before.marginCents).toBe(3_400_000 - 6_000_000);
    expect(before.marginPct).toBe(-76.5);
    expect(before.budgetUsedPct).toBe(60);

    // The list rollup agrees with the unbilled bucket.
    const list = await db.withTenant(tenant, user, (c) =>
      projects.listProjects(c),
    );
    const row = list.find((r: { id: string }) => r.id === proj.id);
    expect(Number(row.unbilled_cents)).toBe(3_400_000);
    expect(Number(row.expense_cents)).toBe(5_000_000);

    // After billing, value moves from unbilled to billed; cost is unchanged.
    await db.withTenant(tenant, user, (c) =>
      projects.billUnbilled(c, {
        ...ctx(),
        projectId: proj.id,
        branchId: branch,
      }),
    );
    const after = await db.withTenant(tenant, user, (c) =>
      projects.profitability(c, proj.id),
    );
    expect(after.billedCents).toBe(3_400_000);
    expect(after.unbilledCents).toBe(0);
    expect(after.costCents).toBe(6_000_000);
    expect(after.marginCents).toBe(-2_600_000);
    expect(after.marginPct).toBe(-76.5);
    expect(after.budgetUsedPct).toBe(60);
  });
});
