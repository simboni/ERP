/**
 * PII encryption + tenant export tests: national IDs are ciphertext at
 * rest and decrypted only in the owner's export; export is owner-only,
 * covers every tenant table, and lands in the audit trail.
 */
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { decryptPii, encryptPii, isEncryptedPii } from "../src/common/crypto";

process.env.APP_DB_URL =
  process.env.APP_DB_URL_TEST ??
  "postgres://jenga_app:app_dev_pw@localhost:5432/jenga_test";
process.env.WORKER_DB_URL =
  process.env.WORKER_DB_URL_TEST ??
  "postgres://jenga_worker:worker_dev_pw@localhost:5432/jenga_test";

import { AppModule } from "../src/app.module";
import { DbService } from "../src/db/db.service";

describe("PII crypto primitives", () => {
  test("round-trip, versioned format, tamper detection", () => {
    const ct = encryptPii("12345678");
    expect(ct.startsWith("v1:")).toBe(true);
    expect(isEncryptedPii(ct)).toBe(true);
    expect(decryptPii(ct)).toBe("12345678");
    // Two encryptions of the same value differ (random IV).
    expect(encryptPii("12345678")).not.toBe(ct);
    // Tampering fails the GCM tag.
    const tampered = ct.slice(0, -2) + (ct.endsWith("aa") ? "bb" : "aa");
    expect(() => decryptPii(tampered)).toThrow();
  });
});

describe("employee PII + tenant export (HTTP)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  const db = new DbService();
  const suffix = randomUUID().slice(0, 8);
  let ownerAuth: { Authorization: string };
  let tenantId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    http = app.getHttpServer();

    const signup = await request(http).post("/auth/signup").send({
      email: `pii-${suffix}@test.local`,
      password: "a-strong-password",
      fullName: "PII Owner",
      tenantName: "PII Traders",
      tenantSlug: `pii-traders-${suffix}`,
    });
    tenantId = signup.body.tenantId;
    const login = await request(http)
      .post("/auth/login")
      .send({ email: `pii-${suffix}@test.local`, password: "a-strong-password" });
    const tt = await request(http)
      .post("/auth/tenant-token")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .send({ tenantId });
    ownerAuth = { Authorization: `Bearer ${tt.body.accessToken}` };
  });

  afterAll(async () => {
    await app.close();
    await db.onModuleDestroy();
  });

  test("national ID is ciphertext at rest, plaintext in the owner's export", async () => {
    await request(http)
      .post("/tenants/current/employees")
      .set(ownerAuth)
      .send({
        fullName: "Njeri Kamande",
        grossCents: 3_000_000,
        nationalId: "34567890",
        kraPin: "A012345678Z",
      })
      .expect(201);

    // At rest: encrypted.
    const raw = await db.withTenant(tenantId, null, async (c) => {
      const r = await c.query(
        "SELECT national_id, kra_pin FROM employees WHERE full_name = 'Njeri Kamande'",
      );
      return r.rows[0];
    });
    expect(isEncryptedPii(raw.national_id)).toBe(true);
    expect(raw.national_id).not.toContain("34567890");
    expect(raw.kra_pin).toBe("A012345678Z"); // PINs print on invoices; plain by design

    // In the export: decrypted for the owner.
    const exportRes = await request(http)
      .get("/tenants/current/export")
      .set(ownerAuth);
    expect(exportRes.status).toBe(200);
    const employees = exportRes.body.data.employees;
    expect(employees[0].national_id).toBe("34567890");
    // Export covers the full table set and is audited.
    expect(Object.keys(exportRes.body.data)).toEqual(
      expect.arrayContaining(["journal_entries", "invoices", "payments", "audit_log"]),
    );
    const audit = await request(http)
      .get("/tenants/current/audit")
      .set(ownerAuth);
    expect(audit.body.map((a: { action: string }) => a.action)).toContain(
      "tenant.exported",
    );
  });

  test("export is owner-only", async () => {
    // Second user joins as accountant and is refused.
    await request(http).post("/auth/signup").send({
      email: `pii2-${suffix}@test.local`,
      password: "a-strong-password",
      fullName: "Accountant",
      tenantName: "Their Own Co",
      tenantSlug: `pii2-co-${suffix}`,
    });
    await request(http)
      .post("/tenants/current/members")
      .set(ownerAuth)
      .send({ email: `pii2-${suffix}@test.local`, role: "accountant" });
    const login2 = await request(http)
      .post("/auth/login")
      .send({ email: `pii2-${suffix}@test.local`, password: "a-strong-password" });
    const tt2 = await request(http)
      .post("/auth/tenant-token")
      .set("Authorization", `Bearer ${login2.body.accessToken}`)
      .send({ tenantId });
    const denied = await request(http)
      .get("/tenants/current/export")
      .set("Authorization", `Bearer ${tt2.body.accessToken}`);
    expect(denied.status).toBe(403);
  });
});
