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
  return {
    port: Number(process.env.PORT ?? 3000),
    appDbUrl:
      process.env.APP_DB_URL ??
      "postgres://jenga_app:app_dev_pw@localhost:5432/jenga_dev",
    workerDbUrl:
      process.env.WORKER_DB_URL ??
      "postgres://jenga_worker:worker_dev_pw@localhost:5432/jenga_dev",
    jwtSecret: jwtSecret || "dev-only-secret-do-not-use-in-production",
    accessTokenTtlSec: Number(process.env.ACCESS_TOKEN_TTL_SEC ?? 900),
    refreshTokenTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30),
  };
}
