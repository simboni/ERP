/**
 * Project management tests against jenga_test:
 *  - task CRUD with validation, coalescing PATCH, and the completed_at
 *    stamp/clear as status crosses in and out of 'done',
 *  - milestone create / reach (stamps reached_at) / reopen (clears it) / delete,
 *  - the delivery summary: task counts by status, % complete (done / total),
 *    milestone progress, hours logged vs estimate and budget consumption,
 *  - the cross-project "my tasks" list with assignee and status filters.
 * Nothing here issues an invoice, so the fiscal queue stays empty; the
 * afterAll still drains it defensively like payments.spec.ts.
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

describe("project management (tasks, milestones, summary, my work)", () => {
  const db = new DbService();
  const ledger = new LedgerService();
  const audit = new AuditService();
  const fiscal = new FiscalService(new SandboxFiscalProvider());
  const invoices = new InvoicesService(ledger, fiscal, audit);
  const projects = new ProjectsService(invoices, audit);

  let tenant: string;
  let user: string;
  let customer: string;
  let alice: string;
  let bob: string;

  const ctx = () => ({ tenantId: tenant, userId: user });

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    const u = await db.query(
      `INSERT INTO users (email, password_hash, full_name)
       VALUES ($1, 'x', 'PM Tester') RETURNING id`,
      [`pm-${suffix}@test.local`],
    );
    user = u.rows[0].id;
    const t = await db.query(
      "SELECT create_tenant_with_owner($1, $2, $3) AS id",
      ["pm-co", `pm-co-${suffix}`, user],
    );
    tenant = t.rows[0].id;
    await db.withTenant(tenant, user, async (c) => {
      await seedDefaultAccounts(c, tenant);
      customer = (
        await c.query(
          `INSERT INTO customers (tenant_id, name)
           VALUES ($1, 'Delivery Client Ltd') RETURNING id`,
          [tenant],
        )
      ).rows[0].id;
      alice = (
        await c.query(
          `INSERT INTO employees (tenant_id, full_name, gross_cents)
           VALUES ($1, 'Alice Engineer', 6000000) RETURNING id`,
          [tenant],
        )
      ).rows[0].id;
      bob = (
        await c.query(
          `INSERT INTO employees (tenant_id, full_name, gross_cents)
           VALUES ($1, 'Bob Builder', 5000000) RETURNING id`,
          [tenant],
        )
      ).rows[0].id;
    });
  });

  afterAll(async () => {
    // Nothing issues invoices here, but drain defensively like payments.spec.
    for (let i = 0; i < 5; i++) await fiscal.processOnce();
    await fiscal.onModuleDestroy();
    await db.onModuleDestroy();
  });

  const newProject = (extra: Record<string, unknown> = {}) =>
    db.withTenant(tenant, user, (c) =>
      projects.createProject(c, {
        ...ctx(),
        name: `Project ${randomUUID().slice(0, 6)}`,
        customerId: customer,
        ...extra,
      }),
    );

  it("project carries the new scheduling/ownership fields", async () => {
    const proj = await newProject({
      description: "Fit-out delivery",
      startDate: "2026-07-01",
      endDate: "2026-09-30",
      managerEmployeeId: alice,
    });
    const detail = await db.withTenant(tenant, user, (c) =>
      projects.getProject(c, proj.id),
    );
    expect(detail.project.description).toBe("Fit-out delivery");
    expect(detail.project.manager_employee_id).toBe(alice);
    expect(detail.project.manager_name).toBe("Alice Engineer");
    // Unknown manager is rejected.
    await expect(
      newProject({ managerEmployeeId: randomUUID() }),
    ).rejects.toThrow(/employeeId/);
  });

  it("task CRUD: create, validate, coalescing PATCH", async () => {
    const proj = await newProject();
    await expect(
      db.withTenant(tenant, user, (c) =>
        projects.createTask(c, { ...ctx(), projectId: proj.id, title: "  " }),
      ),
    ).rejects.toThrow(/title/);
    await expect(
      db.withTenant(tenant, user, (c) =>
        projects.createTask(c, {
          ...ctx(),
          projectId: proj.id,
          title: "x",
          priority: "urgent",
        }),
      ),
    ).rejects.toThrow(/priority/);
    await expect(
      db.withTenant(tenant, user, (c) =>
        projects.createTask(c, {
          ...ctx(),
          projectId: proj.id,
          title: "x",
          estimateHours: 1.234,
        }),
      ),
    ).rejects.toThrow(/estimateHours/);

    const task = await db.withTenant(tenant, user, (c) =>
      projects.createTask(c, {
        ...ctx(),
        projectId: proj.id,
        title: "Site survey",
        description: "Measure the space",
        priority: "high",
        assigneeEmployeeId: alice,
        dueDate: "2026-07-10",
        estimateHours: 8,
      }),
    );
    expect(task.status).toBe("todo");
    expect(task.priority).toBe("high");
    expect(task.completed_at).toBeNull();
    expect(Number(task.estimate_hours)).toBe(8);

    // PATCH only the fields provided — the rest survive.
    const moved = await db.withTenant(tenant, user, (c) =>
      projects.updateTask(c, {
        ...ctx(),
        projectId: proj.id,
        taskId: task.id,
        status: "in_progress",
      }),
    );
    expect(moved.status).toBe("in_progress");
    expect(moved.title).toBe("Site survey");
    expect(moved.priority).toBe("high");
    expect(moved.assignee_employee_id).toBe(alice);
    expect(new Date(moved.due_date).toISOString().slice(0, 10)).toBe(
      "2026-07-10",
    );
    expect(moved.completed_at).toBeNull();

    // Reassign + clear the due date.
    const reassigned = await db.withTenant(tenant, user, (c) =>
      projects.updateTask(c, {
        ...ctx(),
        projectId: proj.id,
        taskId: task.id,
        assigneeEmployeeId: bob,
        dueDate: null,
      }),
    );
    expect(reassigned.assignee_employee_id).toBe(bob);
    expect(reassigned.due_date).toBeNull();

    await db.withTenant(tenant, user, (c) =>
      projects.deleteTask(c, { ...ctx(), projectId: proj.id, taskId: task.id }),
    );
    const left = await db.withTenant(tenant, user, (c) =>
      projects.listTasks(c, proj.id),
    );
    expect(left).toHaveLength(0);
  });

  it("status → done stamps completed_at; moving off done clears it", async () => {
    const proj = await newProject();
    const task = await db.withTenant(tenant, user, (c) =>
      projects.createTask(c, { ...ctx(), projectId: proj.id, title: "Ship it" }),
    );
    expect(task.completed_at).toBeNull();

    const done = await db.withTenant(tenant, user, (c) =>
      projects.updateTask(c, {
        ...ctx(),
        projectId: proj.id,
        taskId: task.id,
        status: "done",
      }),
    );
    expect(done.status).toBe("done");
    expect(done.completed_at).not.toBeNull();
    const stampedAt = done.completed_at;

    // A further edit that keeps status 'done' leaves the original stamp.
    const stillDone = await db.withTenant(tenant, user, (c) =>
      projects.updateTask(c, {
        ...ctx(),
        projectId: proj.id,
        taskId: task.id,
        priority: "low",
      }),
    );
    expect(stillDone.completed_at).toEqual(stampedAt);

    // Reopening clears completed_at.
    const reopened = await db.withTenant(tenant, user, (c) =>
      projects.updateTask(c, {
        ...ctx(),
        projectId: proj.id,
        taskId: task.id,
        status: "todo",
      }),
    );
    expect(reopened.status).toBe("todo");
    expect(reopened.completed_at).toBeNull();

    // Creating straight into 'done' stamps immediately.
    const born = await db.withTenant(tenant, user, (c) =>
      projects.createTask(c, {
        ...ctx(),
        projectId: proj.id,
        title: "Already done",
        status: "done",
      }),
    );
    expect(born.completed_at).not.toBeNull();
  });

  it("milestone reach stamps reached_at, reopen clears it", async () => {
    const proj = await newProject();
    const ms = await db.withTenant(tenant, user, (c) =>
      projects.createMilestone(c, {
        ...ctx(),
        projectId: proj.id,
        name: "Phase 1 sign-off",
        dueDate: "2026-08-01",
      }),
    );
    expect(ms.status).toBe("open");
    expect(ms.reached_at).toBeNull();

    const reached = await db.withTenant(tenant, user, (c) =>
      projects.updateMilestone(c, {
        ...ctx(),
        projectId: proj.id,
        milestoneId: ms.id,
        status: "reached",
      }),
    );
    expect(reached.status).toBe("reached");
    expect(reached.reached_at).not.toBeNull();

    const reopened = await db.withTenant(tenant, user, (c) =>
      projects.updateMilestone(c, {
        ...ctx(),
        projectId: proj.id,
        milestoneId: ms.id,
        status: "open",
      }),
    );
    expect(reopened.reached_at).toBeNull();

    await db.withTenant(tenant, user, (c) =>
      projects.deleteMilestone(c, {
        ...ctx(),
        projectId: proj.id,
        milestoneId: ms.id,
      }),
    );
    const left = await db.withTenant(tenant, user, (c) =>
      projects.listMilestones(c, proj.id),
    );
    expect(left).toHaveLength(0);
  });

  it("summary: % complete, milestone progress, hours vs estimate, budget", async () => {
    const proj = await newProject({
      budgetCents: 100_000_00,
      hourlyRateCents: 2_000_00,
    });
    // Four tasks: 1 done, 3 not — 25% complete; estimates sum to 20h.
    await db.withTenant(tenant, user, async (c) => {
      await projects.createTask(c, {
        ...ctx(),
        projectId: proj.id,
        title: "Done task",
        status: "done",
        estimateHours: 5,
      });
      await projects.createTask(c, {
        ...ctx(),
        projectId: proj.id,
        title: "In progress",
        status: "in_progress",
        estimateHours: 5,
      });
      await projects.createTask(c, {
        ...ctx(),
        projectId: proj.id,
        title: "Blocked task",
        status: "blocked",
        estimateHours: 5,
      });
      await projects.createTask(c, {
        ...ctx(),
        projectId: proj.id,
        title: "Todo task",
        status: "todo",
        estimateHours: 5,
      });
      // Two milestones, one reached — 50%.
      const m1 = await projects.createMilestone(c, {
        ...ctx(),
        projectId: proj.id,
        name: "M1",
      });
      await projects.createMilestone(c, { ...ctx(), projectId: proj.id, name: "M2" });
      await projects.updateMilestone(c, {
        ...ctx(),
        projectId: proj.id,
        milestoneId: m1.id,
        status: "reached",
      });
      // 10 billable hours logged @ 2 000 = 20 000 KES cost against 100 000 budget → 20%.
      await projects.addTime(c, {
        ...ctx(),
        projectId: proj.id,
        entryDate: "2026-07-05",
        hours: 10,
        note: "work",
      });
    });

    const s = await db.withTenant(tenant, user, (c) =>
      projects.summary(c, proj.id),
    );
    expect(s.tasks.total).toBe(4);
    expect(s.tasks.done).toBe(1);
    expect(s.tasks.todo).toBe(1);
    expect(s.tasks.in_progress).toBe(1);
    expect(s.tasks.blocked).toBe(1);
    expect(s.tasks.pctComplete).toBe(25);
    expect(s.tasks.estimateHours).toBe(20);
    expect(s.milestones.total).toBe(2);
    expect(s.milestones.reached).toBe(1);
    expect(s.milestones.pct).toBe(50);
    expect(s.hoursLogged).toBe(10);
    expect(s.estimateHours).toBe(20);
    expect(s.budgetUsedPct).toBe(20);

    // A project with no tasks reports 0% (no divide-by-zero).
    const empty = await newProject();
    const es = await db.withTenant(tenant, user, (c) =>
      projects.summary(c, empty.id),
    );
    expect(es.tasks.total).toBe(0);
    expect(es.tasks.pctComplete).toBe(0);
    expect(es.milestones.pct).toBe(0);
  });

  it("my tasks: cross-project list filters by assignee and status", async () => {
    const p1 = await newProject();
    const p2 = await newProject();
    await db.withTenant(tenant, user, async (c) => {
      await projects.createTask(c, {
        ...ctx(),
        projectId: p1.id,
        title: "Alice todo",
        assigneeEmployeeId: alice,
      });
      await projects.createTask(c, {
        ...ctx(),
        projectId: p2.id,
        title: "Alice done",
        assigneeEmployeeId: alice,
        status: "done",
      });
      await projects.createTask(c, {
        ...ctx(),
        projectId: p2.id,
        title: "Bob todo",
        assigneeEmployeeId: bob,
      });
    });

    const mine = await db.withTenant(tenant, user, (c) =>
      projects.listMyTasks(c, { assigneeEmployeeId: alice }),
    );
    const titles = mine.map((r: { title: string }) => r.title);
    expect(titles).toContain("Alice todo");
    expect(titles).toContain("Alice done");
    expect(titles).not.toContain("Bob todo");
    // project_name comes back so the UI can group without a second call.
    expect(mine.every((r: { project_name: string }) => !!r.project_name)).toBe(true);

    const aliceOpen = await db.withTenant(tenant, user, (c) =>
      projects.listMyTasks(c, { assigneeEmployeeId: alice, status: "todo" }),
    );
    expect(aliceOpen.map((r: { title: string }) => r.title)).toEqual(["Alice todo"]);

    // Bad status filter is rejected.
    await expect(
      db.withTenant(tenant, user, (c) =>
        projects.listMyTasks(c, { status: "nope" }),
      ),
    ).rejects.toThrow(/status/);
  });
});
