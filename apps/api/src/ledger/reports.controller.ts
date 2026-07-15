import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from "@nestjs/common";
import type { TenantTokenClaims } from "@jenga/shared";
import {
  JwtAuthGuard,
  Roles,
  RolesGuard,
  TenantClaims,
  TenantContextGuard,
} from "../auth/guards";
import { DbService } from "../db/db.service";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REPORT_ROLES = ["owner", "admin", "accountant"] as const;

function requireDate(value: string | undefined, name: string): string {
  if (!value || !DATE_RE.test(value)) {
    throw new BadRequestException(`${name} must be YYYY-MM-DD`);
  }
  return value;
}

/**
 * Financial statements straight off the journal (debit-positive balances):
 * income statement over a period, balance sheet as of a date (with the
 * period's earnings folded into equity so it balances), and a per-account
 * ledger drill-down with running balance.
 */
@Controller("tenants/current/reports")
@UseGuards(JwtAuthGuard, TenantContextGuard, RolesGuard)
export class ReportsController {
  constructor(private readonly db: DbService) {}

  @Get("pnl")
  @Roles(...REPORT_ROLES)
  async pnl(
    @TenantClaims() claims: TenantTokenClaims,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const f = requireDate(from, "from");
    const t = requireDate(to, "to");
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT a.code, a.name, a.type,
                sum(CASE WHEN a.type = 'income'
                         THEN jl.credit_cents - jl.debit_cents
                         ELSE jl.debit_cents - jl.credit_cents END)::bigint
                  AS amount_cents
         FROM journal_lines jl
         JOIN accounts a ON a.id = jl.account_id
         JOIN journal_entries je ON je.id = jl.entry_id
         WHERE a.type IN ('income', 'expense')
           AND je.entry_date BETWEEN $1 AND $2
         GROUP BY a.id
         HAVING sum(jl.debit_cents - jl.credit_cents) <> 0
         ORDER BY a.type DESC, a.code`,
        [f, t],
      );
      const income = res.rows.filter((r) => r.type === "income");
      const expenses = res.rows.filter((r) => r.type === "expense");
      const totalIncome = income.reduce(
        (s, r) => s + Number(r.amount_cents),
        0,
      );
      const totalExpenses = expenses.reduce(
        (s, r) => s + Number(r.amount_cents),
        0,
      );
      return {
        from: f,
        to: t,
        income,
        expenses,
        totalIncomeCents: totalIncome,
        totalExpensesCents: totalExpenses,
        netProfitCents: totalIncome - totalExpenses,
      };
    });
  }

  @Get("balance-sheet")
  @Roles(...REPORT_ROLES)
  async balanceSheet(
    @TenantClaims() claims: TenantTokenClaims,
    @Query("asOf") asOf?: string,
  ) {
    const d = requireDate(asOf, "asOf");
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT a.code, a.name, a.type,
                sum(CASE WHEN a.type = 'asset'
                         THEN jl.debit_cents - jl.credit_cents
                         ELSE jl.credit_cents - jl.debit_cents END)::bigint
                  AS amount_cents
         FROM journal_lines jl
         JOIN accounts a ON a.id = jl.account_id
         JOIN journal_entries je ON je.id = jl.entry_id
         WHERE je.entry_date <= $1
         GROUP BY a.id
         HAVING sum(jl.debit_cents - jl.credit_cents) <> 0
         ORDER BY a.code`,
        [d],
      );
      const assets = res.rows.filter((r) => r.type === "asset");
      const liabilities = res.rows.filter((r) => r.type === "liability");
      const equity = res.rows.filter((r) => r.type === "equity");
      // Income/expense balances to date fold into equity as earnings.
      const earnings = res.rows
        .filter((r) => r.type === "income" || r.type === "expense")
        .reduce(
          (s, r) =>
            s +
            (r.type === "income"
              ? Number(r.amount_cents)
              : -Number(r.amount_cents)),
          0,
        );
      const sum = (rows: { amount_cents: string }[]): number =>
        rows.reduce((s, r) => s + Number(r.amount_cents), 0);
      return {
        asOf: d,
        assets,
        liabilities,
        equity,
        retainedEarningsCents: earnings,
        totalAssetsCents: sum(assets),
        totalLiabilitiesCents: sum(liabilities),
        totalEquityCents: sum(equity) + earnings,
      };
    });
  }

  @Get("ledger")
  @Roles(...REPORT_ROLES)
  async accountLedger(
    @TenantClaims() claims: TenantTokenClaims,
    @Query("code") code?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    if (!code?.trim()) throw new BadRequestException("code is required");
    const f = requireDate(from, "from");
    const t = requireDate(to, "to");
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT je.entry_no, je.entry_date, je.memo, je.source_type,
                jl.debit_cents::bigint AS debit_cents,
                jl.credit_cents::bigint AS credit_cents,
                sum(jl.debit_cents - jl.credit_cents) OVER (
                  ORDER BY je.entry_date, je.entry_no, jl.id
                )::bigint AS running_cents
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         JOIN accounts a ON a.id = jl.account_id
         WHERE a.code = $1 AND je.entry_date BETWEEN $2 AND $3
         ORDER BY je.entry_date, je.entry_no, jl.id
         LIMIT 500`,
        [code.trim(), f, t],
      );
      return res.rows;
    });
  }
}
