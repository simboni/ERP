import { Controller, Get, UseGuards } from "@nestjs/common";
import type { TenantTokenClaims } from "@jenga/shared";
import {
  JwtAuthGuard,
  TenantClaims,
  TenantContextGuard,
} from "../auth/guards";
import { DbService } from "../db/db.service";

/**
 * One-round-trip dashboard summary: monthly revenue/expense series,
 * AR aging buckets, overdue invoices and out-of-stock items. Everything
 * is computed in SQL inside the tenant's RLS context.
 */
@Controller("tenants/current/dashboard")
@UseGuards(JwtAuthGuard, TenantContextGuard)
export class DashboardController {
  constructor(private readonly db: DbService) {}

  @Get()
  async summary(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const [months, aging, overdue, outOfStock] = await Promise.all([
        client.query(
          `WITH m AS (
             SELECT to_char(date_trunc('month', now()) - (i || ' months')::interval,
                    'YYYY-MM') AS month
             FROM generate_series(5, 0, -1) AS i
           ),
           rev AS (
             SELECT to_char(issue_date, 'YYYY-MM') AS month,
                    sum(total_cents)::bigint AS revenue_cents
             FROM invoices WHERE status IN ('issued', 'paid')
             GROUP BY 1
           ),
           exp AS (
             SELECT month, sum(cents)::bigint AS expense_cents FROM (
               SELECT to_char(bill_date, 'YYYY-MM') AS month, total_cents AS cents
               FROM bills WHERE status IN ('approved', 'paid')
               UNION ALL
               SELECT to_char(je.entry_date, 'YYYY-MM'),
                      (SELECT sum(jl.debit_cents) FROM journal_lines jl
                       WHERE jl.entry_id = je.id AND jl.debit_cents > 0)
               FROM journal_entries je WHERE je.source_type = 'expense'
             ) u GROUP BY 1
           )
           SELECT m.month,
                  coalesce(rev.revenue_cents, 0) AS revenue_cents,
                  coalesce(exp.expense_cents, 0) AS expense_cents
           FROM m
           LEFT JOIN rev USING (month)
           LEFT JOIN exp USING (month)
           ORDER BY m.month`,
        ),
        client.query(
          `SELECT
             CASE
               WHEN due_date IS NULL OR due_date >= current_date THEN 'current'
               WHEN current_date - due_date <= 30 THEN 'd1_30'
               WHEN current_date - due_date <= 60 THEN 'd31_60'
               WHEN current_date - due_date <= 90 THEN 'd61_90'
               ELSE 'd90_plus'
             END AS bucket,
             sum(total_cents - coalesce(amount_paid_cents, 0))::bigint AS cents
           FROM invoices
           WHERE status = 'issued'
             AND total_cents > coalesce(amount_paid_cents, 0)
           GROUP BY 1`,
        ),
        client.query(
          `SELECT inv.id, inv.invoice_no, inv.due_date,
                  (inv.total_cents - coalesce(inv.amount_paid_cents, 0))::bigint
                    AS outstanding_cents,
                  c.name AS customer_name,
                  (current_date - inv.due_date)::int AS days_overdue
           FROM invoices inv JOIN customers c ON c.id = inv.customer_id
           WHERE inv.status = 'issued'
             AND inv.due_date < current_date
             AND inv.total_cents > coalesce(inv.amount_paid_cents, 0)
           ORDER BY inv.due_date ASC
           LIMIT 5`,
        ),
        client.query(
          `SELECT i.id, i.sku, i.name,
                  coalesce(sum(sm.qty_delta), 0)::numeric AS qty
           FROM items i
           LEFT JOIN stock_movements sm ON sm.item_id = i.id
           WHERE i.track_stock
           GROUP BY i.id
           HAVING coalesce(sum(sm.qty_delta), 0) <= 0
           ORDER BY qty ASC
           LIMIT 5`,
        ),
      ]);
      const buckets: Record<string, number> = {
        current: 0,
        d1_30: 0,
        d31_60: 0,
        d61_90: 0,
        d90_plus: 0,
      };
      for (const r of aging.rows) buckets[r.bucket] = Number(r.cents);
      return {
        months: months.rows,
        arAging: buckets,
        overdueInvoices: overdue.rows,
        outOfStock: outOfStock.rows,
      };
    });
  }
}
