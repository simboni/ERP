import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadConfig } from "./config";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: (process.env.WEB_ORIGINS ?? "http://localhost:3001").split(","),
  });
  app.enableShutdownHooks();
  const { port } = loadConfig();
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`jenga-api listening on :${port}`);
}

void bootstrap();
