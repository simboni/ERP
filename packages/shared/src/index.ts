/**
 * Types shared between the API and every client (web, POS, mobile).
 */

export const ROLES = [
  "owner",
  "admin",
  "accountant",
  "cashier",
  "storekeeper",
  "payroll",
  "viewer",
] as const;

export type Role = (typeof ROLES)[number];

/** Roles allowed to manage members and read the audit trail. */
export const ADMIN_ROLES: readonly Role[] = ["owner", "admin"];

/** Access token before a tenant is selected: identity only. */
export interface UserTokenClaims {
  sub: string; // user id
  typ: "user";
}

/** Tenant-scoped access token: identity + active tenant + role in it. */
export interface TenantTokenClaims {
  sub: string; // user id
  typ: "tenant";
  tid: string; // tenant id
  rol: Role;
}

export type AccessTokenClaims = UserTokenClaims | TenantTokenClaims;

export interface MembershipSummary {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: Role;
}
