import { Controller, Get, UseGuards } from "@nestjs/common";
import type { TenantTokenClaims } from "@jenga/shared";
import {
  JwtAuthGuard,
  Roles,
  RolesGuard,
  TenantClaims,
  TenantContextGuard,
} from "./auth/guards";
import { DbService } from "./db/db.service";

@Controller("health")
export class HealthController {
  constructor(private readonly db: DbService) {}

  /**
   * Liveness first: this endpoint always answers 200 so the platform
   * routes traffic and problems surface as readable errors instead of a
   * blank Bad Gateway. Database state is reported as data.
   */
  @Get()
  async health() {
    try {
      await this.db.query("SELECT 1");
      return { status: "ok", db: "ok" };
    } catch (err) {
      return {
        status: "degraded",
        db: `error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

/**
 * Ops metrics (05-security.md §4): the numbers an operator pages on —
 * queue depths, dead letters, stuck payments — scoped to the tenant.
 * Infra-level aggregates come from the structured log pipeline.
 */
@Controller("tenants/current/ops")
@UseGuards(JwtAuthGuard, TenantContextGuard, RolesGuard)
export class OpsController {
  constructor(private readonly db: DbService) {}

  @Get("metrics")
  @Roles("owner", "admin")
  async metrics(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const q = async (sql: string): Promise<number> => {
        const r = await client.query(sql);
        return Number(r.rows[0].n);
      };
      return {
        fiscal: {
          pending: await q(
            `SELECT count(*)::int AS n FROM fiscal_documents WHERE status IN ('pending','signing')`,
          ),
          deadLetter: await q(
            `SELECT count(*)::int AS n FROM fiscal_documents WHERE status = 'dead_letter'`,
          ),
        },
        notifications: {
          pending: await q(
            `SELECT count(*)::int AS n FROM notifications WHERE status IN ('pending','sending','failed')`,
          ),
          deadLetter: await q(
            `SELECT count(*)::int AS n FROM notifications WHERE status = 'dead_letter'`,
          ),
        },
        payments: {
          unmatched: await q(
            `SELECT count(*)::int AS n FROM payments WHERE state = 'confirmed' AND invoice_id IS NULL`,
          ),
          timeoutReconciling: await q(
            `SELECT count(*)::int AS n FROM payments WHERE state = 'timeout_reconciling'`,
          ),
        },
        invoices: {
          issuedUnpaid: await q(
            `SELECT count(*)::int AS n FROM invoices WHERE status = 'issued'`,
          ),
        },
        generatedAt: new Date().toISOString(),
      };
    });
  }
}
