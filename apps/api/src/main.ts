import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { requestLogger } from "./common/request-logger";
import { loadConfig } from "./config";

async function bootstrap(): Promise<void> {
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
