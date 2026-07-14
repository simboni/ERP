import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { AuditService } from "../audit/audit.service";
import { LedgerService } from "../ledger/ledger.service";
import { RulesService } from "../rules/rules.service";
import {
  AhlRules,
  computePayroll,
  NssfRules,
  PayeRules,
  PayrollRules,
  ShifRules,
} from "./calculator";

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Last day of a YYYY-MM period, as ISO date — the as-of date for rules. */
function periodEnd(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${period}-${String(lastDay).padStart(2, "0")}`;
}

/**
 * Payroll runs: draft (recomputable preview) -> committed (posted, immutable).
 * Every figure comes from the statutory rules store resolved AS OF the
 * period end, so a February 2026 run picks up NSSF Year 4 automatically and
 * historical periods recompute under their own era's rules.
 */
@Injectable()
export class PayrollService {
  constructor(
    private readonly rules: RulesService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  async resolveRules(period: string): Promise<PayrollRules> {
    const asOf = periodEnd(period);
    const [paye, nssf, shif, ahl, nita] = await Promise.all([
      this.rules.get<PayeRules>("paye", asOf),
      this.rules.get<NssfRules>("nssf", asOf),
      this.rules.get<ShifRules>("shif", asOf),
      this.rules.get<AhlRules>("ahl", asOf),
      this.rules.get<{ perEmployeeCents: number }>("nita", asOf),
    ]);
    return { paye, nssf, shif, ahl, nitaPerEmployeeCents: nita.perEmployeeCents };
  }

  /** Create or recompute the draft run for a period. */
  async draftRun(
    client: PoolClient,
    args: { tenantId: string; userId: string; period: string },
  ): Promise<{ runId: string; employeeCount: number; netCents: number }> {
    if (!PERIOD_RE.test(args.period)) {
      throw new BadRequestException("period must be YYYY-MM");
    }
    const rules = await this.resolveRules(args.period);

    const employees = await client.query(
      `SELECT id, gross_cents FROM employees
       WHERE status = 'active' ORDER BY created_at`,
    );
    if (employees.rows.length === 0) {
      throw new BadRequestException("No active employees to run payroll for");
    }

    // One draft per period: reuse and recompute, or create.
    const existing = await client.query(
      `SELECT id, status FROM payroll_runs
       WHERE period = $1 AND status = 'draft'`,
      [args.period],
    );
    const committed = await client.query(
      `SELECT 1 FROM payroll_runs WHERE period = $1 AND status = 'committed'`,
      [args.period],
    );
    if (committed.rows[0]) {
      throw new BadRequestException(`Payroll for ${args.period} is already committed`);
    }
    let runId: string;
    if (existing.rows[0]) {
      runId = existing.rows[0].id;
      await client.query("DELETE FROM payroll_items WHERE run_id = $1", [runId]);
    } else {
      const created = await client.query(
        `INSERT INTO payroll_runs (tenant_id, period, created_by)
         VALUES ($1, $2, $3) RETURNING id`,
        [args.tenantId, args.period, args.userId],
      );
      runId = created.rows[0].id;
    }

    const totals = {
      gross: 0, paye: 0, nssfEmp: 0, nssfEr: 0, shif: 0,
      ahlEmp: 0, ahlEr: 0, nita: 0, net: 0,
    };
    for (const emp of employees.rows as { id: string; gross_cents: string }[]) {
      const r = computePayroll(Number(emp.gross_cents), rules);
      totals.gross += r.grossCents;
      totals.paye += r.payeCents;
      totals.nssfEmp += r.nssfEmployeeCents;
      totals.nssfEr += r.nssfEmployerCents;
      totals.shif += r.shifCents;
      totals.ahlEmp += r.ahlEmployeeCents;
      totals.ahlEr += r.ahlEmployerCents;
      totals.nita += r.nitaEmployerCents;
      totals.net += r.netCents;
      await client.query(
        `INSERT INTO payroll_items
           (tenant_id, run_id, employee_id, gross_cents, taxable_cents,
            paye_cents, nssf_emp_cents, nssf_er_cents, shif_cents,
            ahl_emp_cents, ahl_er_cents, nita_cents, net_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          args.tenantId, runId, emp.id, r.grossCents, r.taxableCents,
          r.payeCents, r.nssfEmployeeCents, r.nssfEmployerCents, r.shifCents,
          r.ahlEmployeeCents, r.ahlEmployerCents, r.nitaEmployerCents, r.netCents,
        ],
      );
    }
    await client.query(
      `UPDATE payroll_runs SET
         employee_count = $2, gross_cents = $3, paye_cents = $4,
         nssf_emp_cents = $5, nssf_er_cents = $6, shif_cents = $7,
         ahl_emp_cents = $8, ahl_er_cents = $9, nita_cents = $10, net_cents = $11
       WHERE id = $1`,
      [
        runId, employees.rows.length, totals.gross, totals.paye,
        totals.nssfEmp, totals.nssfEr, totals.shif,
        totals.ahlEmp, totals.ahlEr, totals.nita, totals.net,
      ],
    );
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "payroll.drafted",
      entityType: "payroll_run",
      entityId: runId,
      payload: { period: args.period, employees: employees.rows.length, netCents: totals.net },
    });
    return { runId, employeeCount: employees.rows.length, netCents: totals.net };
  }

  /**
   * Commit: post the run to the ledger and freeze it.
   * DR Salaries & Wages (gross + employer contributions)
   * CR Statutory Payables (PAYE + NSSF both sides + SHIF + AHL both + NITA)
   * CR Wages Payable (net)
   */
  async commit(
    client: PoolClient,
    args: { tenantId: string; userId: string; runId: string },
  ): Promise<{ journalEntryId: string }> {
    const runRes = await client.query(
      `SELECT * FROM payroll_runs WHERE id = $1 FOR UPDATE`,
      [args.runId],
    );
    const run = runRes.rows[0];
    if (!run) throw new NotFoundException("Payroll run not found");
    if (run.status !== "draft") {
      throw new BadRequestException("Only draft runs can be committed");
    }
    const n = (v: string | number): number => Number(v);
    const employerCost =
      n(run.gross_cents) + n(run.nssf_er_cents) + n(run.ahl_er_cents) + n(run.nita_cents);
    const statutory =
      n(run.paye_cents) + n(run.nssf_emp_cents) + n(run.nssf_er_cents) +
      n(run.shif_cents) + n(run.ahl_emp_cents) + n(run.ahl_er_cents) + n(run.nita_cents);

    const posting = await this.ledger.post(client, {
      tenantId: args.tenantId,
      postedBy: args.userId,
      entryDate: periodEnd(run.period),
      memo: `Payroll ${run.period}`,
      sourceType: "payroll",
      sourceId: args.runId,
      idempotencyKey: `payroll:${args.runId}`,
      lines: [
        { accountCode: "6100", debitCents: employerCost, memo: `Payroll ${run.period}` },
        { accountCode: "2300", creditCents: statutory, memo: "Statutory deductions" },
        { accountCode: "2310", creditCents: n(run.net_cents), memo: "Net wages" },
      ],
    });
    await client.query(
      `UPDATE payroll_runs
       SET status = 'committed', journal_entry_id = $2, committed_at = now()
       WHERE id = $1`,
      [args.runId, posting.entryId],
    );
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "payroll.committed",
      entityType: "payroll_run",
      entityId: args.runId,
      payload: { period: run.period, netCents: n(run.net_cents) },
    });
    return { journalEntryId: posting.entryId };
  }
}
