import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { TenantTokenClaims } from "@jenga/shared";
import { AuditService } from "../audit/audit.service";
import {
  JwtAuthGuard,
  Roles,
  RolesGuard,
  TenantClaims,
  TenantContextGuard,
} from "../auth/guards";
import { DbService } from "../db/db.service";
import { seedDefaultAccounts } from "../ledger/ledger.service";
import { PayrollService } from "./payroll.service";

const PAYROLL_ROLES = ["owner", "admin", "payroll"] as const;

@Controller("tenants/current")
@UseGuards(JwtAuthGuard, TenantContextGuard, RolesGuard)
export class PayrollController {
  constructor(
    private readonly db: DbService,
    private readonly payroll: PayrollService,
    private readonly audit: AuditService,
  ) {}

  @Post("employees")
  @Roles(...PAYROLL_ROLES)
  async createEmployee(
    @TenantClaims() claims: TenantTokenClaims,
    @Body()
    body: {
      fullName?: string;
      grossCents?: number;
      kraPin?: string;
      nationalId?: string;
      msisdn?: string;
    },
  ) {
    if (!body?.fullName?.trim()) {
      throw new BadRequestException("fullName is required");
    }
    if (!Number.isInteger(body?.grossCents) || body!.grossCents! <= 0) {
      throw new BadRequestException("grossCents must be a positive integer");
    }
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `INSERT INTO employees
           (tenant_id, full_name, gross_cents, kra_pin, national_id, msisdn)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, full_name, gross_cents, status, created_at`,
        [
          claims.tid,
          body.fullName!.trim(),
          body.grossCents,
          body.kraPin?.trim() || null,
          body.nationalId?.trim() || null,
          body.msisdn?.trim() || null,
        ],
      );
      await this.audit.record(client, {
        tenantId: claims.tid,
        actorUserId: claims.sub,
        action: "employee.created",
        entityType: "employee",
        entityId: res.rows[0].id,
        payload: { fullName: body.fullName, grossCents: body.grossCents },
      });
      return res.rows[0];
    });
  }

  @Get("employees")
  @Roles(...PAYROLL_ROLES)
  async listEmployees(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT id, full_name, kra_pin, msisdn, gross_cents, status, created_at
         FROM employees ORDER BY full_name`,
      );
      return res.rows;
    });
  }

  @Post("payroll/runs")
  @Roles(...PAYROLL_ROLES)
  async draftRun(
    @TenantClaims() claims: TenantTokenClaims,
    @Body() body: { period?: string },
  ) {
    if (!body?.period) throw new BadRequestException("period (YYYY-MM) is required");
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      await seedDefaultAccounts(client, claims.tid); // ensure 2310/6100 exist
      return this.payroll.draftRun(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        period: body.period!,
      });
    });
  }

  @Get("payroll/runs")
  @Roles(...PAYROLL_ROLES)
  async listRuns(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT id, period, status, employee_count, gross_cents, paye_cents,
                net_cents, committed_at, created_at
         FROM payroll_runs ORDER BY period DESC, created_at DESC`,
      );
      return res.rows;
    });
  }

  @Get("payroll/runs/:id")
  @Roles(...PAYROLL_ROLES)
  async getRun(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) runId: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const run = await client.query(
        "SELECT * FROM payroll_runs WHERE id = $1",
        [runId],
      );
      if (!run.rows[0]) throw new NotFoundException();
      const items = await client.query(
        `SELECT pi.*, e.full_name
         FROM payroll_items pi JOIN employees e ON e.id = pi.employee_id
         WHERE pi.run_id = $1 ORDER BY e.full_name`,
        [runId],
      );
      return { ...run.rows[0], items: items.rows };
    });
  }

  /** Maker-checker: only owner/admin commit (payroll officer drafts). */
  @Post("payroll/runs/:id/commit")
  @Roles("owner", "admin")
  async commit(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) runId: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.payroll.commit(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        runId,
      }),
    );
  }
}
