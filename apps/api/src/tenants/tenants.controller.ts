import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { Role, TenantTokenClaims } from "@jenga/shared";
import { ROLES } from "@jenga/shared";
import { AuditService } from "../audit/audit.service";
import { AuthService } from "../auth/auth.service";
import {
  JwtAuthGuard,
  Roles,
  RolesGuard,
  TenantClaims,
  TenantContextGuard,
} from "../auth/guards";
import { DbService } from "../db/db.service";

/**
 * Tenant-scoped endpoints. Every handler runs inside db.withTenant(), so
 * RLS confines all reads and writes to the token's tenant — the WHERE
 * clauses are intent, the policies are enforcement.
 */
@Controller("tenants/current")
@UseGuards(JwtAuthGuard, TenantContextGuard, RolesGuard)
export class TenantsController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  async current(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT id, name, slug, status, created_at, business_type, enabled_modules
         FROM tenants WHERE id = $1`,
        [claims.tid],
      );
      if (!res.rows[0]) throw new NotFoundException();
      return res.rows[0];
    });
  }

  @Get("members")
  async members(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT m.id, m.user_id, u.full_name, u.email, m.role, m.status, m.created_at
         FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.tenant_id = $1
         ORDER BY m.created_at`,
        [claims.tid],
      );
      return res.rows;
    });
  }

  /**
   * Owner resets a locked-out member's password to a one-time temporary
   * value shown once. AuthService refuses if the member also belongs to
   * another workspace.
   */
  @Post("members/:userId/reset-password")
  @HttpCode(200)
  @Roles("owner")
  async resetMemberPassword(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("userId", ParseUUIDPipe) targetUserId: string,
  ) {
    const membership = await this.db.withTenant(
      claims.tid,
      claims.sub,
      async (client) => {
        const r = await client.query(
          "SELECT id FROM memberships WHERE user_id = $1 AND tenant_id = $2",
          [targetUserId, claims.tid],
        );
        return r.rows[0];
      },
    );
    if (!membership) throw new NotFoundException("Not a member here");
    const result = await this.auth.adminResetPassword(
      claims.tid,
      targetUserId,
    );
    await this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.audit.record(client, {
        tenantId: claims.tid,
        actorUserId: claims.sub,
        action: "member.password_reset",
        entityType: "user",
        entityId: targetUserId,
        payload: {},
      }),
    );
    return result;
  }

  @Post("members")
  @Roles("owner", "admin")
  async addMember(
    @TenantClaims() claims: TenantTokenClaims,
    @Body() body: { email?: string; role?: Role },
  ) {
    const role = body?.role;
    if (!body?.email || !role || !ROLES.includes(role)) {
      throw new BadRequestException("email and a valid role are required");
    }
    if (role === "owner") {
      throw new BadRequestException("Ownership is transferred, not granted");
    }
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const userRes = await client.query(
        "SELECT id FROM users WHERE lower(email) = lower($1) AND status = 'active'",
        [body.email],
      );
      const user = userRes.rows[0];
      if (!user) {
        // Invitation flow for unknown emails lands with the notification
        // fabric; for now only existing identities can be added.
        throw new NotFoundException("No user with that email");
      }
      const insertRes = await client.query(
        `INSERT INTO memberships (tenant_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, user_id) DO NOTHING
         RETURNING id, user_id, role, status, created_at`,
        [claims.tid, user.id, role],
      );
      if (!insertRes.rows[0]) {
        throw new BadRequestException("Already a member of this workspace");
      }
      await this.audit.record(client, {
        tenantId: claims.tid,
        actorUserId: claims.sub,
        action: "member.added",
        entityType: "membership",
        entityId: insertRes.rows[0].id,
        payload: { email: body.email, role },
      });
      return insertRes.rows[0];
    });
  }

  @Get("audit")
  @Roles("owner", "admin")
  async auditTrail(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT id, actor_user_id, action, entity_type, entity_id,
                payload, prev_hash, hash, created_at
         FROM audit_log WHERE tenant_id = $1
         ORDER BY id DESC LIMIT 100`,
        [claims.tid],
      );
      return res.rows;
    });
  }
}
