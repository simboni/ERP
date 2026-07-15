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

/**
 * HR suite: departments & designations, leave management with per-policy
 * annual balances (approved days count against days_per_year for the
 * request's calendar year), and announcements. All tenant-scoped via RLS.
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
    body: { departmentId?: string | null; designation?: string | null },
  ) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `UPDATE employees
         SET department_id = coalesce($2, department_id),
             designation   = coalesce($3, designation)
         WHERE id = $1
         RETURNING id, full_name, department_id, designation`,
        [employeeId, body.departmentId ?? null, body.designation ?? null],
      );
      if (!res.rows[0]) throw new BadRequestException("Employee not found");
      return res.rows[0];
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
