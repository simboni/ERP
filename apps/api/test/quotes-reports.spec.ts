/**
 * Quotes, sales report and expenses over HTTP: quote -> convert -> issue;
 * expired quotes refuse conversion; report groups correctly; petty-cash
 * expense posts to the ledger.
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

describe("quotes, sales report, expenses", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  const suffix = randomUUID().slice(0, 8);
  let auth: { Authorization: string };
  let branchId: string;
  let customerId: string;
  const period = new Date().toISOString().slice(0, 7);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    http = app.getHttpServer();

    const signup = await request(http).post("/auth/signup").send({
      email: `qr-${suffix}@test.local`,
      password: "a-strong-password",
      fullName: "Quote Tester",
      tenantName: "Quote Traders",
      tenantSlug: `quote-traders-${suffix}`,
    });
    const login = await request(http)
      .post("/auth/login")
      .send({ email: `qr-${suffix}@test.local`, password: "a-strong-password" });
    const tt = await request(http)
      .post("/auth/tenant-token")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .send({ tenantId: signup.body.tenantId });
    auth = { Authorization: `Bearer ${tt.body.accessToken}` };

    await request(http).post("/tenants/current/accounts/seed-defaults").set(auth);
    branchId = (
      await request(http)
        .post("/tenants/current/branches")
        .set(auth)
        .send({ code: "HQ", name: "HQ" })
    ).body.id;
    customerId = (
      await request(http)
        .post("/tenants/current/customers")
        .set(auth)
        .send({ name: "Quote Customer" })
    ).body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  test("quote -> convert -> issue carries lines and totals through", async () => {
    const quote = await request(http)
      .post("/tenants/current/quotes")
      .set(auth)
      .send({
        branchId,
        customerId,
        lines: [
          { description: "Cement bags", quantity: 10, unitPriceCents: 85_000, vatRate: "0.16" },
        ],
      });
    expect(quote.status).toBe(201);
    expect(quote.body.quoteNo).toBe(1);
    expect(quote.body.totalCents).toBe(986_000); // 8,500 + 16%

    const converted = await request(http)
      .post(`/tenants/current/quotes/${quote.body.id}/convert`)
      .set(auth);
    expect(converted.status).toBe(201);

    const issued = await request(http)
      .post(`/tenants/current/invoices/${converted.body.invoiceId}/issue`)
      .set(auth);
    expect(issued.status).toBe(201);
    expect(issued.body.totalCents).toBe(986_000);

    // Converted quotes cannot convert twice.
    const again = await request(http)
      .post(`/tenants/current/quotes/${quote.body.id}/convert`)
      .set(auth);
    expect(again.status).toBe(400);

    const list = await request(http).get("/tenants/current/quotes").set(auth);
    expect(list.body[0].status).toBe("converted");
  });

  test("expired quotes refuse conversion", async () => {
    const quote = await request(http)
      .post("/tenants/current/quotes")
      .set(auth)
      .send({
        branchId,
        customerId,
        validUntil: "2020-01-01",
        lines: [{ description: "x", quantity: 1, unitPriceCents: 100, vatRate: "0" }],
      });
    const res = await request(http)
      .post(`/tenants/current/quotes/${quote.body.id}/convert`)
      .set(auth);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/expired/i);
  });

  test("sales report groups by customer with totals", async () => {
    const report = await request(http)
      .get(`/tenants/current/reports/sales?period=${period}&groupBy=customer`)
      .set(auth);
    expect(report.status).toBe(200);
    expect(report.body.rows).toHaveLength(1);
    expect(report.body.rows[0].label).toBe("Quote Customer");
    expect(Number(report.body.rows[0].net_cents)).toBe(850_000);
    expect(Number(report.body.totals.gross)).toBe(986_000);

    const bad = await request(http)
      .get(`/tenants/current/reports/sales?period=nope`)
      .set(auth);
    expect(bad.status).toBe(400);
  });

  test("petty-cash expense posts DR expense / CR cash", async () => {
    const res = await request(http)
      .post("/tenants/current/expenses")
      .set(auth)
      .send({ description: "Airtime for deliveries", amountCents: 20_000, paidVia: "cash" });
    expect(res.status).toBe(201);
    expect(res.body.journalEntryId).toBeTruthy();

    const list = await request(http).get("/tenants/current/expenses").set(auth);
    expect(list.body[0].memo).toBe("Airtime for deliveries");
    expect(Number(list.body[0].amount_cents)).toBe(20_000);

    const tb = await request(http)
      .get("/tenants/current/accounts/trial-balance")
      .set(auth);
    const cash = tb.body.find((a: { code: string }) => a.code === "1000");
    expect(cash.balanceCents).toBe(-20_000); // cash went out
  });
});
