import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { createHash, randomBytes } from "node:crypto";
import type {
  MembershipSummary,
  Role,
  TenantTokenClaims,
  UserTokenClaims,
} from "@jenga/shared";
import { loadConfig } from "../config";
import { DbService } from "../db/db.service";

export interface SignupInput {
  email: string;
  password: string;
  fullName: string;
  tenantName: string;
  tenantSlug: string;
}

@Injectable()
export class AuthService {
  private readonly config = loadConfig();

  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtService,
  ) {}

  /** Create identity + tenant + owner membership atomically. */
  async signup(input: SignupInput): Promise<{ userId: string; tenantId: string }> {
    const passwordHash = await argon2.hash(input.password, {
      type: argon2.argon2id,
    });
    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      const userRes = await client.query(
        `INSERT INTO users (email, password_hash, full_name)
         VALUES ($1, $2, $3) RETURNING id`,
        [input.email.trim(), passwordHash, input.fullName.trim()],
      );
      const userId: string = userRes.rows[0].id;
      const tenantRes = await client.query(
        "SELECT create_tenant_with_owner($1, $2, $3) AS tenant_id",
        [input.tenantName.trim(), input.tenantSlug.trim().toLowerCase(), userId],
      );
      await client.query("COMMIT");
      return { userId, tenantId: tenantRes.rows[0].tenant_id };
    } catch (err: unknown) {
      await client.query("ROLLBACK");
      if ((err as { code?: string }).code === "23505") {
        throw new ConflictException("Email or workspace name already in use");
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async login(
    email: string,
    password: string,
  ): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
    const res = await this.db.query(
      `SELECT id, password_hash, status FROM users WHERE lower(email) = lower($1)`,
      [email.trim()],
    );
    const user = res.rows[0];
    // Verify against a dummy hash when the user is unknown so response time
    // does not reveal which emails exist.
    const hash =
      user?.password_hash ??
      "$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const valid = await argon2.verify(hash, password).catch(() => false);
    if (!user || !valid || user.status !== "active") {
      throw new UnauthorizedException("Invalid credentials");
    }
    const claims: UserTokenClaims = { sub: user.id, typ: "user" };
    const accessToken = await this.jwt.signAsync(claims);
    const refreshToken = await this.issueRefreshToken(user.id);
    return { accessToken, refreshToken, userId: user.id };
  }

  /** Exchange a user token for a tenant-scoped token after membership check. */
  async issueTenantToken(userId: string, tenantId: string): Promise<string> {
    const membership = await this.db.withUser(userId, async (client) => {
      const res = await client.query(
        `SELECT role, status FROM memberships
         WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId],
      );
      return res.rows[0] as { role: Role; status: string } | undefined;
    });
    if (!membership || membership.status !== "active") {
      throw new ForbiddenException("No active membership in this workspace");
    }
    const claims: TenantTokenClaims = {
      sub: userId,
      typ: "tenant",
      tid: tenantId,
      rol: membership.role,
    };
    return this.jwt.signAsync(claims);
  }

  async listMemberships(userId: string): Promise<MembershipSummary[]> {
    return this.db.withUser(userId, async (client) => {
      const res = await client.query(
        `SELECT m.tenant_id, m.role, t.name, t.slug
         FROM memberships m
         JOIN tenants t ON t.id = m.tenant_id
         WHERE m.user_id = $1 AND m.status = 'active'`,
        [userId],
      );
      return res.rows.map(
        (r: { tenant_id: string; role: Role; name: string; slug: string }) => ({
          tenantId: r.tenant_id,
          tenantName: r.name,
          tenantSlug: r.slug,
          role: r.role,
        }),
      );
    });
  }

  /**
   * Single-use rotation: a refresh token is revoked the moment it is used
   * and a new one is issued. Reuse of a revoked token is treated as theft —
   * every live token for that user is revoked (OWASP rotation guidance).
   */
  async refresh(
    refreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const tokenHash = createHash("sha256").update(refreshToken).digest("hex");
    const res = await this.db.query(
      `SELECT id, user_id, expires_at, revoked_at
       FROM refresh_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
    const row = res.rows[0];
    if (!row) throw new UnauthorizedException("Invalid refresh token");
    if (row.revoked_at) {
      await this.db.query(
        `UPDATE refresh_tokens SET revoked_at = now()
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [row.user_id],
      );
      throw new UnauthorizedException("Refresh token reuse detected; sessions revoked");
    }
    if (new Date(row.expires_at) < new Date()) {
      throw new UnauthorizedException("Refresh token expired");
    }
    await this.db.query(
      "UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1",
      [row.id],
    );
    const claims: UserTokenClaims = { sub: row.user_id, typ: "user" };
    const accessToken = await this.jwt.signAsync(claims);
    const newRefresh = await this.issueRefreshToken(row.user_id);
    return { accessToken, refreshToken: newRefresh };
  }

  private async issueRefreshToken(userId: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expires = new Date(
      Date.now() + this.config.refreshTokenTtlDays * 24 * 3600 * 1000,
    );
    await this.db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [userId, tokenHash, expires],
    );
    return token;
  }
}
