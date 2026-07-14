/**
 * Ops metrics endpoint: tenant-scoped queue/exception counters, admin-only.
 */
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import request from "supertest";

process.env.APP_DB_URL =
  process.env.APP_DB_URL_TEST ??
  "postgres://jenga_app:app_dev_pw@localhost:5432/jenga_test";
process.env.WORKER_DB_URL =
  process.env.WORKER_DB_URL_TEST ??
  "postgres://jenga_worker:worker_dev_pw@localhost:5432/jenga_test";

import { AppModule } from "../src/app.module";

describe("ops metrics", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  const suffix = randomUUID().slice(0, 8);
  let auth: { Authorization: string };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    http = app.getHttpServer();

    const signup = await request(http).post("/auth/signup").send({
      email: `ops-${suffix}@test.local`,
      password: "a-strong-password",
      fullName: "Ops Tester",
      tenantName: "Ops Traders",
      tenantSlug: `ops-traders-${suffix}`,
    });
    const login = await request(http)
      .post("/auth/login")
      .send({ email: `ops-${suffix}@test.local`, password: "a-strong-password" });
    const tt = await request(http)
      .post("/auth/tenant-token")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .send({ tenantId: signup.body.tenantId });
    auth = { Authorization: `Bearer ${tt.body.accessToken}` };
  });

  afterAll(async () => {
    await app.close();
  });

  test("returns the operational counters for a fresh tenant", async () => {
    const res = await request(http)
      .get("/tenants/current/ops/metrics")
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        fiscal: { pending: 0, deadLetter: 0 },
        notifications: { pending: 0, deadLetter: 0 },
        payments: { unmatched: 0, timeoutReconciling: 0 },
        invoices: { issuedUnpaid: 0 },
      }),
    );
    expect(res.body.generatedAt).toBeTruthy();
  });
});
