/**
 * HR+ tests against jenga_test:
 *  - a gross change through PATCH employees/:id writes exactly one
 *    salary-history row (and none when the gross is unchanged or only
 *    other fields move),
 *  - employee notes: create + list, kind check-constraint surface and
 *    date validation, noted_on defaults to today,
 *  - trainings: create, attendee roster (duplicate attendee rejected),
 *    mark complete,
 *  - workforce report: headcount/gross by department, average tenure,
 *    attrition, upcoming trainings (60 days), recent salary changes.
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

const d10 = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
const isoPlus = (days: number): string =>
  new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

describe("HR+ (salary history, notes, trainings, workforce report)", () => {
  const db = new DbService();
  const hr = new HrController(db);
  let claims: TenantTokenClaims;
  let amina: string; // Ops, 50 000 → changed in tests
  let brian: string; // Ops, 40 000
  let training: string;

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    const u = await db.query(
      `INSERT INTO users (email, password_hash, full_name)
       VALUES ($1, 'x', 'HR+ Tester') RETURNING id`,
      [`hrplus-${suffix}@test.local`],
    );
    const t = await db.query(
      "SELECT create_tenant_with_owner($1, $2, $3) AS id",
      ["hrplus-co", `hrplus-co-${suffix}`, u.rows[0].id],
    );
    claims = {
      sub: u.rows[0].id,
      tid: t.rows[0].id,
      rol: "owner",
      typ: "tenant",
    };
    const ops = await hr.createDepartment(claims, { name: "Operations" });
    const sales = await hr.createDepartment(claims, { name: "Sales" });
    await db.withTenant(claims.tid, claims.sub, async (c) => {
      const mk = async (
        name: string,
        gross: number,
        dept: string | null,
        monthsAgo: number,
        status = "active",
      ) =>
        (
          await c.query(
            `INSERT INTO employees
               (tenant_id, full_name, gross_cents, department_id, hired_on, status)
             VALUES ($1, $2, $3, $4,
                     current_date - ($5 || ' months')::interval, $6)
             RETURNING id`,
            [claims.tid, name, gross, dept, monthsAgo, status],
          )
        ).rows[0].id as string;
      amina = await mk("Amina Odhiambo", 50_000_00, ops.id, 24);
      brian = await mk("Brian Mwangi", 40_000_00, ops.id, 12);
      await mk("Carol Wanjiru", 60_000_00, sales.id, 6);
      await mk("David Kiptoo", 30_000_00, null, 36, "inactive");
    });
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  it("writes one salary-history row per gross change, none otherwise", async () => {
    await hr.updateEmployee(claims, amina, { grossCents: 55_000_00 });
    let hist = await hr.salaryHistory(claims, amina);
    expect(hist).toHaveLength(1);
    expect(Number(hist[0].gross_cents)).toBe(55_000_00);
    expect(hist[0].note).toMatch(/Changed from/);
    expect(d10(hist[0].effective_date)).toBe(isoPlus(0));

    // Same gross again → no new row.
    await hr.updateEmployee(claims, amina, { grossCents: 55_000_00 });
    // Unrelated field only → no new row.
    await hr.updateEmployee(claims, amina, { designation: "Ops Lead" });
    hist = await hr.salaryHistory(claims, amina);
    expect(hist).toHaveLength(1);

    // Second real change → second row, newest first.
    await hr.updateEmployee(claims, amina, { grossCents: 60_000_00 });
    hist = await hr.salaryHistory(claims, amina);
    expect(hist).toHaveLength(2);
    expect(Number(hist[0].gross_cents)).toBe(60_000_00);

    // Other employees are untouched.
    expect(await hr.salaryHistory(claims, brian)).toHaveLength(0);
  });

  it("notes: kind validation, defaults, create + list", async () => {
    await expect(
      hr.createNote(claims, amina, { kind: "gossip", body: "nope" }),
    ).rejects.toThrow(/kind must be one of/);
    await expect(
      hr.createNote(claims, amina, { kind: "general", body: "  " }),
    ).rejects.toThrow(/body is required/);
    await expect(
      hr.createNote(claims, amina, {
        kind: "general",
        body: "x",
        notedOn: "yesterday",
      }),
    ).rejects.toThrow(/YYYY-MM-DD/);
    await expect(
      hr.createNote(claims, randomUUID(), { kind: "general", body: "x" }),
    ).rejects.toThrow(/Employee not found/);

    const perf = await hr.createNote(claims, amina, {
      kind: "performance",
      body: "Exceeded Q2 targets.",
      notedOn: "2026-07-01",
    });
    expect(perf.kind).toBe("performance");
    expect(d10(perf.noted_on)).toBe("2026-07-01");

    const gen = await hr.createNote(claims, amina, {
      kind: "disciplinary",
      body: "Verbal warning: late 3 times.",
    });
    expect(d10(gen.noted_on)).toBe(isoPlus(0)); // defaults to today

    const list = await hr.listNotes(claims, amina);
    expect(list).toHaveLength(2);
    expect(list[0].kind).toBe("disciplinary"); // newest noted_on first
    expect(await hr.listNotes(claims, brian)).toHaveLength(0);
  });

  it("trainings: create, attendees (duplicate rejected), complete", async () => {
    await expect(
      hr.createTraining(claims, { name: "No date" }),
    ).rejects.toThrow(/YYYY-MM-DD/);

    const tr = await hr.createTraining(claims, {
      name: "First Aid & Fire Safety",
      provider: "St John Ambulance",
      scheduledOn: isoPlus(30),
    });
    training = tr.id;
    expect(tr.completed).toBe(false);

    await hr.addAttendee(claims, training, { employeeId: amina });
    await expect(
      hr.addAttendee(claims, training, { employeeId: amina }),
    ).rejects.toThrow(/Already an attendee/);
    await hr.addAttendee(claims, training, { employeeId: brian });

    const list = await hr.listTrainings(claims);
    const row = list.find((r: { id: string }) => r.id === training);
    expect(row.attendee_count).toBe(2);
    expect(row.attendees).toEqual(["Amina Odhiambo", "Brian Mwangi"]);

    const done = await hr.completeTraining(claims, training);
    expect(done.completed).toBe(true);
    await expect(hr.completeTraining(claims, randomUUID())).rejects.toThrow(
      /Training not found/,
    );
  });

  it("workforce report: departments, tenure, attrition, trainings, changes", async () => {
    // One upcoming training inside the 60-day window, one beyond it; the
    // completed one from the previous test must not appear.
    const soon = await hr.createTraining(claims, {
      name: "eTIMS Compliance Workshop",
      provider: "KRA",
      scheduledOn: isoPlus(45),
    });
    await hr.createTraining(claims, {
      name: "Far Future Summit",
      scheduledOn: isoPlus(100),
    });

    const rep = await hr.workforceReport(claims);

    const ops = rep.departments.find(
      (d: { department: string }) => d.department === "Operations",
    );
    expect(ops.employees).toBe(2);
    expect(Number(ops.gross_cents)).toBe(100_000_00); // 60k (changed) + 40k
    const sales = rep.departments.find(
      (d: { department: string }) => d.department === "Sales",
    );
    expect(sales.employees).toBe(1);
    expect(Number(sales.gross_cents)).toBe(60_000_00);

    expect(rep.totals.headcount).toBe(3); // inactive excluded
    expect(rep.totals.grossCents).toBe(160_000_00);
    expect(rep.totals.inactive).toBe(1); // attrition
    // Hired 24, 12 and 6 months ago → average tenure ≈ 14 months.
    expect(rep.totals.avgTenureMonths).toBeGreaterThan(13);
    expect(rep.totals.avgTenureMonths).toBeLessThan(15);

    const upcomingIds = rep.upcomingTrainings.map((t: { id: string }) => t.id);
    expect(upcomingIds).toContain(soon.id);
    expect(upcomingIds).not.toContain(training); // completed
    expect(
      rep.upcomingTrainings.some(
        (t: { name: string }) => t.name === "Far Future Summit",
      ),
    ).toBe(false); // outside 60 days

    expect(rep.recentSalaryChanges).toHaveLength(2); // Amina's two changes
    expect(rep.recentSalaryChanges[0].full_name).toBe("Amina Odhiambo");
    expect(Number(rep.recentSalaryChanges[0].gross_cents)).toBe(60_000_00);
  });
});
