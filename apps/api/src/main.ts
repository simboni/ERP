import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { requestLogger } from "./common/request-logger";
import { loadConfig } from "./config";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: (process.env.WEB_ORIGINS ?? "http://localhost:3001").split(","),
  });
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
