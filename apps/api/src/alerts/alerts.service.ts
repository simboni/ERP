import { Injectable } from "@nestjs/common";
import { DbService } from "../db/db.service";
import { ComplianceService } from "../compliance/compliance.service";
import type { TenantTokenClaims } from "@jenga/shared";

export interface AlertGroup {
  /** Stable key the web app maps to a localized label + icon. */
  key: string;
  /** Number of items in this group (drives the badge). */
  count: number;
  /** Short human detail (amount, nearest due date, …); may be empty. */
  detail: string;
  /** Where clicking the group takes the user. */
  href: string;
}

export interface AlertFeed {
  total: number;
  groups: AlertGroup[];
}

/**
 * Aggregates cross-module "things that need attention" for the top-bar
 * notification centre: unread chat, overdue invoices, pending approvals,
 * low stock and imminent statutory filings. Read-only; everything runs
 * inside the tenant RLS context.
 */
@Injectable()
export class AlertsService {
  constructor(
    private readonly db: DbService,
    private readonly compliance: ComplianceService,
  ) {}

  async getFeed(claims: TenantTokenClaims): Promise<AlertFeed> {
    const groups = await this.db.withTenant(
      claims.tid,
      claims.sub,
      async (client) => {
        const [msgs, inv, appr, stock] = await Promise.all([
          client.query(
            `SELECT COALESCE(SUM(unread_count), 0)::int AS unread
             FROM chat_participants WHERE user_id = $1`,
            [claims.sub],
          ),
          client.query(
            `SELECT COUNT(*)::int AS n,
                    COALESCE(SUM(total_cents), 0)::bigint AS cents
             FROM invoices
             WHERE status = 'issued' AND due_date < current_date`,
          ),
          client.query(
            `SELECT COUNT(*)::int AS n FROM approval_requests
             WHERE status = 'pending'`,
          ),
          client.query(
            `SELECT COUNT(*)::int AS n FROM (
               SELECT i.id FROM items i
               LEFT JOIN stock_movements sm ON sm.item_id = i.id
               WHERE i.track_stock
               GROUP BY i.id
               HAVING COALESCE(SUM(sm.qty_delta), 0) <= 0
             ) low`,
          ),
        ]);

        const out: AlertGroup[] = [];

        const unread = msgs.rows[0].unread as number;
        if (unread > 0) {
          out.push({
            key: "messages",
            count: unread,
            detail: "",
            href: "/chat",
          });
        }

        const overdueN = inv.rows[0].n as number;
        if (overdueN > 0) {
          out.push({
            key: "invoicesOverdue",
            count: overdueN,
            detail: `KES ${(Number(inv.rows[0].cents) / 100).toLocaleString(
              "en-KE",
              { maximumFractionDigits: 0 },
            )}`,
            href: "/invoices",
          });
        }

        const apprN = appr.rows[0].n as number;
        if (apprN > 0) {
          out.push({
            key: "approvals",
            count: apprN,
            detail: "",
            href: "/controls",
          });
        }

        const lowN = stock.rows[0].n as number;
        if (lowN > 0) {
          out.push({
            key: "lowStock",
            count: lowN,
            detail: "",
            href: "/inventory",
          });
        }

        return out;
      },
    );

    // Statutory filings due within two weeks (or already overdue).
    const soon = this.compliance
      .deadlines(new Date())
      .filter((d) => d.overdue || d.daysRemaining <= 14);
    if (soon.length > 0) {
      const nearest = soon[0];
      groups.push({
        key: "compliance",
        count: soon.length,
        detail: nearest.overdue
          ? `${nearest.label} overdue`
          : `Next due in ${nearest.daysRemaining}d`,
        href: "/vat",
      });
    }

    const total = groups.reduce((s, g) => s + g.count, 0);
    return { total, groups };
  }
}
