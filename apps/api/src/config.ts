import { createHmac } from "node:crypto";

/**
 * Environment configuration. Defaults target local development only;
 * production injects real values via secret management (05-security.md §3).
 */
export interface AppConfig {
  port: number;
  appDbUrl: string;
  workerDbUrl: string;
  jwtSecret: string;
  accessTokenTtlSec: number;
  refreshTokenTtlDays: number;
}

export function loadConfig(): AppConfig {
  const isProd = process.env.NODE_ENV === "production";
  const jwtSecret = process.env.JWT_SECRET ?? "";
  if (isProd && jwtSecret.length < 32) {
    throw new Error("JWT_SECRET must be set (>=32 chars) in production");
  }
  // Managed-platform mode (Render/Railway/any Docker host): derive the
  // runtime-role URLs from the owner URL + role passwords. When no explicit
  // password env exists, derive one from JWT_SECRET — the same derivation
  // db/bootstrap-and-migrate.ts uses when provisioning the roles, so a
  // platform needs only ADMIN_DB_URL + JWT_SECRET to be fully wired.
  const derivedPw = (role: string): string | undefined =>
    jwtSecret
      ? createHmac("sha256", jwtSecret)
          .update(`${role}-db-password`)
          .digest("hex")
      : undefined;
  const derive = (role: string, pw: string | undefined): string | null => {
    const admin = process.env.ADMIN_DB_URL;
    pw = pw ?? derivedPw(role);
    if (!admin || !pw) return null;
    const u = new URL(admin);
    u.username = role;
    u.password = pw;
    return u.toString();
  };
  return {
    port: Number(process.env.PORT ?? 3000),
    appDbUrl:
      process.env.APP_DB_URL ??
      derive("jenga_app", process.env.APP_DB_PASSWORD) ??
      "postgres://jenga_app:app_dev_pw@localhost:5432/jenga_dev",
    workerDbUrl:
      process.env.WORKER_DB_URL ??
      derive("jenga_worker", process.env.WORKER_DB_PASSWORD) ??
      "postgres://jenga_worker:worker_dev_pw@localhost:5432/jenga_dev",
    jwtSecret: jwtSecret || "dev-only-secret-do-not-use-in-production",
    accessTokenTtlSec: Number(process.env.ACCESS_TOKEN_TTL_SEC ?? 900),
    refreshTokenTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30),
  };
}
