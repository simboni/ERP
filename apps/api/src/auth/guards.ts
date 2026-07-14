import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import type { Request } from "express";
import type { AccessTokenClaims, Role, TenantTokenClaims } from "@jenga/shared";

export interface AuthedRequest extends Request {
  claims?: AccessTokenClaims;
}

/** Verifies the bearer token and attaches claims. Any valid token passes. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) throw new UnauthorizedException("Missing bearer token");
    try {
      req.claims = await this.jwt.verifyAsync<AccessTokenClaims>(token);
    } catch {
      throw new UnauthorizedException("Invalid or expired token");
    }
    return true;
  }
}

/** Requires a tenant-scoped token (typ=tenant). Use after JwtAuthGuard. */
@Injectable()
export class TenantContextGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (req.claims?.typ !== "tenant") {
      throw new ForbiddenException("Select a workspace first (tenant token required)");
    }
    return true;
  }
}

export const ROLES_KEY = "roles";
/** Restrict a tenant-scoped route to the given roles. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** Enforces @Roles(...) against the tenant token's role. Deny by default. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!required || required.length === 0) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const claims = req.claims;
    if (claims?.typ !== "tenant" || !required.includes(claims.rol)) {
      throw new ForbiddenException("Insufficient role for this action");
    }
    return true;
  }
}

/** Injects the verified tenant claims into a handler parameter. */
export const TenantClaims = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TenantTokenClaims => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (req.claims?.typ !== "tenant") {
      throw new ForbiddenException("Tenant token required");
    }
    return req.claims;
  },
);

/** Injects the user id from any valid token. */
export const UserId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.claims) throw new UnauthorizedException();
    return req.claims.sub;
  },
);
