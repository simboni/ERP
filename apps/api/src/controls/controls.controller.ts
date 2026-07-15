import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
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
import {
  CONTROLLED_DOC_TYPES,
  ControlledDocType,
  ControlsService,
} from "./controls.service";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const asDate = (v?: string): string | null => {
  const s = v?.trim();
  if (!s) return null;
  if (!DATE_RE.test(s)) {
    throw new BadRequestException("Dates must be YYYY-MM-DD");
  }
  return s;
};

/**
 * Business controls: approval thresholds + queue, and the read side of the
 * audit trail (the append-only, hash-chained audit_log written across the
 * app by AuditService — hashes stay server-side).
 */
@Controller("tenants/current")
@UseGuards(JwtAuthGuard, TenantContextGuard, RolesGuard)
export class ControlsController {
  constructor(
    private readonly db: DbService,
    private readonly controls: ControlsService,
  ) {}

  @Get("controls/policies")
  async listPolicies(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.controls.listPolicies(client),
    );
  }

  @Put("controls/policies")
  @Roles("owner")
  async putPolicy(
    @TenantClaims() claims: TenantTokenClaims,
    @Body()
    body: {
      docType?: ControlledDocType;
      thresholdCents?: number;
      active?: boolean;
    },
  ) {
    // Belt and braces with @Roles: only the owner sets money gates.
    if (claims.rol !== "owner") {
      throw new ForbiddenException("Only the owner can change approval policies");
    }
    if (!body?.docType || !CONTROLLED_DOC_TYPES.includes(body.docType)) {
      throw new BadRequestException(
        "docType must be bill_payment | purchase_order",
      );
    }
    if (typeof body.thresholdCents !== "number") {
      throw new BadRequestException("thresholdCents is required");
    }
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.controls.upsertPolicy(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        docType: body.docType!,
        thresholdCents: body.thresholdCents!,
        active: body.active ?? true,
      }),
    );
  }

  @Get("controls/approvals")
  async listApprovals(
    @TenantClaims() claims: TenantTokenClaims,
    @Query("status") status?: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.controls.listApprovals(client, status?.trim() || undefined),
    );
  }

  @Post("controls/approvals/:id/decide")
  @HttpCode(200)
  @Roles("owner", "admin")
  async decide(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) requestId: string,
    @Body() body: { approve?: boolean; reason?: string },
  ) {
    if (typeof body?.approve !== "boolean") {
      throw new BadRequestException("approve (boolean) is required");
    }
    return this.controls.decide({
      tenantId: claims.tid,
      userId: claims.sub,
      requestId,
      approve: body.approve,
      reason: body.reason,
    });
  }

  @Get("audit-log")
  @Roles("owner", "admin")
  async auditLog(
    @TenantClaims() claims: TenantTokenClaims,
    @Query()
    q: {
      limit?: string;
      offset?: string;
      action?: string;
      entityType?: string;
      from?: string;
      to?: string;
    },
  ) {
    const limit = Math.min(
      Math.max(Number.parseInt(q.limit ?? "", 10) || 50, 1),
      100,
    );
    const offset = Math.max(Number.parseInt(q.offset ?? "", 10) || 0, 0);
    const action = q.action?.trim() || null;
    const entityType = q.entityType?.trim() || null;
    const from = asDate(q.from);
    const to = asDate(q.to);
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const where = `WHERE a.tenant_id = $1
          AND ($2::text IS NULL OR a.action = $2)
          AND ($3::text IS NULL OR a.entity_type = $3)
          AND ($4::date IS NULL OR a.created_at >= $4::date)
          AND ($5::date IS NULL OR a.created_at < ($5::date + 1))`;
      const params = [claims.tid, action, entityType, from, to];
      const [rows, count] = await Promise.all([
        client.query(
          `SELECT a.id, a.created_at, a.action, a.entity_type, a.entity_id,
                  a.payload, coalesce(u.full_name, u.email) AS actor
           FROM audit_log a
           LEFT JOIN users u ON u.id = a.actor_user_id
           ${where}
           ORDER BY a.id DESC
           LIMIT $6 OFFSET $7`,
          [...params, limit, offset],
        ),
        client.query(
          `SELECT count(*)::int AS total FROM audit_log a ${where}`,
          params,
        ),
      ]);
      return {
        rows: rows.rows,
        total: count.rows[0].total as number,
        limit,
        offset,
      };
    });
  }

  @Get("audit-log/actions")
  @Roles("owner", "admin")
  async auditActions(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const [actions, entityTypes] = await Promise.all([
        client.query(
          "SELECT DISTINCT action FROM audit_log WHERE tenant_id = $1 ORDER BY action",
          [claims.tid],
        ),
        client.query(
          "SELECT DISTINCT entity_type FROM audit_log WHERE tenant_id = $1 ORDER BY entity_type",
          [claims.tid],
        ),
      ]);
      return {
        actions: actions.rows.map((r: { action: string }) => r.action),
        entityTypes: entityTypes.rows.map(
          (r: { entity_type: string }) => r.entity_type,
        ),
      };
    });
  }
}
