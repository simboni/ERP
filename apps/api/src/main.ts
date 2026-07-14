import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { requestLogger } from "./common/request-logger";
import { loadConfig } from "./config";

/**
 * Verify the runtime DB role actually connects before booting. If it
 * cannot (managed PG refused role provisioning) and an owner URL exists,
 * fall back to it with a loud warning: FORCE RLS keeps every tenant
 * policy binding even for the table owner, so tenant isolation holds —
 * only role-level defence-in-depth (and the cross-tenant queue workers)
 * degrade until roles are provisioned per docs/deploy-render.md.
 */
async function preflightDb(): Promise<void> {
  const { Client } = await import("pg");
  const cfg = loadConfig();
  const probe = new Client({
    connectionString: cfg.appDbUrl,
    connectionTimeoutMillis: 8000,
  });
  try {
    await probe.connect();
    await probe.end();
  } catch (err) {
    await probe.end().catch(() => undefined);
    const reason = err instanceof Error ? err.message : String(err);
    if (process.env.ADMIN_DB_URL) {
      console.error(
        `WARNING: runtime DB role connection failed (${reason}); ` +
          "falling back to the owner connection. Tenant isolation remains " +
          "enforced by FORCE ROW LEVEL SECURITY, but provision jenga_app/" +
          "jenga_worker (docs/deploy-render.md) to restore full separation.",
      );
      process.env.APP_DB_URL = process.env.ADMIN_DB_URL;
      process.env.WORKER_DB_URL = process.env.ADMIN_DB_URL;
    } else {
      // NEVER die at boot: serve, and report the DB problem via /health
      // and request errors where it is visible and diagnosable.
      console.error(
        `WARNING: database unreachable at boot (${reason}). Serving anyway; ` +
          "requests will fail until connectivity is restored.",
      );
    }
  }
}

async function bootstrap(): Promise<void> {
  await preflightDb();
  const app = await NestFactory.create(AppModule);
  // WEB_ORIGINS explicit, or WEB_ORIGIN_HOST auto-injected by the platform
  // blueprint (hostname only), else local dev. On Render, additionally
  // tolerate sibling *.onrender.com origins so first-deploy ordering races
  // can never strand the web app (tighten to the exact host at custom-
  // domain time).
  const origins: (string | RegExp)[] = process.env.WEB_ORIGINS
    ? process.env.WEB_ORIGINS.split(",")
    : process.env.WEB_ORIGIN_HOST
      ? [`https://${process.env.WEB_ORIGIN_HOST}`]
      : ["http://localhost:3001"];
  if (process.env.RENDER) origins.push(/\.onrender\.com$/);
  app.enableCors({ origin: origins });
  // Correct client IPs (rate limiting) behind the platform proxy.
  app.getHttpAdapter().getInstance().set("trust proxy", 1);
  // Security headers (05-security.md §3) — API responses only.
  app.use(
    (
      _req: import("express").Request,
      res: import("express").Response,
      next: import("express").NextFunction,
    ) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Cache-Control", "no-store");
      if (process.env.NODE_ENV === "production") {
        res.setHeader(
          "Strict-Transport-Security",
          "max-age=31536000; includeSubDomains",
        );
      }
      next();
    },
  );
  app.use(requestLogger);
  app.enableShutdownHooks();
  const { port } = loadConfig();
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`jenga-api listening on :${port}`);
}

void bootstrap();
