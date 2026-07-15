import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { AuditService } from "../audit/audit.service";
import {
  InvoiceLineInput,
  InvoicesService,
} from "../invoicing/invoices.service";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const PROJECT_STATUSES = ["active", "completed", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const TASK_STATUSES = [
  "todo",
  "in_progress",
  "blocked",
  "done",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_PRIORITIES = ["low", "medium", "high"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const MILESTONE_STATUSES = ["open", "reached"] as const;

/** Estimate hours: non-negative, at most 2dp, capped so a typo can't overflow. */
function optionalEstimate(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const h = Number(value);
  if (!Number.isFinite(h) || h < 0 || h > 99999 || Math.round(h * 100) / 100 !== h) {
    throw new BadRequestException(
      "estimateHours must be 0 or more with at most 2 decimals",
    );
  }
  return h;
}

function optionalDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requireDate(value, field);
}

/** Max invoice-line description length (KRA-friendly, keeps PDFs tidy). */
const DESC_MAX = 180;

function isoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function requireDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw new BadRequestException(`${field} must be YYYY-MM-DD`);
  }
  return value;
}

/** Hours: positive, max 24, at most 2 decimal places. */
function requireHours(value: unknown): number {
  const h = Number(value);
  if (!(h > 0) || h > 24 || Math.round(h * 100) / 100 !== h) {
    throw new BadRequestException("hours must be 0-24 with at most 2 decimals");
  }
  return h;
}

function optionalCents(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new BadRequestException(`${field} must be a non-negative integer (cents)`);
  }
  return value as number;
}

/**
 * Project Operations domain: customer projects, time entries and project
 * expenses (integer cents, hours numeric 2dp), a profitability rollup and
 * one-click billing of all billable unbilled work into a DRAFT invoice via
 * InvoicesService.createDraft (no ledger effect until the invoice is
 * issued). Rows lock once billed_invoice_id is set. All methods run inside
 * the caller's withTenant transaction — RLS scopes every query.
 */
@Injectable()
export class ProjectsService {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly audit: AuditService,
  ) {}

  // ---- Projects ------------------------------------------------------------

  async createProject(
    client: PoolClient,
    args: {
      tenantId: string;
      userId: string;
      name: string;
      customerId?: string | null;
      budgetCents?: number | null;
      hourlyRateCents?: number | null;
      description?: string;
      startDate?: string | null;
      endDate?: string | null;
      managerEmployeeId?: string | null;
    },
  ) {
    const name = args.name?.trim();
    if (!name) throw new BadRequestException("name is required");
    const budget = optionalCents(args.budgetCents, "budgetCents");
    const rate = optionalCents(args.hourlyRateCents, "hourlyRateCents");
    if (args.customerId) await this.requireCustomer(client, args.customerId);
    const startDate = optionalDate(args.startDate, "startDate");
    const endDate = optionalDate(args.endDate, "endDate");
    let manager: string | null = null;
    if (args.managerEmployeeId) {
      manager = args.managerEmployeeId;
      await this.requireEmployee(client, manager);
    }
    const res = await client.query(
      `INSERT INTO projects
         (tenant_id, customer_id, name, budget_cents, hourly_rate_cents,
          description, start_date, end_date, manager_employee_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, customer_id, name, status, budget_cents, hourly_rate_cents,
                 description, start_date, end_date, manager_employee_id, created_at`,
      [
        args.tenantId,
        args.customerId ?? null,
        name,
        budget,
        rate,
        args.description?.trim() ?? "",
        startDate,
        endDate,
        manager,
        args.userId,
      ],
    );
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "project.created",
      entityType: "project",
      entityId: res.rows[0].id,
      payload: { name },
    });
    return res.rows[0];
  }

  /** List with rollups: hours, unbilled billable value, total expenses. */
  async listProjects(client: PoolClient) {
    const res = await client.query(
      `SELECT p.id, p.name, p.status, p.customer_id, c.name AS customer_name,
              p.budget_cents::bigint AS budget_cents,
              p.hourly_rate_cents::bigint AS hourly_rate_cents,
              p.created_at,
              coalesce(t.hours, 0)::numeric AS hours,
              (coalesce(t.unbilled_time_cents, 0)
               + coalesce(e.unbilled_expense_cents, 0))::bigint AS unbilled_cents,
              coalesce(e.expense_cents, 0)::bigint AS expense_cents,
              (coalesce(t.entries, 0) + coalesce(e.entries, 0))::int AS entry_count
       FROM projects p
       LEFT JOIN customers c ON c.id = p.customer_id
       LEFT JOIN LATERAL (
         SELECT count(*) AS entries,
                sum(te.hours) AS hours,
                sum(round(te.hours * coalesce(p.hourly_rate_cents, 0)))
                  FILTER (WHERE te.billable AND te.billed_invoice_id IS NULL)
                  AS unbilled_time_cents
         FROM project_time_entries te WHERE te.project_id = p.id
       ) t ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS entries,
                sum(pe.amount_cents) AS expense_cents,
                sum(pe.amount_cents)
                  FILTER (WHERE pe.billable AND pe.billed_invoice_id IS NULL)
                  AS unbilled_expense_cents
         FROM project_expenses pe WHERE pe.project_id = p.id
       ) e ON true
       ORDER BY p.status, p.name
       LIMIT 200`,
    );
    return res.rows;
  }

  async getProject(client: PoolClient, projectId: string) {
    const p = await client.query(
      `SELECT p.id, p.name, p.status, p.customer_id, c.name AS customer_name,
              p.budget_cents::bigint AS budget_cents,
              p.hourly_rate_cents::bigint AS hourly_rate_cents,
              p.description, p.start_date, p.end_date,
              p.manager_employee_id, m.full_name AS manager_name, p.created_at
       FROM projects p
       LEFT JOIN customers c ON c.id = p.customer_id
       LEFT JOIN employees m ON m.id = p.manager_employee_id
       WHERE p.id = $1`,
      [projectId],
    );
    if (!p.rows[0]) throw new NotFoundException("Project not found");
    const [time, expenses] = await Promise.all([
      this.listTime(client, projectId),
      this.listExpenses(client, projectId),
    ]);
    return { project: p.rows[0], time, expenses };
  }

  async updateProject(
    client: PoolClient,
    args: {
      tenantId: string;
      userId: string;
      projectId: string;
      name?: string;
      customerId?: string | null;
      status?: string;
      budgetCents?: number | null;
      hourlyRateCents?: number | null;
      description?: string;
      startDate?: string | null;
      endDate?: string | null;
      managerEmployeeId?: string | null;
    },
  ) {
    const cur = await client.query(
      `SELECT id, name, customer_id, status, budget_cents, hourly_rate_cents,
              description, start_date, end_date, manager_employee_id
       FROM projects WHERE id = $1 FOR UPDATE`,
      [args.projectId],
    );
    if (!cur.rows[0]) throw new NotFoundException("Project not found");
    const row = cur.rows[0];

    const name =
      args.name === undefined ? row.name : args.name.trim();
    if (!name) throw new BadRequestException("name cannot be empty");
    let status = row.status as ProjectStatus;
    if (args.status !== undefined) {
      if (!PROJECT_STATUSES.includes(args.status as ProjectStatus)) {
        throw new BadRequestException("status must be active | completed | archived");
      }
      status = args.status as ProjectStatus;
    }
    let customerId: string | null = row.customer_id;
    if (args.customerId !== undefined) {
      customerId = args.customerId || null;
      if (customerId) await this.requireCustomer(client, customerId);
    }
    const budget =
      args.budgetCents === undefined
        ? row.budget_cents
        : optionalCents(args.budgetCents, "budgetCents");
    const rate =
      args.hourlyRateCents === undefined
        ? row.hourly_rate_cents
        : optionalCents(args.hourlyRateCents, "hourlyRateCents");
    const description =
      args.description === undefined ? row.description : args.description.trim();
    const startDate =
      args.startDate === undefined
        ? (row.start_date === null ? null : isoDate(row.start_date))
        : optionalDate(args.startDate, "startDate");
    const endDate =
      args.endDate === undefined
        ? (row.end_date === null ? null : isoDate(row.end_date))
        : optionalDate(args.endDate, "endDate");
    let manager: string | null = row.manager_employee_id;
    if (args.managerEmployeeId !== undefined) {
      manager = args.managerEmployeeId || null;
      if (manager) await this.requireEmployee(client, manager);
    }

    const res = await client.query(
      `UPDATE projects
       SET name = $2, customer_id = $3, status = $4,
           budget_cents = $5, hourly_rate_cents = $6, description = $7,
           start_date = $8, end_date = $9, manager_employee_id = $10
       WHERE id = $1
       RETURNING id, customer_id, name, status, budget_cents, hourly_rate_cents,
                 description, start_date, end_date, manager_employee_id`,
      [
        args.projectId,
        name,
        customerId,
        status,
        budget,
        rate,
        description,
        startDate,
        endDate,
        manager,
      ],
    );
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "project.updated",
      entityType: "project",
      entityId: args.projectId,
      payload: { name, status },
    });
    return res.rows[0];
  }

  /** Delete only projects with no logged work — else archive. */
  async deleteProject(
    client: PoolClient,
    args: { tenantId: string; userId: string; projectId: string },
  ): Promise<{ deleted: true }> {
    const exists = await client.query(
      "SELECT name FROM projects WHERE id = $1 FOR UPDATE",
      [args.projectId],
    );
    if (!exists.rows[0]) throw new NotFoundException("Project not found");
    const used = await client.query(
      `SELECT (SELECT count(*) FROM project_time_entries WHERE project_id = $1)
              + (SELECT count(*) FROM project_expenses WHERE project_id = $1) AS n`,
      [args.projectId],
    );
    if (Number(used.rows[0].n) > 0) {
      throw new BadRequestException(
        "Project has logged time or expenses — archive it instead of deleting",
      );
    }
    await client.query("DELETE FROM projects WHERE id = $1", [args.projectId]);
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "project.deleted",
      entityType: "project",
      entityId: args.projectId,
      payload: { name: exists.rows[0].name },
    });
    return { deleted: true };
  }

  // ---- Time entries --------------------------------------------------------

  async listTime(client: PoolClient, projectId: string) {
    const res = await client.query(
      `SELECT te.id, te.entry_date, te.hours::numeric AS hours, te.note,
              te.billable, te.billed_invoice_id, te.employee_id,
              e.full_name AS employee_name,
              inv.invoice_no, inv.status AS invoice_status
       FROM project_time_entries te
       LEFT JOIN employees e ON e.id = te.employee_id
       LEFT JOIN invoices inv ON inv.id = te.billed_invoice_id
       WHERE te.project_id = $1
       ORDER BY te.entry_date DESC, te.created_at DESC
       LIMIT 500`,
      [projectId],
    );
    return res.rows;
  }

  async addTime(
    client: PoolClient,
    args: {
      tenantId: string;
      userId: string;
      projectId: string;
      entryDate: string;
      hours: number;
      note?: string;
      billable?: boolean;
      employeeId?: string | null;
    },
  ) {
    await this.requireProject(client, args.projectId);
    const entryDate = requireDate(args.entryDate, "entryDate");
    const hours = requireHours(args.hours);
    if (args.employeeId) await this.requireEmployee(client, args.employeeId);
    const res = await client.query(
      `INSERT INTO project_time_entries
         (tenant_id, project_id, employee_id, entry_date, hours, note, billable, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, entry_date, hours, note, billable, employee_id, billed_invoice_id`,
      [
        args.tenantId,
        args.projectId,
        args.employeeId ?? null,
        entryDate,
        hours,
        args.note?.trim() ?? "",
        args.billable ?? true,
        args.userId,
      ],
    );
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "project.time_logged",
      entityType: "project_time_entry",
      entityId: res.rows[0].id,
      payload: { projectId: args.projectId, hours },
    });
    return res.rows[0];
  }

  async updateTime(
    client: PoolClient,
    args: {
      tenantId: string;
      userId: string;
      projectId: string;
      entryId: string;
      entryDate?: string;
      hours?: number;
      note?: string;
      billable?: boolean;
      employeeId?: string | null;
    },
  ) {
    const cur = await client.query(
      `SELECT id, entry_date, hours, note, billable, employee_id, billed_invoice_id
       FROM project_time_entries WHERE id = $1 AND project_id = $2 FOR UPDATE`,
      [args.entryId, args.projectId],
    );
    if (!cur.rows[0]) throw new NotFoundException("Time entry not found");
    if (cur.rows[0].billed_invoice_id) {
      throw new BadRequestException("Time entry is already billed — it cannot be edited");
    }
    const row = cur.rows[0];
    const entryDate =
      args.entryDate === undefined
        ? isoDate(row.entry_date)
        : requireDate(args.entryDate, "entryDate");
    const hours =
      args.hours === undefined ? Number(row.hours) : requireHours(args.hours);
    let employeeId: string | null = row.employee_id;
    if (args.employeeId !== undefined) {
      employeeId = args.employeeId || null;
      if (employeeId) await this.requireEmployee(client, employeeId);
    }
    const res = await client.query(
      `UPDATE project_time_entries
       SET entry_date = $2, hours = $3, note = $4, billable = $5, employee_id = $6
       WHERE id = $1
       RETURNING id, entry_date, hours, note, billable, employee_id, billed_invoice_id`,
      [
        args.entryId,
        entryDate,
        hours,
        args.note === undefined ? row.note : args.note.trim(),
        args.billable ?? row.billable,
        employeeId,
      ],
    );
    return res.rows[0];
  }

  async deleteTime(
    client: PoolClient,
    args: { tenantId: string; userId: string; projectId: string; entryId: string },
  ): Promise<{ deleted: true }> {
    const cur = await client.query(
      `SELECT billed_invoice_id FROM project_time_entries
       WHERE id = $1 AND project_id = $2 FOR UPDATE`,
      [args.entryId, args.projectId],
    );
    if (!cur.rows[0]) throw new NotFoundException("Time entry not found");
    if (cur.rows[0].billed_invoice_id) {
      throw new BadRequestException("Time entry is already billed — it cannot be deleted");
    }
    await client.query("DELETE FROM project_time_entries WHERE id = $1", [
      args.entryId,
    ]);
    return { deleted: true };
  }

  // ---- Expenses --------------------------------------------------------------

  async listExpenses(client: PoolClient, projectId: string) {
    const res = await client.query(
      `SELECT pe.id, pe.expense_date, pe.description,
              pe.amount_cents::bigint AS amount_cents, pe.billable,
              pe.billed_invoice_id, inv.invoice_no, inv.status AS invoice_status
       FROM project_expenses pe
       LEFT JOIN invoices inv ON inv.id = pe.billed_invoice_id
       WHERE pe.project_id = $1
       ORDER BY pe.expense_date DESC, pe.created_at DESC
       LIMIT 500`,
      [projectId],
    );
    return res.rows;
  }

  async addExpense(
    client: PoolClient,
    args: {
      tenantId: string;
      userId: string;
      projectId: string;
      expenseDate: string;
      description: string;
      amountCents: number;
      billable?: boolean;
    },
  ) {
    await this.requireProject(client, args.projectId);
    const expenseDate = requireDate(args.expenseDate, "expenseDate");
    const description = args.description?.trim();
    if (!description) throw new BadRequestException("description is required");
    if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) {
      throw new BadRequestException("amountCents must be a positive integer");
    }
    const res = await client.query(
      `INSERT INTO project_expenses
         (tenant_id, project_id, expense_date, description, amount_cents, billable, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, expense_date, description, amount_cents, billable, billed_invoice_id`,
      [
        args.tenantId,
        args.projectId,
        expenseDate,
        description,
        args.amountCents,
        args.billable ?? true,
        args.userId,
      ],
    );
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "project.expense_recorded",
      entityType: "project_expense",
      entityId: res.rows[0].id,
      payload: { projectId: args.projectId, amountCents: args.amountCents },
    });
    return res.rows[0];
  }

  async updateExpense(
    client: PoolClient,
    args: {
      tenantId: string;
      userId: string;
      projectId: string;
      expenseId: string;
      expenseDate?: string;
      description?: string;
      amountCents?: number;
      billable?: boolean;
    },
  ) {
    const cur = await client.query(
      `SELECT id, expense_date, description, amount_cents, billable, billed_invoice_id
       FROM project_expenses WHERE id = $1 AND project_id = $2 FOR UPDATE`,
      [args.expenseId, args.projectId],
    );
    if (!cur.rows[0]) throw new NotFoundException("Expense not found");
    if (cur.rows[0].billed_invoice_id) {
      throw new BadRequestException("Expense is already billed — it cannot be edited");
    }
    const row = cur.rows[0];
    const expenseDate =
      args.expenseDate === undefined
        ? isoDate(row.expense_date)
        : requireDate(args.expenseDate, "expenseDate");
    const description =
      args.description === undefined ? row.description : args.description.trim();
    if (!description) throw new BadRequestException("description cannot be empty");
    let amount = Number(row.amount_cents);
    if (args.amountCents !== undefined) {
      if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) {
        throw new BadRequestException("amountCents must be a positive integer");
      }
      amount = args.amountCents;
    }
    const res = await client.query(
      `UPDATE project_expenses
       SET expense_date = $2, description = $3, amount_cents = $4, billable = $5
       WHERE id = $1
       RETURNING id, expense_date, description, amount_cents, billable, billed_invoice_id`,
      [args.expenseId, expenseDate, description, amount, args.billable ?? row.billable],
    );
    return res.rows[0];
  }

  async deleteExpense(
    client: PoolClient,
    args: { tenantId: string; userId: string; projectId: string; expenseId: string },
  ): Promise<{ deleted: true }> {
    const cur = await client.query(
      `SELECT billed_invoice_id FROM project_expenses
       WHERE id = $1 AND project_id = $2 FOR UPDATE`,
      [args.expenseId, args.projectId],
    );
    if (!cur.rows[0]) throw new NotFoundException("Expense not found");
    if (cur.rows[0].billed_invoice_id) {
      throw new BadRequestException("Expense is already billed — it cannot be deleted");
    }
    await client.query("DELETE FROM project_expenses WHERE id = $1", [
      args.expenseId,
    ]);
    return { deleted: true };
  }

  // ---- Profitability ---------------------------------------------------------

  /**
   * Profitability rollup. Billed revenue is the VAT-exclusive subtotal of
   * the draft/issued invoices this project's work was billed onto (each
   * bill run creates an invoice containing only this project's lines, so
   * the invoice subtotal IS the attributable line total). Unbilled value
   * prices billable unbilled hours at the project rate plus billable
   * unbilled expenses. Cost values ALL hours at the project rate (internal
   * labour valuation) plus ALL expenses.
   */
  async profitability(client: PoolClient, projectId: string) {
    const p = await client.query(
      `SELECT budget_cents, hourly_rate_cents FROM projects WHERE id = $1`,
      [projectId],
    );
    if (!p.rows[0]) throw new NotFoundException("Project not found");
    const budgetCents =
      p.rows[0].budget_cents === null ? null : Number(p.rows[0].budget_cents);
    const rate = Number(p.rows[0].hourly_rate_cents ?? 0);

    const t = await client.query(
      `SELECT coalesce(sum(hours), 0)::numeric AS hours,
              coalesce(sum(round(hours * $2::bigint)), 0)::bigint AS labor_cost_cents,
              coalesce(sum(round(hours * $2::bigint))
                FILTER (WHERE billable AND billed_invoice_id IS NULL), 0)::bigint
                AS unbilled_time_cents
       FROM project_time_entries WHERE project_id = $1`,
      [projectId, rate],
    );
    const e = await client.query(
      `SELECT coalesce(sum(amount_cents), 0)::bigint AS expense_cents,
              coalesce(sum(amount_cents)
                FILTER (WHERE billable AND billed_invoice_id IS NULL), 0)::bigint
                AS unbilled_expense_cents
       FROM project_expenses WHERE project_id = $1`,
      [projectId],
    );
    const billed = await client.query(
      `SELECT coalesce(sum(subtotal_cents), 0)::bigint AS billed_cents
       FROM invoices WHERE id IN (
         SELECT billed_invoice_id FROM project_time_entries
         WHERE project_id = $1 AND billed_invoice_id IS NOT NULL
         UNION
         SELECT billed_invoice_id FROM project_expenses
         WHERE project_id = $1 AND billed_invoice_id IS NOT NULL
       )`,
      [projectId],
    );

    const laborCostCents = Number(t.rows[0].labor_cost_cents);
    const expenseCents = Number(e.rows[0].expense_cents);
    const billedCents = Number(billed.rows[0].billed_cents);
    const unbilledCents =
      Number(t.rows[0].unbilled_time_cents) +
      Number(e.rows[0].unbilled_expense_cents);
    const costCents = laborCostCents + expenseCents;
    const revenueCents = billedCents + unbilledCents;
    const marginCents = revenueCents - costCents;
    const marginPct =
      revenueCents > 0 ? Math.round((marginCents / revenueCents) * 1000) / 10 : 0;
    const budgetUsedPct =
      budgetCents && budgetCents > 0
        ? Math.round((costCents / budgetCents) * 1000) / 10
        : null;

    return {
      budgetCents,
      hourlyRateCents: rate,
      hours: Number(t.rows[0].hours),
      billedCents,
      unbilledCents,
      laborCostCents,
      expenseCents,
      costCents,
      marginCents,
      marginPct,
      budgetUsedPct,
    };
  }

  // ---- Billing -----------------------------------------------------------------

  /**
   * Bill ALL billable unbilled time and expenses onto one DRAFT invoice
   * (InvoicesService.createDraft — the single drafting path; DR AR / CR
   * Sales posts only when the invoice is issued). Time is priced at the
   * project hourly rate; entries and expenses are stamped with
   * billed_invoice_id in the same transaction, and FOR UPDATE locks make
   * concurrent bill calls serialize instead of double-billing.
   */
  async billUnbilled(
    client: PoolClient,
    args: {
      tenantId: string;
      userId: string;
      projectId: string;
      branchId: string;
      dueDate?: string;
    },
  ): Promise<{
    invoiceId: string;
    timeEntries: number;
    expenses: number;
    subtotalCents: number;
  }> {
    if (!args.branchId) throw new BadRequestException("branchId is required");
    const p = await client.query(
      `SELECT id, name, customer_id, hourly_rate_cents
       FROM projects WHERE id = $1 FOR UPDATE`,
      [args.projectId],
    );
    if (!p.rows[0]) throw new NotFoundException("Project not found");
    const proj = p.rows[0];
    if (!proj.customer_id) {
      throw new BadRequestException(
        "Project has no customer — assign a customer before billing",
      );
    }
    const rate = Number(proj.hourly_rate_cents ?? 0);

    const time = await client.query(
      `SELECT id, entry_date, hours, note FROM project_time_entries
       WHERE project_id = $1 AND billable AND billed_invoice_id IS NULL
       ORDER BY entry_date, created_at
       FOR UPDATE`,
      [args.projectId],
    );
    const expenses = await client.query(
      `SELECT id, expense_date, description, amount_cents FROM project_expenses
       WHERE project_id = $1 AND billable AND billed_invoice_id IS NULL
       ORDER BY expense_date, created_at
       FOR UPDATE`,
      [args.projectId],
    );
    if (!time.rows.length && !expenses.rows.length) {
      throw new BadRequestException(
        "Nothing to bill — no billable unbilled time or expenses",
      );
    }

    const lines: InvoiceLineInput[] = [
      ...time.rows.map((r) => ({
        description: `${isoDate(r.entry_date)} — ${
          String(r.note ?? "").trim() || "Time"
        } (${Number(r.hours)}h)`.slice(0, DESC_MAX),
        quantity: Number(r.hours),
        unitPriceCents: rate,
        vatRate: "0.16" as const,
      })),
      ...expenses.rows.map((r) => ({
        description: `${isoDate(r.expense_date)} — ${r.description}`.slice(
          0,
          DESC_MAX,
        ),
        quantity: 1,
        unitPriceCents: Number(r.amount_cents),
        vatRate: "0.16" as const,
      })),
    ];

    const { id: invoiceId } = await this.invoices.createDraft(client, {
      tenantId: args.tenantId,
      userId: args.userId,
      branchId: args.branchId,
      customerId: proj.customer_id,
      dueDate: args.dueDate,
      lines,
    });

    if (time.rows.length) {
      await client.query(
        `UPDATE project_time_entries SET billed_invoice_id = $2
         WHERE project_id = $1 AND id = ANY($3)`,
        [args.projectId, invoiceId, time.rows.map((r) => r.id)],
      );
    }
    if (expenses.rows.length) {
      await client.query(
        `UPDATE project_expenses SET billed_invoice_id = $2
         WHERE project_id = $1 AND id = ANY($3)`,
        [args.projectId, invoiceId, expenses.rows.map((r) => r.id)],
      );
    }

    const subtotalCents = lines.reduce(
      (s, l) => s + this.invoices.computeLine(l).totalCents,
      0,
    );
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "project.billed",
      entityType: "invoice",
      entityId: invoiceId,
      payload: {
        projectId: args.projectId,
        timeEntries: time.rows.length,
        expenses: expenses.rows.length,
        subtotalCents,
      },
    });
    return {
      invoiceId,
      timeEntries: time.rows.length,
      expenses: expenses.rows.length,
      subtotalCents,
    };
  }

  // ---- Tasks -----------------------------------------------------------------

  async listTasks(client: PoolClient, projectId: string) {
    await this.requireProject(client, projectId);
    const res = await client.query(
      `SELECT tk.id, tk.project_id, tk.title, tk.description, tk.status,
              tk.priority, tk.assignee_employee_id, e.full_name AS assignee_name,
              tk.due_date, tk.estimate_hours::numeric AS estimate_hours,
              tk.sort_order, tk.completed_at, tk.created_at
       FROM project_tasks tk
       LEFT JOIN employees e ON e.id = tk.assignee_employee_id
       WHERE tk.project_id = $1
       ORDER BY tk.status, tk.sort_order, tk.created_at
       LIMIT 1000`,
      [projectId],
    );
    return res.rows;
  }

  async createTask(
    client: PoolClient,
    args: {
      tenantId: string;
      userId: string;
      projectId: string;
      title: string;
      description?: string;
      status?: string;
      priority?: string;
      assigneeEmployeeId?: string | null;
      dueDate?: string | null;
      estimateHours?: number | null;
      sortOrder?: number;
    },
  ) {
    await this.requireProject(client, args.projectId);
    const title = args.title?.trim();
    if (!title) throw new BadRequestException("title is required");
    const status = this.requireTaskStatus(args.status ?? "todo");
    const priority = this.requireTaskPriority(args.priority ?? "medium");
    const dueDate = optionalDate(args.dueDate, "dueDate");
    const estimate = optionalEstimate(args.estimateHours);
    let assignee: string | null = null;
    if (args.assigneeEmployeeId) {
      assignee = args.assigneeEmployeeId;
      await this.requireEmployee(client, assignee);
    }
    const sortOrder = Number.isInteger(args.sortOrder) ? args.sortOrder! : 0;
    const res = await client.query(
      `INSERT INTO project_tasks
         (tenant_id, project_id, title, description, status, priority,
          assignee_employee_id, due_date, estimate_hours, sort_order,
          created_by, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
               CASE WHEN $5 = 'done' THEN now() ELSE NULL END)
       RETURNING id, project_id, title, description, status, priority,
                 assignee_employee_id, due_date, estimate_hours::numeric AS estimate_hours,
                 sort_order, completed_at, created_at`,
      [
        args.tenantId,
        args.projectId,
        title,
        args.description?.trim() ?? "",
        status,
        priority,
        assignee,
        dueDate,
        estimate,
        sortOrder,
        args.userId,
      ],
    );
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "project.task_created",
      entityType: "project_task",
      entityId: res.rows[0].id,
      payload: { projectId: args.projectId, title },
    });
    return res.rows[0];
  }

  /**
   * Patch a task; every field coalesces (undefined leaves it as-is). Moving
   * status to 'done' stamps completed_at; moving it off 'done' clears it.
   */
  async updateTask(
    client: PoolClient,
    args: {
      tenantId: string;
      userId: string;
      projectId: string;
      taskId: string;
      title?: string;
      description?: string;
      status?: string;
      priority?: string;
      assigneeEmployeeId?: string | null;
      dueDate?: string | null;
      estimateHours?: number | null;
      sortOrder?: number;
    },
  ) {
    const cur = await client.query(
      `SELECT id, title, description, status, priority, assignee_employee_id,
              due_date, estimate_hours, sort_order, completed_at
       FROM project_tasks WHERE id = $1 AND project_id = $2 FOR UPDATE`,
      [args.taskId, args.projectId],
    );
    if (!cur.rows[0]) throw new NotFoundException("Task not found");
    const row = cur.rows[0];

    const title = args.title === undefined ? row.title : args.title.trim();
    if (!title) throw new BadRequestException("title cannot be empty");
    const description =
      args.description === undefined ? row.description : args.description.trim();
    const status =
      args.status === undefined
        ? (row.status as TaskStatus)
        : this.requireTaskStatus(args.status);
    const priority =
      args.priority === undefined
        ? (row.priority as TaskPriority)
        : this.requireTaskPriority(args.priority);
    let assignee: string | null = row.assignee_employee_id;
    if (args.assigneeEmployeeId !== undefined) {
      assignee = args.assigneeEmployeeId || null;
      if (assignee) await this.requireEmployee(client, assignee);
    }
    const dueDate =
      args.dueDate === undefined
        ? (row.due_date === null ? null : isoDate(row.due_date))
        : optionalDate(args.dueDate, "dueDate");
    const estimate =
      args.estimateHours === undefined
        ? (row.estimate_hours === null ? null : Number(row.estimate_hours))
        : optionalEstimate(args.estimateHours);
    const sortOrder = Number.isInteger(args.sortOrder)
      ? args.sortOrder!
      : row.sort_order;

    const res = await client.query(
      `UPDATE project_tasks
       SET title = $2, description = $3, status = $4, priority = $5,
           assignee_employee_id = $6, due_date = $7, estimate_hours = $8,
           sort_order = $9,
           completed_at = CASE
             WHEN $4 = 'done' AND completed_at IS NULL THEN now()
             WHEN $4 <> 'done' THEN NULL
             ELSE completed_at END
       WHERE id = $1
       RETURNING id, project_id, title, description, status, priority,
                 assignee_employee_id, due_date,
                 estimate_hours::numeric AS estimate_hours, sort_order,
                 completed_at, created_at`,
      [
        args.taskId,
        title,
        description,
        status,
        priority,
        assignee,
        dueDate,
        estimate,
        sortOrder,
      ],
    );
    return res.rows[0];
  }

  async deleteTask(
    client: PoolClient,
    args: { tenantId: string; userId: string; projectId: string; taskId: string },
  ): Promise<{ deleted: true }> {
    const cur = await client.query(
      "SELECT id FROM project_tasks WHERE id = $1 AND project_id = $2 FOR UPDATE",
      [args.taskId, args.projectId],
    );
    if (!cur.rows[0]) throw new NotFoundException("Task not found");
    await client.query("DELETE FROM project_tasks WHERE id = $1", [args.taskId]);
    return { deleted: true };
  }

  /**
   * Cross-project task list ("my work"): every task in the tenant, optionally
   * filtered by assignee employee and/or status, carrying its project name so
   * the caller can group by status without a second round-trip.
   */
  async listMyTasks(
    client: PoolClient,
    args: { assigneeEmployeeId?: string | null; status?: string | null },
  ) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (args.assigneeEmployeeId) {
      params.push(args.assigneeEmployeeId);
      where.push(`tk.assignee_employee_id = $${params.length}`);
    }
    if (args.status) {
      const status = this.requireTaskStatus(args.status);
      params.push(status);
      where.push(`tk.status = $${params.length}`);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const res = await client.query(
      `SELECT tk.id, tk.project_id, p.name AS project_name, tk.title,
              tk.status, tk.priority, tk.assignee_employee_id,
              e.full_name AS assignee_name, tk.due_date,
              tk.estimate_hours::numeric AS estimate_hours, tk.completed_at
       FROM project_tasks tk
       JOIN projects p ON p.id = tk.project_id
       LEFT JOIN employees e ON e.id = tk.assignee_employee_id
       ${clause}
       ORDER BY (tk.status = 'done'),
                (tk.due_date IS NULL), tk.due_date,
                CASE tk.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                p.name
       LIMIT 500`,
      params,
    );
    return res.rows;
  }

  // ---- Milestones ------------------------------------------------------------

  async listMilestones(client: PoolClient, projectId: string) {
    await this.requireProject(client, projectId);
    const res = await client.query(
      `SELECT id, project_id, name, due_date, status, reached_at, created_at
       FROM project_milestones
       WHERE project_id = $1
       ORDER BY (due_date IS NULL), due_date, created_at
       LIMIT 500`,
      [projectId],
    );
    return res.rows;
  }

  async createMilestone(
    client: PoolClient,
    args: {
      tenantId: string;
      userId: string;
      projectId: string;
      name: string;
      dueDate?: string | null;
    },
  ) {
    await this.requireProject(client, args.projectId);
    const name = args.name?.trim();
    if (!name) throw new BadRequestException("name is required");
    const dueDate = optionalDate(args.dueDate, "dueDate");
    const res = await client.query(
      `INSERT INTO project_milestones
         (tenant_id, project_id, name, due_date, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, project_id, name, due_date, status, reached_at, created_at`,
      [args.tenantId, args.projectId, name, dueDate, args.userId],
    );
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "project.milestone_created",
      entityType: "project_milestone",
      entityId: res.rows[0].id,
      payload: { projectId: args.projectId, name },
    });
    return res.rows[0];
  }

  /** Patch a milestone; marking status 'reached' stamps reached_at, 'open' clears it. */
  async updateMilestone(
    client: PoolClient,
    args: {
      tenantId: string;
      userId: string;
      projectId: string;
      milestoneId: string;
      name?: string;
      dueDate?: string | null;
      status?: string;
    },
  ) {
    const cur = await client.query(
      `SELECT id, name, due_date, status, reached_at
       FROM project_milestones WHERE id = $1 AND project_id = $2 FOR UPDATE`,
      [args.milestoneId, args.projectId],
    );
    if (!cur.rows[0]) throw new NotFoundException("Milestone not found");
    const row = cur.rows[0];
    const name = args.name === undefined ? row.name : args.name.trim();
    if (!name) throw new BadRequestException("name cannot be empty");
    let status = row.status as (typeof MILESTONE_STATUSES)[number];
    if (args.status !== undefined) {
      if (!MILESTONE_STATUSES.includes(args.status as typeof status)) {
        throw new BadRequestException("status must be open | reached");
      }
      status = args.status as typeof status;
    }
    const dueDate =
      args.dueDate === undefined
        ? (row.due_date === null ? null : isoDate(row.due_date))
        : optionalDate(args.dueDate, "dueDate");
    const res = await client.query(
      `UPDATE project_milestones
       SET name = $2, due_date = $3, status = $4,
           reached_at = CASE
             WHEN $4 = 'reached' AND reached_at IS NULL THEN now()
             WHEN $4 = 'open' THEN NULL
             ELSE reached_at END
       WHERE id = $1
       RETURNING id, project_id, name, due_date, status, reached_at, created_at`,
      [args.milestoneId, name, dueDate, status],
    );
    return res.rows[0];
  }

  async deleteMilestone(
    client: PoolClient,
    args: {
      tenantId: string;
      userId: string;
      projectId: string;
      milestoneId: string;
    },
  ): Promise<{ deleted: true }> {
    const cur = await client.query(
      "SELECT id FROM project_milestones WHERE id = $1 AND project_id = $2 FOR UPDATE",
      [args.milestoneId, args.projectId],
    );
    if (!cur.rows[0]) throw new NotFoundException("Milestone not found");
    await client.query("DELETE FROM project_milestones WHERE id = $1", [
      args.milestoneId,
    ]);
    return { deleted: true };
  }

  // ---- Delivery summary ------------------------------------------------------

  /**
   * At-a-glance delivery rollup for a project: task counts by status,
   * % complete (done / total tasks), milestone progress (reached / total),
   * hours logged vs the sum of task estimates, and budget consumption
   * (cost cents / budget cents) reusing the profitability cost basis.
   */
  async summary(client: PoolClient, projectId: string) {
    await this.requireProject(client, projectId);
    const tasks = await client.query(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE status = 'todo')::int AS todo,
         count(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
         count(*) FILTER (WHERE status = 'blocked')::int AS blocked,
         count(*) FILTER (WHERE status = 'done')::int AS done,
         coalesce(sum(estimate_hours), 0)::numeric AS estimate_hours
       FROM project_tasks WHERE project_id = $1`,
      [projectId],
    );
    const milestones = await client.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'reached')::int AS reached
       FROM project_milestones WHERE project_id = $1`,
      [projectId],
    );
    const profit = await this.profitability(client, projectId);
    const t = tasks.rows[0];
    const m = milestones.rows[0];
    const totalTasks = Number(t.total);
    const doneTasks = Number(t.done);
    const totalMilestones = Number(m.total);
    const reachedMilestones = Number(m.reached);
    const pctComplete =
      totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 1000) / 10 : 0;
    const milestonePct =
      totalMilestones > 0
        ? Math.round((reachedMilestones / totalMilestones) * 1000) / 10
        : 0;
    return {
      tasks: {
        total: totalTasks,
        todo: Number(t.todo),
        in_progress: Number(t.in_progress),
        blocked: Number(t.blocked),
        done: doneTasks,
        pctComplete,
        estimateHours: Number(t.estimate_hours),
      },
      milestones: {
        total: totalMilestones,
        reached: reachedMilestones,
        pct: milestonePct,
      },
      hoursLogged: profit.hours,
      estimateHours: Number(t.estimate_hours),
      budgetCents: profit.budgetCents,
      costCents: profit.costCents,
      budgetUsedPct: profit.budgetUsedPct,
    };
  }

  // ---- helpers ---------------------------------------------------------------

  private requireTaskStatus(value: string): TaskStatus {
    if (!TASK_STATUSES.includes(value as TaskStatus)) {
      throw new BadRequestException(
        "status must be todo | in_progress | blocked | done",
      );
    }
    return value as TaskStatus;
  }

  private requireTaskPriority(value: string): TaskPriority {
    if (!TASK_PRIORITIES.includes(value as TaskPriority)) {
      throw new BadRequestException("priority must be low | medium | high");
    }
    return value as TaskPriority;
  }

  private async requireProject(client: PoolClient, projectId: string) {
    const res = await client.query("SELECT id FROM projects WHERE id = $1", [
      projectId,
    ]);
    if (!res.rows[0]) throw new NotFoundException("Project not found");
  }

  private async requireCustomer(client: PoolClient, customerId: string) {
    const res = await client.query("SELECT id FROM customers WHERE id = $1", [
      customerId,
    ]);
    if (!res.rows[0]) throw new BadRequestException("Unknown customerId");
  }

  private async requireEmployee(client: PoolClient, employeeId: string) {
    const res = await client.query("SELECT id FROM employees WHERE id = $1", [
      employeeId,
    ]);
    if (!res.rows[0]) throw new BadRequestException("Unknown employeeId");
  }
}
