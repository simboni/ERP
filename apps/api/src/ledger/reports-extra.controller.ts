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
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const REPORT_ROLES = ["owner", "admin", "accountant"] as const;

function requireDate(value: string | undefined, name: string): string {
  if (!value || !DATE_RE.test(value)) {
    throw new BadRequestException(`${name} must be YYYY-MM-DD`);
  }
  return value;
}

function requirePeriod(value: string | undefined, name: string): string {
  if (!value || !PERIOD_RE.test(value)) {
    throw new BadRequestException(`${name} must be YYYY-MM`);
  }
  return value;
}

const num = (v: unknown): number => Number(v ?? 0);

/**
 * Operational & receivables reporting that reads across the subledgers
 * (invoices, bills, payments, stock) and the journal. Everything is a
 * read-only aggregation inside the tenant's RLS context; the write paths
 * that produce this data live in their own modules.
 */
@Controller("tenants/current/reports")
@UseGuards(JwtAuthGuard, TenantContextGuard, RolesGuard)
export class ReportsExtraController {
  constructor(private readonly db: DbService) {}

  /**
   * Aged receivables: open (issued, not fully paid) invoices bucketed by
   * how long the outstanding amount has been due, one row per customer.
   * Age counts from the due date (falling back to the issue date); a
   * not-yet-due balance lands in the 0-30 bucket.
   */
  @Get("aged-receivables")
  @Roles(...REPORT_ROLES)
  async agedReceivables(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT c.id AS customer_id, c.name AS customer_name,
                coalesce(sum(o.outstanding) FILTER (WHERE o.age <= 30), 0)::bigint AS d0_30,
                coalesce(sum(o.outstanding) FILTER (WHERE o.age BETWEEN 31 AND 60), 0)::bigint AS d31_60,
                coalesce(sum(o.outstanding) FILTER (WHERE o.age BETWEEN 61 AND 90), 0)::bigint AS d61_90,
                coalesce(sum(o.outstanding) FILTER (WHERE o.age > 90), 0)::bigint AS d90_plus,
                coalesce(sum(o.outstanding), 0)::bigint AS total
         FROM (
           SELECT inv.customer_id,
                  (inv.total_cents - coalesce(inv.amount_paid_cents, 0)) AS outstanding,
                  (current_date - coalesce(inv.due_date, inv.issue_date))::int AS age
           FROM invoices inv
           WHERE inv.status = 'issued'
             AND inv.total_cents > coalesce(inv.amount_paid_cents, 0)
         ) o
         JOIN customers c ON c.id = o.customer_id
         GROUP BY c.id, c.name
         ORDER BY total DESC`,
      );
      return { rows: res.rows, totals: sumBuckets(res.rows) };
    });
  }

  /**
   * Aged payables: approved (unpaid) supplier bills bucketed by age from
   * the due date (falling back to the bill date), one row per supplier.
   */
  @Get("aged-payables")
  @Roles(...REPORT_ROLES)
  async agedPayables(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT s.id AS supplier_id, s.name AS supplier_name,
                coalesce(sum(o.outstanding) FILTER (WHERE o.age <= 30), 0)::bigint AS d0_30,
                coalesce(sum(o.outstanding) FILTER (WHERE o.age BETWEEN 31 AND 60), 0)::bigint AS d31_60,
                coalesce(sum(o.outstanding) FILTER (WHERE o.age BETWEEN 61 AND 90), 0)::bigint AS d61_90,
                coalesce(sum(o.outstanding) FILTER (WHERE o.age > 90), 0)::bigint AS d90_plus,
                coalesce(sum(o.outstanding), 0)::bigint AS total
         FROM (
           SELECT b.supplier_id,
                  b.total_cents AS outstanding,
                  (current_date - coalesce(b.due_date, b.bill_date))::int AS age
           FROM bills b
           WHERE b.status = 'approved'
             AND b.total_cents > 0
         ) o
         JOIN suppliers s ON s.id = o.supplier_id
         GROUP BY s.id, s.name
         ORDER BY total DESC`,
      );
      return { rows: res.rows, totals: sumBuckets(res.rows) };
    });
  }

  /**
   * Customer statement: every invoice charged and payment received for one
   * customer over a date range, with a running balance and an opening
   * balance rolled forward from activity before the range.
   */
  @Get("customer-statement")
  @Roles(...REPORT_ROLES)
  async customerStatement(
    @TenantClaims() claims: TenantTokenClaims,
    @Query("customerId") customerId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    if (!customerId?.trim()) {
      throw new BadRequestException("customerId is required");
    }
    const f = requireDate(from, "from");
    const t = requireDate(to, "to");
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const cust = await client.query(
        "SELECT name FROM customers WHERE id = $1",
        [customerId],
      );
      if (!cust.rows[0]) throw new BadRequestException("Customer not found");

      // All ledger-affecting activity for the customer: invoices raise the
      // balance, confirmed payments reduce it.
      const tx = await client.query(
        `SELECT d, kind, ref, description, charge_cents, payment_cents
         FROM (
           SELECT to_char(inv.issue_date, 'YYYY-MM-DD') AS d, 'invoice' AS kind, 0 AS sort,
                  'INV-' || inv.invoice_no AS ref, 'Invoice' AS description,
                  inv.total_cents::bigint AS charge_cents, 0::bigint AS payment_cents
           FROM invoices inv
           WHERE inv.customer_id = $1
             AND inv.status IN ('issued', 'paid')
             AND inv.issue_date IS NOT NULL
           UNION ALL
           SELECT to_char(coalesce(p.confirmed_at, p.created_at), 'YYYY-MM-DD') AS d,
                  'payment' AS kind, 1 AS sort,
                  coalesce(p.receipt_number, p.rail) AS ref,
                  'Payment (' || p.rail || ')' AS description,
                  0::bigint AS charge_cents, p.amount_cents::bigint AS payment_cents
           FROM payments p
           JOIN invoices inv ON inv.id = p.invoice_id
           WHERE inv.customer_id = $1 AND p.state = 'confirmed'
         ) t
         ORDER BY d, sort, ref`,
        [customerId],
      );

      let opening = 0;
      const rows: {
        d: string;
        kind: string;
        ref: string;
        description: string;
        charge_cents: number;
        payment_cents: number;
        balance_cents: number;
      }[] = [];
      let totalCharged = 0;
      let totalPaid = 0;
      let running = 0;
      for (const r of tx.rows) {
        const iso = String(r.d).slice(0, 10);
        const charge = num(r.charge_cents);
        const payment = num(r.payment_cents);
        if (iso < f) {
          opening += charge - payment;
          running = opening;
          continue;
        }
        if (iso > t) continue;
        running += charge - payment;
        totalCharged += charge;
        totalPaid += payment;
        rows.push({
          d: iso,
          kind: r.kind,
          ref: r.ref,
          description: r.description,
          charge_cents: charge,
          payment_cents: payment,
          balance_cents: running,
        });
      }
      return {
        customerId,
        customerName: cust.rows[0].name,
        from: f,
        to: t,
        openingBalanceCents: opening,
        rows,
        totalChargedCents: totalCharged,
        totalPaidCents: totalPaid,
        closingBalanceCents: opening + totalCharged - totalPaid,
      };
    });
  }

  /**
   * Inventory valuation: on-hand quantity valued at unit cost for every
   * stock-tracked item, with a low-stock flag against the reorder level.
   */
  @Get("inventory-valuation")
  @Roles(...REPORT_ROLES)
  async inventoryValuation(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT i.id AS item_id, i.sku, i.name, i.unit,
                i.cost_cents::bigint AS cost_cents,
                i.reorder_level::numeric AS reorder_level,
                coalesce(sum(sm.qty_delta), 0)::numeric AS on_hand
         FROM items i
         LEFT JOIN stock_movements sm ON sm.item_id = i.id
         WHERE i.track_stock AND i.active
         GROUP BY i.id
         ORDER BY i.sku`,
      );
      let totalValue = 0;
      const rows = res.rows.map((r) => {
        const onHand = num(r.on_hand);
        const cost = num(r.cost_cents);
        const reorder = num(r.reorder_level);
        const value = Math.round(onHand * cost);
        totalValue += value;
        return {
          item_id: r.item_id,
          sku: r.sku,
          name: r.name,
          unit: r.unit,
          cost_cents: cost,
          on_hand: onHand,
          value_cents: value,
          reorder_level: reorder,
          low_stock: reorder > 0 && onHand <= reorder,
        };
      });
      return {
        rows,
        totals: {
          items: rows.length,
          value_cents: totalValue,
          low_stock: rows.filter((r) => r.low_stock).length,
        },
      };
    });
  }

  /**
   * Expense report: expense-account movements over a period, grouped by
   * account (the expense category), debit-positive.
   */
  @Get("expenses")
  @Roles(...REPORT_ROLES)
  async expenseReport(
    @TenantClaims() claims: TenantTokenClaims,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const f = requireDate(from, "from");
    const t = requireDate(to, "to");
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT a.code, a.name,
                sum(jl.debit_cents - jl.credit_cents)::bigint AS amount_cents,
                count(DISTINCT je.id)::int AS entries
         FROM journal_lines jl
         JOIN accounts a ON a.id = jl.account_id
         JOIN journal_entries je ON je.id = jl.entry_id
         WHERE a.type = 'expense'
           AND je.entry_date BETWEEN $1 AND $2
         GROUP BY a.id
         HAVING sum(jl.debit_cents - jl.credit_cents) <> 0
         ORDER BY amount_cents DESC`,
        [f, t],
      );
      const total = res.rows.reduce((s, r) => s + num(r.amount_cents), 0);
      return { from: f, to: t, rows: res.rows, totalCents: total };
    });
  }

  /**
   * Payments received: confirmed money over a period, grouped by rail
   * (cash / bank / M-Pesa), with counts and totals.
   */
  @Get("payments-received")
  @Roles(...REPORT_ROLES)
  async paymentsReceived(
    @TenantClaims() claims: TenantTokenClaims,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const f = requireDate(from, "from");
    const t = requireDate(to, "to");
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT CASE
                  WHEN rail = 'cash' THEN 'cash'
                  WHEN rail = 'bank' THEN 'bank'
                  ELSE 'mpesa'
                END AS rail_group,
                count(*)::int AS count,
                sum(amount_cents)::bigint AS total_cents
         FROM payments
         WHERE state = 'confirmed'
           AND coalesce(confirmed_at::date, created_at::date) BETWEEN $1 AND $2
         GROUP BY 1
         ORDER BY total_cents DESC`,
        [f, t],
      );
      const totals = res.rows.reduce(
        (acc, r) => ({
          count: acc.count + num(r.count),
          total_cents: acc.total_cents + num(r.total_cents),
        }),
        { count: 0, total_cents: 0 },
      );
      return { from: f, to: t, rows: res.rows, totals };
    });
  }

  /**
   * VAT summary: a month-by-month comparison of output VAT (on sales),
   * input VAT (on eTIMS-backed purchases) and the net payable across a
   * range of periods — the trend view alongside the single-period VAT3
   * draft on the compliance page.
   */
  @Get("vat-summary")
  @Roles(...REPORT_ROLES)
  async vatSummary(
    @TenantClaims() claims: TenantTokenClaims,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const f = requirePeriod(from, "from");
    const t = requirePeriod(to, "to");
    if (t < f) throw new BadRequestException("to must not precede from");
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `WITH months AS (
           SELECT to_char(gs, 'YYYY-MM') AS period
           FROM generate_series($1::date, $2::date, interval '1 month') gs
         ),
         out AS (
           SELECT to_char(i.issue_date, 'YYYY-MM') AS period,
                  sum(il.vat_cents)::bigint AS output_vat
           FROM invoice_lines il
           JOIN invoices i ON i.id = il.invoice_id
           WHERE i.status IN ('issued', 'paid') AND il.vat_rate = '0.16'
           GROUP BY 1
         ),
         inp AS (
           SELECT to_char(bill_date, 'YYYY-MM') AS period,
                  sum(vat_cents)::bigint AS input_vat
           FROM bills
           WHERE status IN ('approved', 'paid')
             AND etims_control_number IS NOT NULL
           GROUP BY 1
         )
         SELECT m.period,
                coalesce(out.output_vat, 0)::bigint AS output_vat_cents,
                coalesce(inp.input_vat, 0)::bigint AS input_vat_cents,
                (coalesce(out.output_vat, 0) - coalesce(inp.input_vat, 0))::bigint
                  AS net_cents
         FROM months m
         LEFT JOIN out ON out.period = m.period
         LEFT JOIN inp ON inp.period = m.period
         ORDER BY m.period`,
        [`${f}-01`, `${t}-01`],
      );
      const totals = res.rows.reduce(
        (acc, r) => ({
          output_vat_cents: acc.output_vat_cents + num(r.output_vat_cents),
          input_vat_cents: acc.input_vat_cents + num(r.input_vat_cents),
          net_cents: acc.net_cents + num(r.net_cents),
        }),
        { output_vat_cents: 0, input_vat_cents: 0, net_cents: 0 },
      );
      return { from: f, to: t, rows: res.rows, totals };
    });
  }
}

interface BucketRow {
  d0_30: string | number;
  d31_60: string | number;
  d61_90: string | number;
  d90_plus: string | number;
  total: string | number;
}

interface BucketTotals {
  d0_30: number;
  d31_60: number;
  d61_90: number;
  d90_plus: number;
  total: number;
}

function sumBuckets(rows: BucketRow[]): BucketTotals {
  return rows.reduce<BucketTotals>(
    (acc, r) => ({
      d0_30: acc.d0_30 + num(r.d0_30),
      d31_60: acc.d31_60 + num(r.d31_60),
      d61_90: acc.d61_90 + num(r.d61_90),
      d90_plus: acc.d90_plus + num(r.d90_plus),
      total: acc.total + num(r.total),
    }),
    { d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0 },
  );
}
