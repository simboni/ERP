import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { TenantTokenClaims } from "@jenga/shared";
import {
  JwtAuthGuard,
  Roles,
  RolesGuard,
  TenantClaims,
  TenantContextGuard,
} from "../auth/guards";
import { DbService } from "../db/db.service";

const HR_ROLES = ["owner", "admin"] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_KINDS = ["performance", "training", "disciplinary", "general"];

/**
 * HR suite: departments & designations, leave management with per-policy
 * annual balances (approved days count against days_per_year for the
 * request's calendar year), and announcements. HR+ adds salary history
 * (auto-recorded on gross changes), employee notes, trainings with
 * attendee rosters, and a workforce report. All tenant-scoped via RLS.
 */
@Controller("tenants/current/hr")
@UseGuards(JwtAuthGuard, TenantContextGuard, RolesGuard)
export class HrController {
  constructor(private readonly db: DbService) {}

  @Get("overview")
  async overview(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const [headcount, onLeave, pending, announcements] = await Promise.all([
        client.query(
          `SELECT coalesce(d.name, 'Unassigned') AS department,
                  count(e.id)::int AS employees,
                  sum(e.gross_cents)::bigint AS gross_cents
           FROM employees e
           LEFT JOIN departments d ON d.id = e.department_id
           WHERE e.status = 'active'
           GROUP BY 1 ORDER BY 2 DESC`,
        ),
        client.query(
          `SELECT lr.id, e.full_name, lp.name AS policy, lr.start_date,
                  lr.end_date
           FROM leave_requests lr
           JOIN employees e ON e.id = lr.employee_id
           JOIN leave_policies lp ON lp.id = lr.policy_id
           WHERE lr.status = 'approved'
             AND current_date BETWEEN lr.start_date AND lr.end_date
           ORDER BY lr.end_date`,
        ),
        client.query(
          `SELECT lr.id, e.full_name, lp.name AS policy, lr.start_date,
                  lr.end_date, lr.days, lr.reason
           FROM leave_requests lr
           JOIN employees e ON e.id = lr.employee_id
           JOIN leave_policies lp ON lp.id = lr.policy_id
           WHERE lr.status = 'pending'
           ORDER BY lr.created_at
           LIMIT 20`,
        ),
        client.query(
          `SELECT id, title, body, created_at
           FROM announcements ORDER BY created_at DESC LIMIT 5`,
        ),
      ]);
      return {
        headcount: headcount.rows,
        onLeaveToday: onLeave.rows,
        pendingRequests: pending.rows,
        announcements: announcements.rows,
      };
    });
  }

  @Get("employees")
  async listEmployees(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT e.id, e.full_name, e.gross_cents, e.status, e.designation,
                e.hired_on, e.msisdn, d.id AS department_id,
                d.name AS department
         FROM employees e
         LEFT JOIN departments d ON d.id = e.department_id
         ORDER BY e.full_name`,
      );
      return res.rows;
    });
  }

  @Get("departments")
  async listDepartments(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT d.id, d.name, count(e.id)::int AS employees
         FROM departments d
         LEFT JOIN employees e
           ON e.department_id = d.id AND e.status = 'active'
         GROUP BY d.id ORDER BY d.name`,
      );
      return res.rows;
    });
  }

  @Post("departments")
  @Roles(...HR_ROLES)
  async createDepartment(
    @TenantClaims() claims: TenantTokenClaims,
    @Body() body: { name?: string },
  ) {
    if (!body?.name?.trim()) throw new BadRequestException("name is required");
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `INSERT INTO departments (tenant_id, name)
         VALUES ($1, $2) RETURNING id, name`,
        [claims.tid, body.name!.trim()],
      );
      return res.rows[0];
    });
  }

  @Patch("employees/:id")
  @Roles(...HR_ROLES)
  async updateEmployee(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) employeeId: string,
    @Body()
    body: {
      departmentId?: string | null;
      designation?: string | null;
      fullName?: string;
      msisdn?: string;
      kraPin?: string;
      grossCents?: number;
      status?: "active" | "inactive";
    },
  ) {
    if (
      body.grossCents !== undefined &&
      (!Number.isInteger(body.grossCents) || body.grossCents <= 0)
    ) {
      throw new BadRequestException("grossCents must be a positive integer");
    }
    if (body.status && !["active", "inactive"].includes(body.status)) {
      throw new BadRequestException("status must be active | inactive");
    }
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const before = await client.query(
        "SELECT gross_cents::bigint AS gross_cents FROM employees WHERE id = $1",
        [employeeId],
      );
      if (!before.rows[0]) throw new BadRequestException("Employee not found");
      const oldGross = Number(before.rows[0].gross_cents);
      const res = await client.query(
        `UPDATE employees
         SET department_id = coalesce($2, department_id),
             designation   = coalesce($3, designation),
             full_name     = coalesce($4, full_name),
             msisdn        = coalesce($5, msisdn),
             kra_pin       = coalesce($6, kra_pin),
             gross_cents   = coalesce($7, gross_cents),
             status        = coalesce($8, status)
         WHERE id = $1
         RETURNING id, full_name, department_id, designation, msisdn,
                   kra_pin, gross_cents, status`,
        [
          employeeId,
          body.departmentId ?? null,
          body.designation ?? null,
          body.fullName?.trim() || null,
          body.msisdn?.trim() || null,
          body.kraPin?.trim() || null,
          body.grossCents ?? null,
          body.status ?? null,
        ],
      );
      if (!res.rows[0]) throw new BadRequestException("Employee not found");
      // Salary history: one date-stamped row per actual gross change.
      if (body.grossCents !== undefined && body.grossCents !== oldGross) {
        await client.query(
          `INSERT INTO employee_salary_history
             (tenant_id, employee_id, effective_date, gross_cents, note, created_by)
           VALUES ($1, $2, current_date, $3, $4, $5)`,
          [
            claims.tid,
            employeeId,
            body.grossCents,
            `Changed from KES ${(oldGross / 100).toLocaleString("en-KE")}`,
            claims.sub,
          ],
        );
      }
      return res.rows[0];
    });
  }

  @Get("employees/:id/salary-history")
  async salaryHistory(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) employeeId: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT id, effective_date, gross_cents::bigint AS gross_cents,
                note, created_at
         FROM employee_salary_history
         WHERE employee_id = $1
         ORDER BY effective_date DESC, created_at DESC
         LIMIT 200`,
        [employeeId],
      );
      return res.rows;
    });
  }

  @Get("employees/:id/notes")
  async listNotes(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) employeeId: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT id, kind, body, noted_on, created_at
         FROM employee_notes
         WHERE employee_id = $1
         ORDER BY noted_on DESC, created_at DESC
         LIMIT 200`,
        [employeeId],
      );
      return res.rows;
    });
  }

  @Post("employees/:id/notes")
  @Roles(...HR_ROLES)
  async createNote(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) employeeId: string,
    @Body() body: { kind?: string; body?: string; notedOn?: string },
  ) {
    if (!NOTE_KINDS.includes(body?.kind ?? "")) {
      throw new BadRequestException(
        `kind must be one of: ${NOTE_KINDS.join(", ")}`,
      );
    }
    if (!body?.body?.trim()) throw new BadRequestException("body is required");
    if (body.notedOn !== undefined && !DATE_RE.test(body.notedOn)) {
      throw new BadRequestException("notedOn must be YYYY-MM-DD");
    }
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const emp = await client.query(
        "SELECT id FROM employees WHERE id = $1",
        [employeeId],
      );
      if (!emp.rows[0]) throw new BadRequestException("Employee not found");
      const res = await client.query(
        `INSERT INTO employee_notes
           (tenant_id, employee_id, kind, body, noted_on, created_by)
         VALUES ($1, $2, $3, $4, coalesce($5::date, current_date), $6)
         RETURNING id, kind, body, noted_on, created_at`,
        [
          claims.tid,
          employeeId,
          body.kind,
          body.body!.trim(),
          body.notedOn ?? null,
          claims.sub,
        ],
      );
      return res.rows[0];
    });
  }

  @Get("trainings")
  async listTrainings(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT t.id, t.name, t.provider, t.scheduled_on, t.completed,
                count(ta.id)::int AS attendee_count,
                coalesce(
                  array_agg(e.full_name ORDER BY e.full_name)
                    FILTER (WHERE e.id IS NOT NULL),
                  '{}') AS attendees
         FROM trainings t
         LEFT JOIN training_attendees ta ON ta.training_id = t.id
         LEFT JOIN employees e ON e.id = ta.employee_id
         GROUP BY t.id
         ORDER BY t.completed, t.scheduled_on DESC
         LIMIT 200`,
      );
      return res.rows;
    });
  }

  @Post("trainings")
  @Roles(...HR_ROLES)
  async createTraining(
    @TenantClaims() claims: TenantTokenClaims,
    @Body() body: { name?: string; provider?: string; scheduledOn?: string },
  ) {
    if (!body?.name?.trim()) throw new BadRequestException("name is required");
    if (!DATE_RE.test(body?.scheduledOn ?? "")) {
      throw new BadRequestException("scheduledOn must be YYYY-MM-DD");
    }
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `INSERT INTO trainings (tenant_id, name, provider, scheduled_on, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, provider, scheduled_on, completed`,
        [
          claims.tid,
          body.name!.trim(),
          body.provider?.trim() ?? "",
          body.scheduledOn,
          claims.sub,
        ],
      );
      return res.rows[0];
    });
  }

  @Post("trainings/:id/attendees")
  @Roles(...HR_ROLES)
  async addAttendee(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) trainingId: string,
    @Body() body: { employeeId?: string },
  ) {
    if (!body?.employeeId) {
      throw new BadRequestException("employeeId is required");
    }
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const tr = await client.query("SELECT id FROM trainings WHERE id = $1", [
        trainingId,
      ]);
      if (!tr.rows[0]) throw new BadRequestException("Training not found");
      try {
        const res = await client.query(
          `INSERT INTO training_attendees (tenant_id, training_id, employee_id)
           VALUES ($1, $2, $3) RETURNING id`,
          [claims.tid, trainingId, body.employeeId],
        );
        return res.rows[0];
      } catch (e) {
        if ((e as { code?: string }).code === "23505") {
          throw new BadRequestException("Already an attendee");
        }
        throw e;
      }
    });
  }

  @Post("trainings/:id/complete")
  @HttpCode(200)
  @Roles(...HR_ROLES)
  async completeTraining(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) trainingId: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `UPDATE trainings SET completed = true
         WHERE id = $1 RETURNING id, completed`,
        [trainingId],
      );
      if (!res.rows[0]) throw new BadRequestException("Training not found");
      return res.rows[0];
    });
  }

  /**
   * Workforce analytics: headcount + gross payroll by department, average
   * tenure in months (active employees with a hire date), attrition
   * (inactive count), trainings in the next 60 days and salary changes in
   * the last 90 days.
   */
  @Get("workforce-report")
  async workforceReport(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const [departments, totals, upcoming, recentChanges] = await Promise.all([
        client.query(
          `SELECT coalesce(d.name, 'Unassigned') AS department,
                  count(e.id)::int AS employees,
                  coalesce(sum(e.gross_cents), 0)::bigint AS gross_cents
           FROM employees e
           LEFT JOIN departments d ON d.id = e.department_id
           WHERE e.status = 'active'
           GROUP BY 1 ORDER BY 2 DESC, 1`,
        ),
        client.query(
          `SELECT count(*) FILTER (WHERE status = 'active')::int AS headcount,
                  coalesce(sum(gross_cents) FILTER (WHERE status = 'active'), 0)::bigint
                    AS gross_cents,
                  count(*) FILTER (WHERE status = 'inactive')::int AS inactive,
                  round(avg((current_date - hired_on) / 30.44)
                        FILTER (WHERE status = 'active' AND hired_on IS NOT NULL), 1)
                    AS avg_tenure_months
           FROM employees`,
        ),
        client.query(
          `SELECT id, name, provider, scheduled_on
           FROM trainings
           WHERE NOT completed
             AND scheduled_on BETWEEN current_date
                                  AND current_date + interval '60 days'
           ORDER BY scheduled_on
           LIMIT 50`,
        ),
        client.query(
          `SELECT sh.id, e.full_name, sh.effective_date,
                  sh.gross_cents::bigint AS gross_cents, sh.note
           FROM employee_salary_history sh
           JOIN employees e ON e.id = sh.employee_id
           WHERE sh.effective_date >= current_date - interval '90 days'
           ORDER BY sh.effective_date DESC, sh.created_at DESC
           LIMIT 50`,
        ),
      ]);
      const t = totals.rows[0];
      return {
        departments: departments.rows,
        totals: {
          headcount: t.headcount,
          grossCents: Number(t.gross_cents),
          inactive: t.inactive,
          avgTenureMonths:
            t.avg_tenure_months === null ? null : Number(t.avg_tenure_months),
        },
        upcomingTrainings: upcoming.rows,
        recentSalaryChanges: recentChanges.rows,
      };
    });
  }

  @Get("leave/policies")
  async listPolicies(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        "SELECT id, name, days_per_year FROM leave_policies ORDER BY name",
      );
      return res.rows;
    });
  }

  @Post("leave/policies")
  @Roles(...HR_ROLES)
  async createPolicy(
    @TenantClaims() claims: TenantTokenClaims,
    @Body() body: { name?: string; daysPerYear?: number },
  ) {
    if (!body?.name?.trim()) throw new BadRequestException("name is required");
    if (!body?.daysPerYear || body.daysPerYear <= 0) {
      throw new BadRequestException("daysPerYear must be positive");
    }
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `INSERT INTO leave_policies (tenant_id, name, days_per_year)
         VALUES ($1, $2, $3) RETURNING id, name, days_per_year`,
        [claims.tid, body.name!.trim(), body.daysPerYear],
      );
      return res.rows[0];
    });
  }

  @Get("leave/requests")
  async listRequests(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT lr.id, lr.start_date, lr.end_date, lr.days, lr.reason,
                lr.status, lr.created_at,
                e.full_name, lp.name AS policy
         FROM leave_requests lr
         JOIN employees e ON e.id = lr.employee_id
         JOIN leave_policies lp ON lp.id = lr.policy_id
         ORDER BY lr.created_at DESC LIMIT 200`,
      );
      return res.rows;
    });
  }

  @Post("leave/requests")
  async createRequest(
    @TenantClaims() claims: TenantTokenClaims,
    @Body()
    body: {
      employeeId?: string;
      policyId?: string;
      startDate?: string;
      endDate?: string;
      reason?: string;
    },
  ) {
    if (!body?.employeeId || !body?.policyId) {
      throw new BadRequestException("employeeId and policyId are required");
    }
    if (
      !DATE_RE.test(body?.startDate ?? "") ||
      !DATE_RE.test(body?.endDate ?? "")
    ) {
      throw new BadRequestException("startDate/endDate must be YYYY-MM-DD");
    }
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      // Working days (Mon–Fri) between the dates, inclusive.
      const daysRes = await client.query(
        `SELECT count(*)::numeric AS days
         FROM generate_series($1::date, $2::date, '1 day') AS d
         WHERE extract(isodow FROM d) < 6`,
        [body.startDate, body.endDate],
      );
      const days = Number(daysRes.rows[0].days);
      if (days <= 0) {
        throw new BadRequestException(
          "The range contains no working days (Mon–Fri)",
        );
      }
      const res = await client.query(
        `INSERT INTO leave_requests
           (tenant_id, employee_id, policy_id, start_date, end_date, days, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, days, status`,
        [
          claims.tid,
          body.employeeId,
          body.policyId,
          body.startDate,
          body.endDate,
          days,
          body.reason?.trim() ?? "",
        ],
      );
      return res.rows[0];
    });
  }

  @Post("leave/requests/:id/decide")
  @HttpCode(200)
  @Roles(...HR_ROLES)
  async decide(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) requestId: string,
    @Body() body: { approve?: boolean },
  ) {
    if (typeof body?.approve !== "boolean") {
      throw new BadRequestException("approve (boolean) is required");
    }
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const reqRes = await client.query(
        `SELECT lr.*, lp.days_per_year FROM leave_requests lr
         JOIN leave_policies lp ON lp.id = lr.policy_id
         WHERE lr.id = $1 FOR UPDATE OF lr`,
        [requestId],
      );
      const req = reqRes.rows[0];
      if (!req) throw new BadRequestException("Request not found");
      if (req.status !== "pending") {
        throw new BadRequestException(`Already ${req.status}`);
      }
      if (body.approve) {
        // Balance check: approved days this policy+employee+year.
        const usedRes = await client.query(
          `SELECT coalesce(sum(days), 0)::numeric AS used
           FROM leave_requests
           WHERE employee_id = $1 AND policy_id = $2 AND status = 'approved'
             AND extract(year FROM start_date) = extract(year FROM $3::date)`,
          [req.employee_id, req.policy_id, req.start_date],
        );
        const used = Number(usedRes.rows[0].used);
        const balance = Number(req.days_per_year) - used;
        if (Number(req.days) > balance) {
          throw new BadRequestException(
            `Insufficient balance: ${balance} of ${req.days_per_year} days left, requested ${req.days}`,
          );
        }
      }
      const res = await client.query(
        `UPDATE leave_requests
         SET status = $2, decided_by = $3, decided_at = now()
         WHERE id = $1 RETURNING id, status`,
        [requestId, body.approve ? "approved" : "rejected", claims.sub],
      );
      return res.rows[0];
    });
  }

  /**
   * Check an employee in for today (Nairobi time). Late after 09:05.
   * Idempotent: a second check-in the same day returns the existing row.
   */
  @Post("attendance/check-in")
  @HttpCode(200)
  async checkIn(
    @TenantClaims() claims: TenantTokenClaims,
    @Body() body: { employeeId?: string },
  ) {
    if (!body?.employeeId) {
      throw new BadRequestException("employeeId is required");
    }
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `INSERT INTO attendance (tenant_id, employee_id, work_date, late)
         VALUES ($1, $2, (now() AT TIME ZONE 'Africa/Nairobi')::date,
                 (now() AT TIME ZONE 'Africa/Nairobi')::time > time '09:05')
         ON CONFLICT (tenant_id, employee_id, work_date) DO UPDATE
           SET employee_id = EXCLUDED.employee_id
         RETURNING id, work_date, check_in, check_out, late,
                   (xmax = 0) AS created`,
        [claims.tid, body.employeeId],
      );
      return res.rows[0];
    });
  }

  @Post("attendance/check-out")
  @HttpCode(200)
  async checkOut(
    @TenantClaims() claims: TenantTokenClaims,
    @Body() body: { employeeId?: string },
  ) {
    if (!body?.employeeId) {
      throw new BadRequestException("employeeId is required");
    }
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `UPDATE attendance SET check_out = now()
         WHERE employee_id = $1
           AND work_date = (now() AT TIME ZONE 'Africa/Nairobi')::date
           AND check_out IS NULL
         RETURNING id, check_in, check_out`,
        [body.employeeId],
      );
      if (!res.rows[0]) {
        throw new BadRequestException("No open check-in for today");
      }
      return res.rows[0];
    });
  }

  /** Today's roster + this month's in-time/late/absent totals. */
  @Get("attendance")
  async attendance(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const [today, month] = await Promise.all([
        client.query(
          `SELECT e.id AS employee_id, e.full_name,
                  a.check_in, a.check_out, a.late
           FROM employees e
           LEFT JOIN attendance a
             ON a.employee_id = e.id
            AND a.work_date = (now() AT TIME ZONE 'Africa/Nairobi')::date
           WHERE e.status = 'active'
           ORDER BY e.full_name`,
        ),
        client.query(
          `SELECT count(*) FILTER (WHERE NOT late)::int AS in_time,
                  count(*) FILTER (WHERE late)::int AS late
           FROM attendance
           WHERE date_trunc('month', work_date)
                 = date_trunc('month', (now() AT TIME ZONE 'Africa/Nairobi')::date)`,
        ),
      ]);
      const workingDaysRes = await client.query(
        `SELECT count(*)::int AS days
         FROM generate_series(
                date_trunc('month', (now() AT TIME ZONE 'Africa/Nairobi')::date)::date,
                (now() AT TIME ZONE 'Africa/Nairobi')::date, '1 day') d
         WHERE extract(isodow FROM d) < 6`,
      );
      const active = today.rows.length;
      const expected = active * workingDaysRes.rows[0].days;
      const inTime = month.rows[0].in_time;
      const late = month.rows[0].late;
      return {
        today: today.rows,
        month: {
          inTime,
          late,
          absent: Math.max(0, expected - inTime - late),
        },
      };
    });
  }

  @Get("announcements")
  async listAnnouncements(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT id, title, body, created_at
         FROM announcements ORDER BY created_at DESC LIMIT 50`,
      );
      return res.rows;
    });
  }

  @Post("announcements")
  @Roles(...HR_ROLES)
  async createAnnouncement(
    @TenantClaims() claims: TenantTokenClaims,
    @Body() body: { title?: string; body?: string },
  ) {
    if (!body?.title?.trim()) {
      throw new BadRequestException("title is required");
    }
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `INSERT INTO announcements (tenant_id, title, body, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id, title, created_at`,
        [claims.tid, body.title!.trim(), body.body?.trim() ?? "", claims.sub],
      );
      return res.rows[0];
    });
  }
}
