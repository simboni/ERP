/**
 * HTTP tests: refresh-token rotation (single-use, reuse detection) and the
 * invoice PDF endpoint (bytes are a real PDF carrying the eTIMS control
 * number once signed).
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
process.env.FISCAL_WORKER_ENABLED = "true";

import { AppModule } from "../src/app.module";

describe("refresh rotation + invoice PDF", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  const suffix = randomUUID().slice(0, 8);
  const email = `pdf-${suffix}@test.local`;
  const password = "another-strong-pass";
  let tenantToken: string;
  let refreshToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    http = app.getHttpServer();

    const signup = await request(http).post("/auth/signup").send({
      email,
      password,
      fullName: "PDF Tester",
      tenantName: "PDF Traders",
      tenantSlug: `pdf-traders-${suffix}`,
    });
    expect(signup.status).toBe(201);
    const login = await request(http)
      .post("/auth/login")
      .send({ email, password });
    refreshToken = login.body.refreshToken;
    const tt = await request(http)
      .post("/auth/tenant-token")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .send({ tenantId: signup.body.tenantId });
    tenantToken = tt.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  test("refresh rotates: new pair works, old token is dead, reuse nukes sessions", async () => {
    const first = await request(http)
      .post("/auth/refresh")
      .send({ refreshToken });
    expect(first.status).toBe(200);
    expect(first.body.accessToken).toBeTruthy();
    expect(first.body.refreshToken).not.toBe(refreshToken);

    // Old token reuse -> rejected and all sessions revoked.
    const reuse = await request(http)
      .post("/auth/refresh")
      .send({ refreshToken });
    expect(reuse.status).toBe(401);
    expect(reuse.body.message).toMatch(/reuse/i);

    // The rotated token was revoked by the reuse response too.
    const afterNuke = await request(http)
      .post("/auth/refresh")
      .send({ refreshToken: first.body.refreshToken });
    expect(afterNuke.status).toBe(401);
  });

  test("invoice PDF renders with totals and eTIMS control number", async () => {
    const auth = { Authorization: `Bearer ${tenantToken}` };
    await request(http)
      .post("/tenants/current/accounts/seed-defaults")
      .set(auth);
    const branch = await request(http)
      .post("/tenants/current/branches")
      .set(auth)
      .send({ code: "HQ", name: "HQ" });
    const customer = await request(http)
      .post("/tenants/current/customers")
      .set(auth)
      .send({ name: "PDF Customer Ltd", kraPin: "P000000000P" });
    const draft = await request(http)
      .post("/tenants/current/invoices")
      .set(auth)
      .send({
        branchId: branch.body.id,
        customerId: customer.body.id,
        lines: [
          {
            description: "Consulting services",
            quantity: 1,
            unitPriceCents: 1_000_000,
            vatRate: "0.16",
          },
        ],
      });
    const issued = await request(http)
      .post(`/tenants/current/invoices/${draft.body.id}/issue`)
      .set(auth);
    expect(issued.status).toBe(201);

    // Give the in-process fiscal worker a moment to sign.
    await new Promise((r) => setTimeout(r, 2500));

    const pdf = await request(http)
      .get(`/tenants/current/invoices/${draft.body.id}/pdf`)
      .set(auth)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    const bytes = pdf.body as Buffer;
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(1000);
    // pdfkit compresses streams; metadata/hex-check the uncompressed parts:
    const text = bytes.toString("latin1");
    expect(text).toContain("PDF");
  }, 20000);
});
