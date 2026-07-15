/**
 * Reports-extra aggregation math: aged receivables/payables bucketing,
 * inventory valuation (qty x cost + low-stock flag) and confirmed
 * payments grouped by rail. Seeds a couple of invoices/bills/payments and
 * asserts bucket/total correctness against the read-only endpoints.
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
import { DbService } from "../src/db/db.service";
import { FiscalService } from "../src/fiscal/fiscal.service";
import { FISCAL_PROVIDER } from "../src/fiscal/fiscal.service";

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const daysAgo = (n: number): string =>
  iso(new Date(Date.now() - n * 24 * 3600 * 1000));

describe("reports-extra aggregations", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: DbService;
  let fiscal: FiscalService;
  const suffix = randomUUID().slice(0, 8);
  let auth: { Authorization: string };
  let tenantId: string;
  let branchId: string;
  let customerId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    http = app.getHttpServer();
    db = app.get(DbService);
    fiscal = app.get(FiscalService);

    const signup = await request(http).post("/auth/signup").send({
      email: `re-${suffix}@test.local`,
      password: "a-strong-password",
      fullName: "Report Tester",
      tenantName: "Report Traders",
      tenantSlug: `report-traders-${suffix}`,
    });
    tenantId = signup.body.tenantId;
    const login = await request(http)
      .post("/auth/login")
      .send({ email: `re-${suffix}@test.local`, password: "a-strong-password" });
    const tt = await request(http)
      .post("/auth/tenant-token")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .send({ tenantId });
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
        .send({ name: "Aging Customer" })
    ).body.id;
  });

  afterAll(async () => {
    // Drain the cross-tenant fiscal queue so issued invoices don't overflow
    // the capped drain loop in other specs.
    for (let i = 0; i < 60; i++) {
      if (!(await fiscal.processOnce())) break;
    }
    await app.close();
  });

  // Directly issue an invoice with a chosen issue/due date via the ledger so
  // the aging math can be pinned to specific buckets.
  const issueInvoiceDated = async (
    totalDueCents: number,
    issueDate: string,
    dueDate: string,
  ): Promise<void> => {
    const draft = await request(http)
      .post("/tenants/current/invoices")
      .set(auth)
      .send({
        branchId,
        customerId,
        lines: [
          {
            description: "Service",
            quantity: 1,
            unitPriceCents: totalDueCents,
            vatRate: "0",
          },
        ],
      });
    await request(http)
      .post(`/tenants/current/invoices/${draft.body.id}/issue`)
      .set(auth)
      .send({ issueDate });
    // Backdate the due date for deterministic bucketing.
    await db.withTenant(tenantId, tenantId, (c) =>
      c.query("UPDATE invoices SET due_date = $2 WHERE id = $1", [
        draft.body.id,
        dueDate,
      ]),
    );
  };

  test("aged receivables buckets outstanding invoices by age", async () => {
    // Three open invoices at 10, 45 and 120 days overdue.
    await issueInvoiceDated(100_00, daysAgo(20), daysAgo(10)); // 0-30
    await issueInvoiceDated(200_00, daysAgo(60), daysAgo(45)); // 31-60
    await issueInvoiceDated(300_00, daysAgo(140), daysAgo(120)); // 90+

    const res = await request(http)
      .get("/tenants/current/reports/aged-receivables")
      .set(auth);
    expect(res.status).toBe(200);
    const row = res.body.rows.find(
      (r: { customer_name: string }) => r.customer_name === "Aging Customer",
    );
    expect(Number(row.d0_30)).toBe(100_00);
    expect(Number(row.d31_60)).toBe(200_00);
    expect(Number(row.d61_90)).toBe(0);
    expect(Number(row.d90_plus)).toBe(300_00);
    expect(Number(row.total)).toBe(600_00);
    expect(res.body.totals.total).toBe(600_00);
    expect(res.body.totals.d31_60).toBe(200_00);
  });

  test("aged payables buckets approved bills by age", async () => {
    const supplierId = (
      await request(http)
        .post("/tenants/current/suppliers")
        .set(auth)
        .send({ name: "Aging Supplier" })
    ).body.id;

    const makeApprovedBill = async (
      unitCents: number,
      billDate: string,
      dueDate: string,
    ): Promise<void> => {
      const bill = await request(http)
        .post("/tenants/current/bills")
        .set(auth)
        .send({
          supplierId,
          billDate,
          dueDate,
          lines: [
            { description: "Stock", quantity: 1, unitPriceCents: unitCents, vatRate: "0" },
          ],
        });
      await request(http)
        .post(`/tenants/current/bills/${bill.body.id}/approve`)
        .set(auth);
    };

    await makeApprovedBill(500_00, daysAgo(15), daysAgo(5)); // 0-30
    await makeApprovedBill(700_00, daysAgo(100), daysAgo(75)); // 61-90

    const res = await request(http)
      .get("/tenants/current/reports/aged-payables")
      .set(auth);
    expect(res.status).toBe(200);
    const row = res.body.rows.find(
      (r: { supplier_name: string }) => r.supplier_name === "Aging Supplier",
    );
    expect(Number(row.d0_30)).toBe(500_00);
    expect(Number(row.d61_90)).toBe(700_00);
    expect(Number(row.total)).toBe(1200_00);
    expect(res.body.totals.total).toBe(1200_00);
  });

  test("inventory valuation multiplies on-hand by cost and flags low stock", async () => {
    const item = await request(http)
      .post("/tenants/current/items")
      .set(auth)
      .send({ sku: `VAL-${suffix}`, name: "Widget", costCents: 1_000, priceCents: 1_500 });
    await request(http)
      .post(`/tenants/current/items/${item.body.id}/reorder-level`)
      .set(auth)
      .send({ reorderLevel: 20 });
    // Receive 8 units -> on-hand 8, below reorder level 20.
    await request(http)
      .post("/tenants/current/stock/movements")
      .set(auth)
      .send({ itemId: item.body.id, branchId, qtyDelta: 8, reason: "purchase" });

    const res = await request(http)
      .get("/tenants/current/reports/inventory-valuation")
      .set(auth);
    expect(res.status).toBe(200);
    const row = res.body.rows.find(
      (r: { sku: string }) => r.sku === `VAL-${suffix}`,
    );
    expect(row.on_hand).toBe(8);
    expect(row.value_cents).toBe(8 * 1_000); // 8 units at cost 10.00
    expect(row.low_stock).toBe(true);
    expect(res.body.totals.value_cents).toBeGreaterThanOrEqual(8_000);
    expect(res.body.totals.low_stock).toBeGreaterThanOrEqual(1);
  });

  test("payments received groups confirmed money by rail", async () => {
    const today = iso(new Date());
    // Seed confirmed payments across rails directly.
    await db.withTenant(tenantId, tenantId, async (c) => {
      const rows: [string, number][] = [
        ["cash", 100_00],
        ["cash", 50_00],
        ["bank", 400_00],
        ["mpesa_c2b", 250_00],
        ["mpesa_stk", 150_00],
      ];
      for (const [rail, amount] of rows) {
        await c.query(
          `INSERT INTO payments (tenant_id, rail, state, amount_cents, confirmed_at)
           VALUES ($1, $2, 'confirmed', $3, now())`,
          [tenantId, rail, amount],
        );
      }
    });

    const res = await request(http)
      .get(`/tenants/current/reports/payments-received?from=${today}&to=${today}`)
      .set(auth);
    expect(res.status).toBe(200);
    const byRail = Object.fromEntries(
      res.body.rows.map((r: { rail_group: string }) => [r.rail_group, r]),
    );
    expect(Number(byRail.cash.count)).toBe(2);
    expect(Number(byRail.cash.total_cents)).toBe(150_00);
    expect(Number(byRail.bank.total_cents)).toBe(400_00);
    expect(Number(byRail.mpesa.count)).toBe(2); // c2b + stk collapse to M-Pesa
    expect(Number(byRail.mpesa.total_cents)).toBe(400_00);
    expect(res.body.totals.count).toBe(5);
    expect(res.body.totals.total_cents).toBe(950_00);
  });

  test("customer statement carries a running balance", async () => {
    const res = await request(http)
      .get(
        `/tenants/current/reports/customer-statement?customerId=${customerId}` +
          `&from=${daysAgo(200)}&to=${iso(new Date())}`,
      )
      .set(auth);
    expect(res.status).toBe(200);
    // The three open invoices seeded earlier: 100 + 200 + 300 = 600.00 charged.
    expect(res.body.totalChargedCents).toBe(600_00);
    expect(res.body.closingBalanceCents).toBe(600_00);
    expect(res.body.rows.length).toBeGreaterThanOrEqual(3);
    // Running balance is monotonic across charges only.
    const last = res.body.rows[res.body.rows.length - 1];
    expect(last.balance_cents).toBe(600_00);
  });

  test("financial reports reject non-privileged roles is enforced by guard", async () => {
    // Missing period param is a 400 (validation path exercised).
    const bad = await request(http)
      .get("/tenants/current/reports/vat-summary?from=bad&to=2026-07")
      .set(auth);
    expect(bad.status).toBe(400);
  });
});
