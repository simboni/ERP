# Implementation Spec — HR Extensions (D365 HR slice): Salary History, Performance Notes, Training, HR Reports

**Scope:** new migration `0017_hr_extensions.sql`, new controller `apps/api/src/payroll/hr-extras.controller.ts`, ~6-line change in `payroll.service.ts` (as-of gross), 2-line change in `payroll.controller.ts` (initial salary row), 3 new tabs on `apps/web/app/(app)/hr/page.tsx`, demo-data additions, 2 i18n keys. Budget ≈ 760 changed lines.

---

## 1) Migration — `db/migrations/0017_hr_extensions.sql` (complete, paste-ready)

```sql
-- 0017: HR extensions — salary history (increments with effective dates that
-- feed payroll gross as-of the period), performance notes (goals & reviews),
-- and training records. Same tenancy contract as every table.

CREATE TABLE salary_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  employee_id    uuid NOT NULL REFERENCES employees (id),
  gross_cents    bigint NOT NULL CHECK (gross_cents > 0),
  effective_from date NOT NULL,
  note           text NOT NULL DEFAULT '',
  created_by     uuid REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, employee_id, effective_from)
);
CREATE INDEX salary_history_emp_idx
  ON salary_history (tenant_id, employee_id, effective_from DESC);
ALTER TABLE salary_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_history FORCE ROW LEVEL SECURITY;
CREATE POLICY salary_history_tenant ON salary_history
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
-- Increments are immutable history: no UPDATE/DELETE grant.
GRANT SELECT, INSERT ON salary_history TO jenga_app;

-- Backfill: every existing employee gets a baseline record so the history
-- report is never empty. Runs as migration owner (bypasses RLS by design).
INSERT INTO salary_history (tenant_id, employee_id, gross_cents, effective_from, note)
SELECT e.tenant_id, e.id, e.gross_cents,
       coalesce(e.hired_on, e.created_at::date), 'Baseline (backfilled)'
FROM employees e
WHERE e.gross_cents > 0;

CREATE TABLE performance_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  employee_id uuid NOT NULL REFERENCES employees (id),
  kind        text NOT NULL CHECK (kind IN ('goal', 'review')),
  title       text NOT NULL,
  body        text NOT NULL DEFAULT '',
  rating      int CHECK (rating BETWEEN 1 AND 5),
  status      text NOT NULL DEFAULT 'open'
              CHECK (status IN ('open', 'achieved', 'dropped')),
  noted_on    date NOT NULL DEFAULT current_date,
  created_by  uuid REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- ratings belong to reviews; goal lifecycle belongs to goals
  CHECK (kind = 'review' OR rating IS NULL),
  CHECK (kind = 'goal' OR status = 'open')
);
CREATE INDEX performance_notes_emp_idx
  ON performance_notes (tenant_id, employee_id, noted_on DESC);
ALTER TABLE performance_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY performance_notes_tenant ON performance_notes
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON performance_notes TO jenga_app;

CREATE TABLE training_records (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  employee_id  uuid NOT NULL REFERENCES employees (id),
  course       text NOT NULL,
  provider     text NOT NULL DEFAULT '',
  completed_on date,                        -- NULL = planned / in progress
  expires_on   date,                        -- NULL = never expires
  cost_cents   bigint NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  created_by   uuid REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_on IS NULL OR completed_on IS NULL OR expires_on >= completed_on)
);
CREATE INDEX training_records_emp_idx
  ON training_records (tenant_id, employee_id, completed_on DESC);
ALTER TABLE training_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_records FORCE ROW LEVEL SECURITY;
CREATE POLICY training_records_tenant ON training_records
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON training_records TO jenga_app;
```

---

## 2) API changes

### 2a. Payroll gross becomes as-of (`apps/api/src/payroll/payroll.service.ts`)

In `draftRun`, replace the employees query (lines 64–67) with the as-of resolution — `periodEnd(args.period)` is already available in the file:

```ts
const employees = await client.query(
  `SELECT e.id,
          coalesce(
            (SELECT sh.gross_cents FROM salary_history sh
             WHERE sh.employee_id = e.id AND sh.effective_from <= $1::date
             ORDER BY sh.effective_from DESC LIMIT 1),
            e.gross_cents) AS gross_cents
   FROM employees e
   WHERE e.status = 'active' ORDER BY e.created_at`,
  [periodEnd(args.period)],
);
```

Semantics: the run for `2026-06` uses the salary effective on `2026-06-30`; a July increment does not touch a June draft. `coalesce` falls back to `employees.gross_cents` for employees with no history rows (defensive; backfill + 2b make this rare). Nothing else in payroll changes — commit/posting path untouched.

### 2b. Initial salary row on onboarding (`apps/api/src/payroll/payroll.controller.ts`)

In `createEmployee`, after the `INSERT INTO employees ... RETURNING id`, add (inside the same `withTenant` transaction, before the audit call):

```ts
await client.query(
  `INSERT INTO salary_history (tenant_id, employee_id, gross_cents, effective_from, note, created_by)
   VALUES ($1, $2, $3, current_date, 'Starting salary', $4)`,
  [claims.tid, res.rows[0].id, body.grossCents, claims.sub],
);
```

### 2c. New controller — `apps/api/src/payroll/hr-extras.controller.ts`

Register in `app.module.ts` controllers array next to `HrController`. Same guard stack as `HrController`: `@Controller("tenants/current/hr")`, `@UseGuards(JwtAuthGuard, TenantContextGuard, RolesGuard)`. Inject `DbService` and `AuditService`. `const HR_ROLES = ["owner", "admin"] as const;` and the same `DATE_RE`.

**Routes:**

| Method | Path | Roles | Behavior |
|---|---|---|---|
| GET | `hr/salary-history` | any member | All rows joined to employee name, newest first, LIMIT 500 |
| POST | `hr/employees/:id/salary` | owner, admin | Insert increment; sync `employees.gross_cents`; audit `hr.salary_changed` |
| GET | `hr/performance` | any member | All notes joined to employee name, LIMIT 500 |
| POST | `hr/employees/:id/performance` | owner, admin | Insert goal or review |
| PATCH | `hr/performance/:noteId` | owner, admin | Goal lifecycle: `{ status: "achieved" \| "dropped" }` |
| GET | `hr/training` | any member | All records joined to employee name, LIMIT 500, with derived status |
| POST | `hr/employees/:id/training` | owner, admin | Insert training record |
| GET | `hr/reports` | any member | `{ headcountTrend, salaryHistory, leaveUtilization }` |

**POST `hr/employees/:id/salary`** — body `{ grossCents: number; effectiveFrom: string; note?: string }`. Validate: `Number.isInteger(grossCents) && grossCents > 0`; `DATE_RE.test(effectiveFrom)`. Inside `withTenant`:

```sql
-- 1) verify employee exists (SELECT id FROM employees WHERE id = $1) else BadRequest
-- 2) insert (unique violation code 23505 → BadRequest "A salary record already exists for that date")
INSERT INTO salary_history (tenant_id, employee_id, gross_cents, effective_from, note, created_by)
VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, gross_cents, effective_from;
-- 3) sync current gross (no-op when the new record is future-dated):
UPDATE employees e
SET gross_cents = sh.gross_cents
FROM (SELECT gross_cents FROM salary_history
      WHERE employee_id = $1 AND effective_from <= current_date
      ORDER BY effective_from DESC LIMIT 1) sh
WHERE e.id = $1;
```
Then `audit.record` with `action: "hr.salary_changed"`, `entityType: "employee"`, `entityId`, `payload: { grossCents, effectiveFrom }`. Return the inserted row.

**GET `hr/salary-history`:**

```sql
SELECT sh.id, sh.employee_id, e.full_name, sh.gross_cents, sh.effective_from, sh.note,
       sh.gross_cents - lag(sh.gross_cents) OVER
         (PARTITION BY sh.employee_id ORDER BY sh.effective_from) AS delta_cents
FROM salary_history sh JOIN employees e ON e.id = sh.employee_id
ORDER BY e.full_name, sh.effective_from DESC LIMIT 500
```
(Window runs before ORDER BY, so `delta_cents` is the increment over the previous effective record; NULL on the baseline row.)

**POST `hr/employees/:id/performance`** — body `{ kind: "goal" | "review"; title: string; body?: string; rating?: number; notedOn?: string }`. Validate: kind in set; title non-empty; if `kind === "review"` require `Number.isInteger(rating) && rating >= 1 && rating <= 5`; if `kind === "goal"` reject a rating; `notedOn` optional but must match `DATE_RE` when present (default `current_date`). Plain INSERT returning row.

**PATCH `hr/performance/:noteId`** — body `{ status: "achieved" | "dropped" }`:

```sql
UPDATE performance_notes SET status = $2
WHERE id = $1 AND kind = 'goal' AND status = 'open'
RETURNING id, status
```
No row → `BadRequestException("Goal not found or already closed")`.

**POST `hr/employees/:id/training`** — body `{ course: string; provider?: string; completedOn?: string; expiresOn?: string; costCents?: number }`. Validate course non-empty; dates match `DATE_RE` when present; `costCents` integer ≥ 0 (default 0). Plain INSERT.

**GET `hr/training`:**

```sql
SELECT t.id, t.employee_id, e.full_name, t.course, t.provider, t.completed_on,
       t.expires_on, t.cost_cents,
       CASE WHEN t.completed_on IS NULL THEN 'planned'
            WHEN t.expires_on IS NOT NULL AND t.expires_on < current_date THEN 'expired'
            ELSE 'valid' END AS status
FROM training_records t JOIN employees e ON e.id = t.employee_id
ORDER BY coalesce(t.completed_on, current_date) DESC, t.created_at DESC LIMIT 500
```

**GET `hr/reports`** — three parallel queries (Promise.all, mirroring `overview`):

Headcount trend (12 months; based on hire date of currently-active employees — no termination-date column exists, document this in a code comment):

```sql
SELECT to_char(m, 'YYYY-MM') AS month, count(e.id)::int AS headcount
FROM generate_series(
       date_trunc('month', current_date) - interval '11 months',
       date_trunc('month', current_date), interval '1 month') AS m
LEFT JOIN employees e
  ON e.status = 'active'
 AND coalesce(e.hired_on, e.created_at::date) < (m + interval '1 month')::date
GROUP BY m ORDER BY m
```

Salary history per employee (current + baseline + increment count):

```sql
SELECT e.id AS employee_id, e.full_name,
       min(sh.effective_from) AS first_effective,
       (array_agg(sh.gross_cents ORDER BY sh.effective_from DESC))[1] AS current_gross_cents,
       (array_agg(sh.gross_cents ORDER BY sh.effective_from ASC))[1]  AS starting_gross_cents,
       count(*)::int - 1 AS increments
FROM salary_history sh JOIN employees e ON e.id = sh.employee_id
WHERE e.status = 'active' AND sh.effective_from <= current_date
GROUP BY e.id, e.full_name ORDER BY e.full_name
```

Leave utilization (current calendar year, per active employee × policy, only pairs with activity or allowance):

```sql
SELECT e.id AS employee_id, e.full_name, lp.name AS policy,
       lp.days_per_year,
       coalesce(sum(lr.days) FILTER (WHERE lr.status = 'approved'), 0)::numeric AS used_days
FROM employees e
CROSS JOIN leave_policies lp
LEFT JOIN leave_requests lr
  ON lr.employee_id = e.id AND lr.policy_id = lp.id
 AND extract(year FROM lr.start_date) = extract(year FROM current_date)
WHERE e.status = 'active'
GROUP BY e.id, e.full_name, lp.name, lp.days_per_year
HAVING coalesce(sum(lr.days) FILTER (WHERE lr.status = 'approved'), 0) > 0
    OR lp.name = 'Annual leave'
ORDER BY e.full_name, lp.name
```
Response shape: `{ headcountTrend: [...], salaryHistory: [...], leaveUtilization: [...] }` — client computes `pct = used_days / days_per_year`.

---

## 3) Web — extend `apps/web/app/(app)/hr/page.tsx`

Extend `type Tab` with `"salary" | "performance" | "training" | "reports"` and append to the tab-label array: `["salary", "Salary"], ["performance", "Performance"], ["training", "Training"], ["reports", "Reports"]`. Load the four new endpoints in `loadAll`'s `Promise.all` (reports may load lazily on tab switch if preferred; simplest is eager, matching existing style). New tabs use the shared `DataTable` component (`import { DataTable } from "@/components/DataTable"` — check existing import style in `invoices/page.tsx`).

**Salary tab**
- Card "Record salary change": selects/inputs — Employee (activeEmployees dropdown), New gross (KES/month, number → `Math.round(Number(v) * 100)` cents), Effective from (date), Note (text). POST `/tenants/current/hr/employees/{id}/salary`; success msg "Salary recorded — payroll runs for periods on/after the effective date use the new gross."
- Card "Salary history" with `DataTable<SalaryRow>`: columns `full_name` (Employee), `effective_from` (Effective, `d10`), `gross_cents` (Gross, `num`, `fmtKes0`), `delta_cents` (Change, `num`, render green `+` / red `−` via `fmtKes0`, "—" when null = baseline), `note` (Note, muted). `searchKeys={["full_name", "note"]}`, `csvName="salary-history.csv"`, empty state "No salary records yet."

**Performance tab**
- Card "Add entry": Employee dropdown; Kind select (Goal/Review); Title; Details textarea; Rating select 1–5 shown only when Kind = Review. POST `/tenants/current/hr/employees/{id}/performance`.
- `DataTable<PerfRow>`: columns Employee, Kind (pill: `sent` for goal, `paid` for review), Title, Rating (render `"★".repeat(rating)` or "—"), Status (pill: `pending`=open, `paid`=achieved, `overdue`=dropped; reviews render "—"), Date (`noted_on`). Row action column for open goals: two small buttons "Achieved" / "Drop" → PATCH `/tenants/current/hr/performance/{id}`.

**Training tab**
- Card "Record training": Employee, Course, Provider, Completed on (date, optional — blank = planned), Expires on (date, optional), Cost (KES → cents). POST `/tenants/current/hr/employees/{id}/training`.
- `DataTable<TrainingRow>`: Employee, Course, Provider, Completed (`d10` or "—"), Expires (`d10` or "—"), Cost (`num`, `fmtKes0`), Status pill (`paid`=valid, `pending`=planned, `overdue`=expired). `csvName="training.csv"`.

**Reports tab** (no DataTable-less bespoke widgets — reuse existing patterns)
- Card "Headcount trend (12 months)": reuse the `bar-row`/`bar-track`/`bar-fill` pattern already in this page (one row per month, width ∝ headcount / max).
- Card "Salary progression": plain table — Employee, Starting, Current (`fmtKes0`), Growth % (`(cur - start) / start`, "—" when start = 0), Increments.
- Card "Leave utilization (this year)": one `bar-row` per employee×policy — label `${full_name} · ${policy}`, fill width `min(100, used/allowance*100)%`, color `var(--ok)` under 80%, `var(--warn)` 80–100%, `var(--danger)` over; amount `“{used}/{days_per_year}d”`.

**i18n** (`apps/web/lib/i18n.tsx`): add to both dicts — `hrSalary: "Salary" / "Mshahara"`, `hrTraining: "Training" / "Mafunzo"`. (Nav is unchanged; tab labels may use `t()` where the page already does, otherwise literal strings match the page's current all-English tabs — add the two keys anyway per module convention.)

---

## 4) Test cases (API e2e, same harness as existing payroll tests)

1. **As-of gross feeds payroll.** Create employee at gross 50,000_00; POST salary `{grossCents: 60_000_00, effectiveFrom: "2026-07-01"}`. Draft run for `2026-06` → item `gross_cents = 5000000`; draft run for `2026-07` → `6000000`. Also assert `employees.gross_cents` was synced to `6000000` (effective date ≤ today).
2. **Future-dated increment does not change current gross.** POST salary with `effectiveFrom` = today + 60d → `employees.gross_cents` unchanged; GET `hr/salary-history` shows the row; a draft run for the current period still uses the old gross.
3. **Duplicate effective date rejected.** Two POSTs for the same employee with the same `effectiveFrom` → second returns 400 (unique violation mapped), not 500.
4. **Goal lifecycle + review validation.** POST performance `{kind:"review"}` without rating → 400; with `rating: 5` → 201. POST `{kind:"goal", rating: 3}` → 400. PATCH goal to `achieved` → 200; second PATCH → 400 "already closed".
5. **RLS isolation.** Tenant B token: GET `hr/salary-history`, `hr/training`, `hr/reports` return empty arrays / zero-headcount trend despite tenant A's data existing (standard cross-tenant probe used by other module tests).

---

## 5) Demo data — extend `seedHrCrm` in `apps/api/src/tenants/demo-data.controller.ts`

Append inside the existing `withTenant` block (after leave seeding; existing `rnd/pick/int/iso` helpers and `emps` result are in scope; the departments guard already prevents double-seeding):

```ts
// Salary history: baseline at hire + 1–2 increments of 5–15%.
for (const e of emps.rows) {
  const cur = await client.query(
    "SELECT gross_cents FROM employees WHERE id = $1", [e.id]);
  let gross = Number(cur.rows[0].gross_cents);
  const steps = int(1, 2);
  for (let s = steps; s >= 1; s--) {
    await client.query(
      `INSERT INTO salary_history (tenant_id, employee_id, gross_cents, effective_from, note)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, employee_id, effective_from) DO NOTHING`,
      [claims.tid, e.id, gross, iso(-int(30, 200) * s),
       s === steps ? "Annual increment" : "Performance increment"],
    );
    gross = Math.round(gross / (1 + int(5, 15) / 100));
  }
  await client.query(
    `INSERT INTO salary_history (tenant_id, employee_id, gross_cents, effective_from, note)
     VALUES ($1, $2, $3, coalesce((SELECT hired_on FROM employees WHERE id = $2), $4), 'Starting salary')
     ON CONFLICT (tenant_id, employee_id, effective_from) DO NOTHING`,
    [claims.tid, e.id, gross, iso(-900)],
  );
}
// Performance: one open goal + one rated review per employee.
const GOALS = ["Hit quarterly sales target", "Close month-end in 3 days", "Zero stockouts", "Improve NPS to 60"];
const REVIEWS = ["H1 performance review", "Probation review", "Annual review"];
for (const e of emps.rows) {
  await client.query(
    `INSERT INTO performance_notes (tenant_id, employee_id, kind, title, noted_on)
     VALUES ($1, $2, 'goal', $3, $4)`,
    [claims.tid, e.id, pick(GOALS), iso(-int(10, 90))]);
  await client.query(
    `INSERT INTO performance_notes (tenant_id, employee_id, kind, title, rating, noted_on)
     VALUES ($1, $2, 'review', $3, $4, $5)`,
    [claims.tid, e.id, pick(REVIEWS), int(2, 5), iso(-int(30, 180))]);
}
// Training: mix of completed, planned, and one expiring cert.
const COURSES: [string, string, number][] = [
  ["First Aid & Fire Safety", "St John Ambulance", 350000],
  ["eTIMS Compliance Workshop", "KRA", 0],
  ["Forklift Operator Cert", "NITA", 1200000],
  ["Excel for Finance", "Strathmore SBS", 800000],
];
for (const e of emps.rows) {
  const [course, provider, cost] = pick(COURSES);
  const done = rnd() < 0.7;
  await client.query(
    `INSERT INTO training_records
       (tenant_id, employee_id, course, provider, completed_on, expires_on, cost_cents)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [claims.tid, e.id, course, provider,
     done ? iso(-int(30, 400)) : null,
     done && rnd() < 0.5 ? iso(int(-20, 365)) : null, cost]);
}
```

Note: the 0017 migration backfill only covers employees existing at migration time; the seed's `ON CONFLICT DO NOTHING` keeps it safe alongside the backfill and the onboarding auto-insert (2b).

---

## 6) Out of scope (explicit)

- **Termination/exit dates** — no `terminated_on` column; headcount trend counts currently-active employees by hire date (documented in code comment).
- **Payroll retro-pay / proration** — an increment effective mid-month applies in full to that month's run; no day-level proration, no retroactive adjustment runs.
- **Salary bands, positions/jobs catalog, compensation plans** (full D365 comp management) — only per-employee gross increments.
- **Review workflows** (self-review, manager sign-off, review cycles/templates, weighted goals) — notes are flat entries with a rating.
- **Training ledger posting** — `cost_cents` is informational; no journal entry, no bill linkage.
- **Document attachments** on reviews/training certs (existing `documents` module is not linked).
- **Editing/deleting salary history rows** — immutable by grant; corrections = a new record on a later effective date.
- **Employee self-service portal / per-employee login visibility** — all HR screens remain owner/admin-operated, reads open to workspace members like the rest of the HR module.
- **PDF/CSV server-side report export** — CSV comes free from DataTable client-side only.