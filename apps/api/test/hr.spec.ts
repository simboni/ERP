/**
 * HR suite: departments, leave request lifecycle with per-policy annual
 * balance enforcement, and announcements — via the controller class.
 */
import { randomUUID } from "node:crypto";
import type { TenantTokenClaims } from "@jenga/shared";
import { DbService } from "../src/db/db.service";
import { HrController } from "../src/payroll/hr.controller";

process.env.APP_DB_URL =
  process.env.APP_DB_URL_TEST ??
  "postgres://jenga_app:app_dev_pw@localhost:5432/jenga_test";
process.env.WORKER_DB_URL =
  process.env.WORKER_DB_URL_TEST ??
  "postgres://jenga_worker:worker_dev_pw@localhost:5432/jenga_test";

describe("HR suite", () => {
  const db = new DbService();
  const hr = new HrController(db);
  let claims: TenantTokenClaims;
  let employee: string;
  let policy: string;

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    const u = await db.query(
      `INSERT INTO users (email, password_hash, full_name)
       VALUES ($1, 'x', 'HR Tester') RETURNING id`,
      [`hr-${suffix}@test.local`],
    );
    const t = await db.query(
      "SELECT create_tenant_with_owner($1, $2, $3) AS id",
      ["hr-co", `hr-co-${suffix}`, u.rows[0].id],
    );
    claims = {
      sub: u.rows[0].id,
      tid: t.rows[0].id,
      rol: "owner",
      typ: "tenant",
    };
    await db.withTenant(claims.tid, claims.sub, async (c) => {
      const e = await c.query(
        `INSERT INTO employees (tenant_id, full_name, gross_cents)
         VALUES ($1, 'Amina Test', 5000000) RETURNING id`,
        [claims.tid],
      );
      employee = e.rows[0].id;
    });
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  it("creates departments and assigns employees", async () => {
    const dept = await hr.createDepartment(claims, { name: "Operations" });
    await hr.updateEmployee(claims, employee, {
      departmentId: dept.id,
      designation: "Manager",
    });
    const list = await hr.listDepartments(claims);
    const ops = list.find((d: { name: string }) => d.name === "Operations");
    expect(ops.employees).toBe(1);
    const overview = await hr.overview(claims);
    expect(
      overview.headcount.find(
        (h: { department: string }) => h.department === "Operations",
      ).employees,
    ).toBe(1);
  });

  it("computes working days and enforces the annual balance", async () => {
    const p = await hr.createPolicy(claims, {
      name: "Annual leave",
      daysPerYear: 5,
    });
    policy = p.id;

    // Mon 2026-07-20 .. Fri 2026-07-24 = 5 working days.
    const req = await hr.createRequest(claims, {
      employeeId: employee,
      policyId: policy,
      startDate: "2026-07-20",
      endDate: "2026-07-26", // includes the weekend — still 5 working days
      reason: "family",
    });
    expect(Number(req.days)).toBe(5);

    const decided = await hr.decide(claims, req.id, { approve: true });
    expect(decided.status).toBe("approved");

    // Balance exhausted: next request in the same year cannot be approved.
    const second = await hr.createRequest(claims, {
      employeeId: employee,
      policyId: policy,
      startDate: "2026-09-07",
      endDate: "2026-09-07",
    });
    await expect(
      hr.decide(claims, second.id, { approve: true }),
    ).rejects.toThrow(/Insufficient balance/);

    // Rejecting works and does not consume balance.
    const rejected = await hr.decide(claims, second.id, { approve: false });
    expect(rejected.status).toBe("rejected");
  });

  it("shows who is out today for approved current leave", async () => {
    const today = new Date().toISOString().slice(0, 10);
    // A 4-day window always contains at least one working day, and
    // current_date is inside it regardless of weekday.
    const end = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const p = await hr.createPolicy(claims, {
      name: "Sick leave",
      daysPerYear: 14,
    });
    const req = await hr.createRequest(claims, {
      employeeId: employee,
      policyId: p.id,
      startDate: today,
      endDate: end,
    });
    await hr.decide(claims, req.id, { approve: true });
    const overview = await hr.overview(claims);
    expect(
      overview.onLeaveToday.some(
        (l: { full_name: string }) => l.full_name === "Amina Test",
      ),
    ).toBe(true);
  });

  it("publishes announcements", async () => {
    await hr.createAnnouncement(claims, {
      title: "Eid holiday",
      body: "Office closed Friday.",
    });
    const list = await hr.listAnnouncements(claims);
    expect(list[0].title).toBe("Eid holiday");
  });
});
