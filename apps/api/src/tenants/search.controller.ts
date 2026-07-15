import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import type { TenantTokenClaims } from "@jenga/shared";
import {
  JwtAuthGuard,
  TenantClaims,
  TenantContextGuard,
} from "../auth/guards";
import { DbService } from "../db/db.service";

export interface SearchHit {
  type: string;
  id: string;
  title: string;
  subtitle: string;
  href: string;
}

/**
 * Universal search (Dynamics-style): one query sweeps every module a
 * user can navigate to. Each source contributes up to 5 hits; all
 * queries run inside the tenant's RLS context.
 */
@Controller("tenants/current/search")
@UseGuards(JwtAuthGuard, TenantContextGuard)
export class SearchController {
  constructor(private readonly db: DbService) {}

  @Get()
  async search(
    @TenantClaims() claims: TenantTokenClaims,
    @Query("q") q?: string,
  ): Promise<SearchHit[]> {
    const needle = (q ?? "").trim();
    if (needle.length < 2) return [];
    const like = `%${needle}%`;
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const [customers, suppliers, invoices, items, employees, contacts, quotes] =
        await Promise.all([
          client.query(
            `SELECT id, name, coalesce(phone, email, '') AS extra
             FROM customers WHERE name ILIKE $1 LIMIT 5`,
            [like],
          ),
          client.query(
            `SELECT id, name, coalesce(phone, email, '') AS extra
             FROM suppliers WHERE name ILIKE $1 LIMIT 5`,
            [like],
          ),
          client.query(
            `SELECT inv.id, inv.invoice_no, inv.status, inv.total_cents,
                    c.name AS customer
             FROM invoices inv JOIN customers c ON c.id = inv.customer_id
             WHERE inv.invoice_no::text ILIKE $1 OR c.name ILIKE $1
             ORDER BY inv.created_at DESC LIMIT 5`,
            [like],
          ),
          client.query(
            `SELECT id, sku, name FROM items
             WHERE name ILIKE $1 OR sku ILIKE $1 LIMIT 5`,
            [like],
          ),
          client.query(
            `SELECT id, full_name, coalesce(designation, '') AS designation
             FROM employees WHERE full_name ILIKE $1 LIMIT 5`,
            [like],
          ),
          client.query(
            `SELECT id, name, stage, coalesce(company, '') AS company
             FROM crm_contacts
             WHERE name ILIKE $1 OR company ILIKE $1 LIMIT 5`,
            [like],
          ),
          client.query(
            `SELECT q.id, q.quote_no, q.status, c.name AS customer
             FROM quotes q JOIN customers c ON c.id = q.customer_id
             WHERE q.quote_no::text ILIKE $1 OR c.name ILIKE $1
             ORDER BY q.created_at DESC LIMIT 5`,
            [like],
          ),
        ]);
      const hits: SearchHit[] = [];
      for (const r of customers.rows) {
        hits.push({
          type: "Customer",
          id: r.id,
          title: r.name,
          subtitle: r.extra,
          href: "/customers",
        });
      }
      for (const r of invoices.rows) {
        hits.push({
          type: "Invoice",
          id: r.id,
          title: `#${r.invoice_no ?? "draft"} · ${r.customer}`,
          subtitle: r.status,
          href: `/invoices/view?id=${r.id}`,
        });
      }
      for (const r of quotes.rows) {
        hits.push({
          type: "Quote",
          id: r.id,
          title: `Q${r.quote_no} · ${r.customer}`,
          subtitle: r.status,
          href: "/quotes",
        });
      }
      for (const r of items.rows) {
        hits.push({
          type: "Item",
          id: r.id,
          title: r.name,
          subtitle: r.sku,
          href: "/inventory",
        });
      }
      for (const r of employees.rows) {
        hits.push({
          type: "Employee",
          id: r.id,
          title: r.full_name,
          subtitle: r.designation,
          href: "/hr",
        });
      }
      for (const r of contacts.rows) {
        hits.push({
          type: "CRM contact",
          id: r.id,
          title: r.name,
          subtitle: [r.company, r.stage].filter(Boolean).join(" · "),
          href: "/crm",
        });
      }
      for (const r of suppliers.rows) {
        hits.push({
          type: "Supplier",
          id: r.id,
          title: r.name,
          subtitle: r.extra,
          href: "/suppliers",
        });
      }
      return hits.slice(0, 25);
    });
  }
}
