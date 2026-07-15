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
import { LedgerService } from "../ledger/ledger.service";

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Straight-line depreciation posting accounts (DEFAULT_ACCOUNTS). */
const DEPRECIATION_EXPENSE = "6200";
const ACCUMULATED_DEPRECIATION = "1500";

export interface BudgetInput {
  accountCode: string;
  fiscalYear: number;
  /** 1-12 for a monthly amount; 0 (default) for an annual lump amount. */
  month?: number;
  amountCents: number;
}

function isoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/** Advance an ISO date exactly one month, clamping to the shorter month. */
export function addOneMonth(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  // m is 1-based; target month index is m (0-based), Date.UTC(y, m + 1, 0)
  // is that month's last day.
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, lastDay)))
    .toISOString()
    .slice(0, 10);
}

/**
 * Finance+ domain: budgets + budget-vs-actual off the journal, a
 * fixed-asset register with straight-line monthly depreciation posted
 * through LedgerService (idempotent per asset per period), and recurring
 * invoice templates that draft through InvoicesService. All methods run
 * inside the caller's withTenant transaction — RLS scopes every query.
 */
@Injectable()
export class FinanceService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly invoices: InvoicesService,
    private readonly audit: AuditService,
  ) {}

  // ---- Budgets -----------------------------------------------------------

  async upsertBudgets(
    client: PoolClient,
    args: { tenantId: string; userId: string; entries: BudgetInput[] },
  ): Promise<{ upserted: number }> {
    if (!args.entries.length || args.entries.length > 200) {
      throw new BadRequestException("entries must contain 1-200 budget rows");
    }
    for (const e of args.entries) {
      const month = e.month ?? 0;
      if (
        !e.accountCode?.trim() ||
        !Number.isInteger(e.fiscalYear) ||
        e.fiscalYear < 2000 ||
        e.fiscalYear > 2100 ||
        !Number.isInteger(month) ||
        month < 0 ||
        month > 12 ||
        !Number.isInteger(e.amountCents) ||
        e.amountCents < 0
      ) {
        throw new BadRequestException(
          "each entry needs accountCode, fiscalYear, month 0-12 and non-negative integer amountCents",
        );
      }
    }
    // Budgets only make sense on P&L accounts.
    const codes = [...new Set(args.entries.map((e) => e.accountCode.trim()))];
    const known = await client.query(
      `SELECT code FROM accounts
       WHERE code = ANY($1) AND type IN ('income', 'expense')`,
      [codes],
    );
    const ok = new Set(known.rows.map((r: { code: string }) => r.code));
    for (const code of codes) {
      if (!ok.has(code)) {
        throw new BadRequestException(
          `Unknown or non-P&L account code: ${code}`,
        );
      }
    }
    let upserted = 0;
    for (const e of args.entries) {
      const res = await client.query(
        `INSERT INTO budgets (tenant_id, account_code, fiscal_year, month, amount_cents)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, account_code, fiscal_year, month)
         DO UPDATE SET amount_cents = EXCLUDED.amount_cents, updated_at = now()`,
        [
          args.tenantId,
          e.accountCode.trim(),
          e.fiscalYear,
          e.month ?? 0,
          e.amountCents,
        ],
      );
      upserted += res.rowCount ?? 0;
    }
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "budget.upserted",
      entityType: "budget",
      payload: { count: upserted },
    });
    return { upserted };
  }

  async listBudgets(client: PoolClient, year: number) {
    const res = await client.query(
      `SELECT b.id, b.account_code, a.name AS account_name, b.fiscal_year,
              b.month, b.amount_cents::bigint AS amount_cents
       FROM budgets b
       LEFT JOIN accounts a ON a.code = b.account_code
       WHERE b.fiscal_year = $1
       ORDER BY b.account_code, b.month
       LIMIT 500`,
      [year],
    );
    return res.rows;
  }

  async deleteBudget(
    client: PoolClient,
    args: { tenantId: string; userId: string; budgetId: string },
  ): Promise<{ deleted: true }> {
    const res = await client.query(
      "DELETE FROM budgets WHERE id = $1 RETURNING id, account_code, fiscal_year, month",
      [args.budgetId],
    );
    if (!res.rows[0]) throw new NotFoundException("Budget row not found");
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "budget.deleted",
      entityType: "budget",
      entityId: args.budgetId,
      payload: {
        accountCode: res.rows[0].account_code,
        fiscalYear: Number(res.rows[0].fiscal_year),
        month: Number(res.rows[0].month),
      },
    });
    return { deleted: true };
  }

  /**
   * Budget vs actual for a calendar year: budgets (monthly rows + annual
   * lumps summed per account) against P&L actuals from the journal.
   * variance = actual - budget for every row; the UI colours income
   * over-budget and expense under-budget as favourable.
   */
  async budgetVsActual(client: PoolClient, year: number) {
    const res = await client.query(
      `WITH budget AS (
         SELECT account_code AS code, sum(amount_cents)::bigint AS budget_cents
         FROM budgets WHERE fiscal_year = $1
         GROUP BY account_code
       ),
       actual AS (
         SELECT a.code,
                sum(CASE WHEN a.type = 'income'
                         THEN jl.credit_cents - jl.debit_cents
                         ELSE jl.debit_cents - jl.credit_cents END)::bigint
                  AS actual_cents
         FROM journal_lines jl
         JOIN accounts a ON a.id = jl.account_id
         JOIN journal_entries je ON je.id = jl.entry_id
         WHERE a.type IN ('income', 'expense')
           AND je.entry_date BETWEEN $2 AND $3
         GROUP BY a.code
       )
       SELECT a.code, a.name, a.type,
              coalesce(b.budget_cents, 0)::bigint  AS budget_cents,
              coalesce(ac.actual_cents, 0)::bigint AS actual_cents,
              (coalesce(ac.actual_cents, 0) - coalesce(b.budget_cents, 0))::bigint
                AS variance_cents
       FROM accounts a
       LEFT JOIN budget b ON b.code = a.code
       LEFT JOIN actual ac ON ac.code = a.code
       WHERE a.type IN ('income', 'expense')
         AND (b.budget_cents IS NOT NULL OR coalesce(ac.actual_cents, 0) <> 0)
       ORDER BY a.type DESC, a.code`,
      [year, `${year}-01-01`, `${year}-12-31`],
    );
    const totals = {
      budgetIncomeCents: 0,
      actualIncomeCents: 0,
      budgetExpenseCents: 0,
      actualExpenseCents: 0,
    };
    for (const r of res.rows) {
      if (r.type === "income") {
        totals.budgetIncomeCents += Number(r.budget_cents);
        totals.actualIncomeCents += Number(r.actual_cents);
      } else {
        totals.budgetExpenseCents += Number(r.budget_cents);
        totals.actualExpenseCents += Number(r.actual_cents);
      }
    }
    return { year, rows: res.rows, totals };
  }

  // ---- Fixed assets ------------------------------------------------------

  async createAsset(
    client: PoolClient,
    args: {
      tenantId: string;
      userId: string;
      name: string;
      costCents: number;
      salvageCents?: number;
      acquiredDate: string;
      usefulLifeMonths: number;
    },
  ) {
    const salvage = args.salvageCents ?? 0;
    if (
      !args.name?.trim() ||
      !Number.isInteger(args.costCents) ||
      args.costCents <= 0 ||
      !Number.isInteger(salvage) ||
      salvage < 0 ||
      salvage >= args.costCents ||
      !Number.isInteger(args.usefulLifeMonths) ||
      args.usefulLifeMonths < 1 ||
      args.usefulLifeMonths > 600 ||
      !DATE_RE.test(args.acquiredDate ?? "")
    ) {
      throw new BadRequestException(
        "name, positive integer costCents, salvageCents < costCents, acquiredDate (YYYY-MM-DD) and usefulLifeMonths 1-600 are required",
      );
    }
    const res = await client.query(
      `INSERT INTO fixed_assets
         (tenant_id, name, cost_cents, salvage_cents, acquired_date,
          useful_life_months, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, cost_cents, salvage_cents, acquired_date,
                 useful_life_months, disposed, created_at`,
      [
        args.tenantId,
        args.name.trim(),
        args.costCents,
        salvage,
        args.acquiredDate,
        args.usefulLifeMonths,
        args.userId,
      ],
    );
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "asset.created",
      entityType: "fixed_asset",
      entityId: res.rows[0].id,
      payload: { name: args.name.trim(), costCents: args.costCents },
    });
    return res.rows[0];
  }

  /** Register with live accumulated depreciation off the journal. */
  async listAssets(client: PoolClient) {
    const res = await client.query(
      `SELECT fa.id, fa.name, fa.cost_cents::bigint AS cost_cents,
              fa.salvage_cents::bigint AS salvage_cents, fa.acquired_date,
              fa.useful_life_months, fa.disposed, fa.created_at,
              coalesce(dep.cents, 0)::bigint AS accumulated_cents,
              (fa.cost_cents - coalesce(dep.cents, 0))::bigint AS nbv_cents
       FROM fixed_assets fa
       LEFT JOIN LATERAL (
         SELECT sum(jl.credit_cents - jl.debit_cents) AS cents
         FROM journal_entries je
         JOIN journal_lines jl ON jl.entry_id = je.id
         JOIN accounts a ON a.id = jl.account_id AND a.code = $1
         WHERE je.source_type = 'depreciation' AND je.source_id = fa.id::text
       ) dep ON true
       ORDER BY fa.acquired_date DESC, fa.created_at DESC
       LIMIT 500`,
      [ACCUMULATED_DEPRECIATION],
    );
    return res.rows;
  }

  async updateAsset(
    client: PoolClient,
    args: {
      tenantId: string;
      userId: string;
      assetId: string;
      name?: string;
      disposed?: boolean;
    },
  ) {
    const res = await client.query(
      `UPDATE fixed_assets
       SET name = coalesce($2, name), disposed = coalesce($3, disposed)
       WHERE id = $1
       RETURNING id, name, cost_cents, salvage_cents, acquired_date,
                 useful_life_months, disposed`,
      [args.assetId, args.name?.trim() || null, args.disposed ?? null],
    );
    if (!res.rows[0]) throw new NotFoundException("Asset not found");
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "asset.updated",
      entityType: "fixed_asset",
      entityId: args.assetId,
      payload: { name: res.rows[0].name, disposed: res.rows[0].disposed },
    });
    return res.rows[0];
  }

  /** Delete only assets the ledger has never seen — else dispose. */
  async deleteAsset(
    client: PoolClient,
    args: { tenantId: string; userId: string; assetId: string },
  ): Promise<{ deleted: true }> {
    const posted = await client.query(
      `SELECT 1 FROM journal_entries
       WHERE source_type = 'depreciation' AND source_id = $1 LIMIT 1`,
      [args.assetId],
    );
    if (posted.rows[0]) {
      throw new BadRequestException(
        "Asset has posted depreciation — mark it disposed instead of deleting",
      );
    }
    const res = await client.query(
      "DELETE FROM fixed_assets WHERE id = $1 RETURNING name",
      [args.assetId],
    );
    if (!res.rows[0]) throw new NotFoundException("Asset not found");
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "asset.deleted",
      entityType: "fixed_asset",
      entityId: args.assetId,
      payload: { name: res.rows[0].name },
    });
    return { deleted: true };
  }

  /**
   * Straight-line monthly depreciation for one period (YYYY-MM), full-month
   * convention starting in the acquisition month. Integer cents: every
   * month posts floor(base/life); the final month posts the remainder so
   * lifetime total equals cost - salvage exactly. Idempotent per asset per
   * period via the ledger key `asset:<id>:dep:<period>` — re-running a
   * period is a no-op.
   */
  async runDepreciation(
    client: PoolClient,
    args: { tenantId: string; userId: string; period: string },
  ): Promise<{ period: string; posted: number; skipped: number; totalCents: number }> {
    if (!PERIOD_RE.test(args.period ?? "")) {
      throw new BadRequestException("period must be YYYY-MM");
    }
    const [y, m] = args.period.split("-").map(Number);
    // Post on the period's last day.
    const entryDate = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const assets = await client.query(
      `SELECT id, name, cost_cents, salvage_cents, acquired_date,
              useful_life_months
       FROM fixed_assets WHERE NOT disposed
       ORDER BY acquired_date, created_at`,
    );
    let posted = 0;
    let skipped = 0;
    let totalCents = 0;
    for (const a of assets.rows) {
      const acquired = isoDate(a.acquired_date);
      const [ay, am] = acquired.split("-").map(Number);
      // 1-based month index within the schedule.
      const idx = y * 12 + m - (ay * 12 + am) + 1;
      const life = Number(a.useful_life_months);
      if (idx < 1 || idx > life) {
        skipped++;
        continue;
      }
      const base = Number(a.cost_cents) - Number(a.salvage_cents);
      const monthly = Math.floor(base / life);
      const amount = idx === life ? base - monthly * (life - 1) : monthly;
      if (amount <= 0) {
        skipped++;
        continue;
      }
      const r = await this.ledger.post(client, {
        tenantId: args.tenantId,
        postedBy: args.userId,
        entryDate,
        memo: `Depreciation ${args.period}: ${a.name} (month ${idx}/${life})`,
        sourceType: "depreciation",
        sourceId: a.id,
        idempotencyKey: `asset:${a.id}:dep:${args.period}`,
        lines: [
          { accountCode: DEPRECIATION_EXPENSE, debitCents: amount },
          { accountCode: ACCUMULATED_DEPRECIATION, creditCents: amount },
        ],
      });
      if (r.deduplicated) {
        skipped++;
        continue;
      }
      posted++;
      totalCents += amount;
    }
    if (posted > 0) {
      await this.audit.record(client, {
        tenantId: args.tenantId,
        actorUserId: args.userId,
        action: "depreciation.run",
        entityType: "fixed_asset",
        payload: { period: args.period, posted, totalCents },
      });
    }
    return { period: args.period, posted, skipped, totalCents };
  }

  // ---- Recurring invoice templates ---------------------------------------

  private validateLines(lines: InvoiceLineInput[]): void {
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new BadRequestException("lines must be a non-empty array");
    }
    for (const l of lines) {
      if (!l?.description?.trim() || !["0.16", "0", "exempt"].includes(l?.vatRate)) {
        throw new BadRequestException(
          "each line needs description and vatRate of 0.16 | 0 | exempt",
        );
      }
      this.invoices.computeLine(l); // throws on bad qty/price
    }
  }

  async createTemplate(
    client: PoolClient,
    args: {
      tenantId: string;
      userId: string;
      customerId: string;
      branchId: string;
      nextRunDate: string;
      lines: InvoiceLineInput[];
    },
  ) {
    if (
      !args.customerId ||
      !args.branchId ||
      !DATE_RE.test(args.nextRunDate ?? "")
    ) {
      throw new BadRequestException(
        "customerId, branchId and nextRunDate (YYYY-MM-DD) are required",
      );
    }
    this.validateLines(args.lines);
    const res = await client.query(
      `INSERT INTO recurring_invoice_templates
         (tenant_id, customer_id, branch_id, next_run_date, lines, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, customer_id, branch_id, cadence, next_run_date, active, created_at`,
      [
        args.tenantId,
        args.customerId,
        args.branchId,
        args.nextRunDate,
        JSON.stringify(args.lines),
        args.userId,
      ],
    );
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "recurring.created",
      entityType: "recurring_invoice_template",
      entityId: res.rows[0].id,
      payload: { nextRunDate: args.nextRunDate, lines: args.lines.length },
    });
    return res.rows[0];
  }

  async listTemplates(client: PoolClient) {
    const res = await client.query(
      `SELECT r.id, r.customer_id, c.name AS customer_name,
              r.branch_id, br.name AS branch_name,
              r.cadence, r.next_run_date, r.active, r.lines, r.created_at,
              (SELECT sum(((l->>'unitPriceCents')::bigint
                           * round((l->>'quantity')::numeric * 1000)) / 1000)
               FROM jsonb_array_elements(r.lines) l)::bigint AS subtotal_cents
       FROM recurring_invoice_templates r
       JOIN customers c ON c.id = r.customer_id
       JOIN branches br ON br.id = r.branch_id
       ORDER BY r.next_run_date, r.created_at
       LIMIT 500`,
    );
    return res.rows;
  }

  async updateTemplate(
    client: PoolClient,
    args: {
      tenantId: string;
      userId: string;
      templateId: string;
      active?: boolean;
      nextRunDate?: string;
      lines?: InvoiceLineInput[];
    },
  ) {
    if (args.nextRunDate !== undefined && !DATE_RE.test(args.nextRunDate)) {
      throw new BadRequestException("nextRunDate must be YYYY-MM-DD");
    }
    if (args.lines !== undefined) this.validateLines(args.lines);
    const res = await client.query(
      `UPDATE recurring_invoice_templates
       SET active = coalesce($2, active),
           next_run_date = coalesce($3, next_run_date),
           lines = coalesce($4, lines)
       WHERE id = $1
       RETURNING id, customer_id, branch_id, cadence, next_run_date, active`,
      [
        args.templateId,
        args.active ?? null,
        args.nextRunDate ?? null,
        args.lines === undefined ? null : JSON.stringify(args.lines),
      ],
    );
    if (!res.rows[0]) throw new NotFoundException("Template not found");
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "recurring.updated",
      entityType: "recurring_invoice_template",
      entityId: args.templateId,
      payload: { active: res.rows[0].active },
    });
    return res.rows[0];
  }

  async deleteTemplate(
    client: PoolClient,
    args: { tenantId: string; userId: string; templateId: string },
  ): Promise<{ deleted: true }> {
    const res = await client.query(
      "DELETE FROM recurring_invoice_templates WHERE id = $1 RETURNING id",
      [args.templateId],
    );
    if (!res.rows[0]) throw new NotFoundException("Template not found");
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "recurring.deleted",
      entityType: "recurring_invoice_template",
      entityId: args.templateId,
    });
    return { deleted: true };
  }

  /**
   * Draft every active template due on or before `today`, advancing
   * next_run_date one month per draft (catch-up capped at 24 periods per
   * template). The advance and the draft share the caller's transaction,
   * so a re-run in the same period finds nothing due — idempotent per
   * period. FOR UPDATE serializes concurrent runs on the same templates.
   */
  async runRecurring(
    client: PoolClient,
    args: { tenantId: string; userId: string; today?: string },
  ): Promise<{ drafted: number; templates: number }> {
    const today = args.today ?? new Date().toISOString().slice(0, 10);
    if (!DATE_RE.test(today)) {
      throw new BadRequestException("today must be YYYY-MM-DD");
    }
    const due = await client.query(
      `SELECT id, customer_id, branch_id, next_run_date, lines
       FROM recurring_invoice_templates
       WHERE active AND next_run_date <= $1
       ORDER BY next_run_date, created_at
       LIMIT 100
       FOR UPDATE`,
      [today],
    );
    let drafted = 0;
    for (const t of due.rows) {
      let runDate = isoDate(t.next_run_date);
      let runs = 0;
      while (runDate <= today && runs < 24) {
        await this.invoices.createDraft(client, {
          tenantId: args.tenantId,
          userId: args.userId,
          branchId: t.branch_id,
          customerId: t.customer_id,
          dueDate: runDate,
          lines: t.lines as InvoiceLineInput[], // jsonb parses back to InvoiceLineInput[]
        });
        runDate = addOneMonth(runDate);
        runs++;
        drafted++;
      }
      await client.query(
        "UPDATE recurring_invoice_templates SET next_run_date = $2 WHERE id = $1",
        [t.id, runDate],
      );
    }
    if (drafted > 0) {
      await this.audit.record(client, {
        tenantId: args.tenantId,
        actorUserId: args.userId,
        action: "recurring.run",
        entityType: "recurring_invoice_template",
        payload: { drafted, templates: due.rows.length },
      });
    }
    return { drafted, templates: due.rows.length };
  }
}
