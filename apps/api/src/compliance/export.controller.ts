import { Controller, Get, UseGuards } from "@nestjs/common";
import type { TenantTokenClaims } from "@jenga/shared";
import { AuditService } from "../audit/audit.service";
import {
  JwtAuthGuard,
  Roles,
  RolesGuard,
  TenantClaims,
  TenantContextGuard,
} from "../auth/guards";
import { decryptPii, isEncryptedPii } from "../common/crypto";
import { DbService } from "../db/db.service";

/** Every tenant-owned table in export order. RLS scopes each query. */
const EXPORT_TABLES = [
  "accounts",
  "journal_entries",
  "journal_lines",
  "customers",
  "invoices",
  "invoice_lines",
  "credit_notes",
  "suppliers",
  "bills",
  "bill_lines",
  "items",
  "stock_movements",
  "payments",
  "employees",
  "payroll_runs",
  "payroll_items",
  "branches",
  "fiscal_documents",
  "notifications",
  "audit_log",
] as const;

/**
 * Full tenant data export (owner only): the "no data hostage-taking"
 * principle (03 §4.4) and DPA portability in one endpoint. Encrypted PII
 * is decrypted for the owner's own export — it is their data.
 */
@Controller("tenants/current")
@UseGuards(JwtAuthGuard, TenantContextGuard, RolesGuard)
export class ExportController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Get("export")
  @Roles("owner")
  async exportAll(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const dump: Record<string, unknown[]> = {};
      for (const table of EXPORT_TABLES) {
        const res = await client.query(`SELECT * FROM ${table}`);
        dump[table] = res.rows.map((row: Record<string, unknown>) => {
          if (
            table === "employees" &&
            isEncryptedPii(row.national_id as string | null)
          ) {
            return { ...row, national_id: decryptPii(row.national_id as string) };
          }
          return row;
        });
      }
      await this.audit.record(client, {
        tenantId: claims.tid,
        actorUserId: claims.sub,
        action: "tenant.exported",
        entityType: "tenant",
        entityId: claims.tid,
        payload: {
          tables: EXPORT_TABLES.length,
          rows: Object.values(dump).reduce((s, r) => s + r.length, 0),
        },
      });
      return {
        exportedAt: new Date().toISOString(),
        tenantId: claims.tid,
        data: dump,
      };
    });
  }
}
