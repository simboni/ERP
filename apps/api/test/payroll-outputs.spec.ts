/**
 * Payroll outputs over HTTP: payslip PDF and P10 CSV from a committed run,
 * with committed-only guards.
 */
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { renderP10Csv } from "../src/payroll/payroll-outputs";

process.env.APP_DB_URL =
  process.env.APP_DB_URL_TEST ??
  "postgres://jenga_app:app_dev_pw@localhost:5432/jenga_test";
process.env.WORKER_DB_URL =
  process.env.WORKER_DB_URL_TEST ??
  "postgres://jenga_worker:worker_dev_pw@localhost:5432/jenga_test";

import { AppModule } from "../src/app.module";

describe("payroll outputs", () => {
  test("P10 CSV escapes names and formats KES", () => {
    const csv = renderP10Csv("2026-07", [
      {
        kraPin: "A001",
        employeeName: 'Otieno, "Baba" Jr',
        grossCents: 5_000_000,
        taxableCents: 4_487_500,
        payeCents: 584_585,
        ahlEmpCents: 75_000,
        shifCents: 137_500,
        nssfEmpCents: 300_000,
      },
    ]);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain("PIN of Employee");
    expect(lines[1]).toContain('"Otieno, ""Baba"" Jr"');
    expect(lines[1]).toContain("50000.00");
    expect(lines[1]).toContain("5845.85");
  });

  describe("HTTP endpoints", () => {
    let app: INestApplication;
    let http: ReturnType<INestApplication["getHttpServer"]>;
    const suffix = randomUUID().slice(0, 8);
    let auth: { Authorization: string };
    let runId: string;
    let itemId: string;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
      http = app.getHttpServer();

      const signup = await request(http).post("/auth/signup").send({
        email: `po-${suffix}@test.local`,
        password: "a-strong-password",
        fullName: "Output Tester",
        tenantName: "Output Traders",
        tenantSlug: `output-traders-${suffix}`,
      });
      const login = await request(http)
        .post("/auth/login")
        .send({ email: `po-${suffix}@test.local`, password: "a-strong-password" });
      const tt = await request(http)
        .post("/auth/tenant-token")
        .set("Authorization", `Bearer ${login.body.accessToken}`)
        .send({ tenantId: signup.body.tenantId });
      auth = { Authorization: `Bearer ${tt.body.accessToken}` };

      await request(http)
        .post("/tenants/current/employees")
        .set(auth)
        .send({ fullName: "Amina Odhiambo", grossCents: 5_000_000, kraPin: "A111222333B" });
      const run = await request(http)
        .post("/tenants/current/payroll/runs")
        .set(auth)
        .send({ period: "2026-07" });
      runId = run.body.runId;

      const detail = await request(http)
        .get(`/tenants/current/payroll/runs/${runId}`)
        .set(auth);
      itemId = detail.body.items[0].id;
    });

    afterAll(async () => {
      await app.close();
    });

    test("payslip/P10 refuse draft runs, then work after commit", async () => {
      const early = await request(http)
        .get(`/tenants/current/payroll/runs/${runId}/p10.csv`)
        .set(auth);
      expect(early.status).toBe(400);

      await request(http)
        .post(`/tenants/current/payroll/runs/${runId}/commit`)
        .set(auth)
        .expect(201);

      const p10 = await request(http)
        .get(`/tenants/current/payroll/runs/${runId}/p10.csv`)
        .set(auth);
      expect(p10.status).toBe(200);
      expect(p10.headers["content-type"]).toContain("text/csv");
      expect(p10.text).toContain("A111222333B");
      expect(p10.text).toContain("5845.85"); // verified PAYE for 50k gross

      const payslip = await request(http)
        .get(`/tenants/current/payroll/runs/${runId}/items/${itemId}/payslip.pdf`)
        .set(auth)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => cb(null, Buffer.concat(chunks)));
        });
      expect(payslip.status).toBe(200);
      expect((payslip.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    });
  });
});
