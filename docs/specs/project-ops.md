# Project Operations — Implementation Spec

Slice: `projects`, `project_time_entries`, `project_expenses`, profitability endpoint, one-click "bill unbilled time" → draft invoice via `InvoicesService.createDraft`. Budget: ~750 changed lines (migration ~110, API ~330, web ~280, i18n/nav ~15, demo ~40, tests ~120 in one spec file).

---

## 1) Migration — `db/migrations/0017_projects.sql` (complete, paste as-is)

```sql
-- 0017: Project Operations — customer projects with time tracking, project
-- expenses (linked to their expense journal entry) and billing of unbilled
-- time into a draft invoice. Money in cents; rate_cents is the BILLING rate
-- per hour, cost_rate_cents the internal labour cost per hour (0 = untracked).

CREATE TABLE projects (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  customer_id  uuid NOT NULL REFERENCES customers (id),
  name         text NOT NULL,
  budget_cents bigint NOT NULL DEFAULT 0 CHECK (budget_cents >= 0),
  status       text NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'completed', 'archived')),
  created_by   uuid REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, customer_id, name)
);
CREATE INDEX projects_tenant_idx ON projects (tenant_id, status, name);
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
CREATE POLICY projects_tenant ON projects
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON projects TO jenga_app;

CREATE TABLE project_time_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  project_id      uuid NOT NULL REFERENCES projects (id),
  employee_id     uuid NOT NULL REFERENCES employees (id),
  work_date       date NOT NULL,
  hours           numeric(6,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  rate_cents      bigint NOT NULL CHECK (rate_cents >= 0),       -- billing rate/hour
  cost_rate_cents bigint NOT NULL DEFAULT 0 CHECK (cost_rate_cents >= 0),
  billable        boolean NOT NULL DEFAULT true,
  notes           text NOT NULL DEFAULT '',
  invoice_id      uuid REFERENCES invoices (id),  -- set when billed; NULL = unbilled
  created_by      uuid REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_time_project_idx
  ON project_time_entries (tenant_id, project_id, work_date DESC);
-- fast "unbilled billable time" lookup for the billing action
CREATE INDEX project_time_unbilled_idx
  ON project_time_entries (tenant_id, project_id)
  WHERE billable AND invoice_id IS NULL;
ALTER TABLE project_time_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_time_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY project_time_entries_tenant ON project_time_entries
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON project_time_entries TO jenga_app;

CREATE TABLE project_expenses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  project_id       uuid NOT NULL REFERENCES projects (id),
  description      text NOT NULL,
  amount_cents     bigint NOT NULL CHECK (amount_cents > 0),
  expense_date     date NOT NULL,
  journal_entry_id uuid NOT NULL REFERENCES journal_entries (id), -- the expense posting
  created_by       uuid REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_expenses_project_idx
  ON project_expenses (tenant_id, project_id, expense_date DESC);
ALTER TABLE project_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_expenses FORCE ROW LEVEL SECURITY;
CREATE POLICY project_expenses_tenant ON project_expenses
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT ON project_expenses TO jenga_app;  -- immutable (ledger-linked)
```

---

## 2) API — new module dir `apps/api/src/projects/`

Two files: `projects.service.ts` (billing transaction) and `projects.controller.ts`. Register `ProjectsController` in `app.module.ts` `controllers` and `ProjectsService` in `providers` (single AppModule pattern — same as `CrmController`). Guards on the controller class: `@UseGuards(JwtAuthGuard, TenantContextGuard, RolesGuard)`, base `@Controller("tenants/current")`.

Roles: `const PROJECT_ROLES = ["owner", "admin", "accountant"] as const;` on all POSTs; GETs unrestricted (any member), matching `sales-extras.controller.ts`.

### Money/derivation rule (used everywhere below)
Time entry billable amount = `computeLine({quantity: hours, unitPriceCents: rate_cents, vatRate}).totalCents`, i.e. `round(rate_cents * round(hours*1000) / 1000)`. In SQL rollups use the equivalent `round(t.rate_cents * t.hours)::bigint` (hours is numeric(6,2) so this matches integer-cents to the cent). Labour cost = `round(t.cost_rate_cents * t.hours)::bigint`.

### Routes

**`POST tenants/current/projects`** — body `{ customerId, name, budgetCents?, }`. Validate: `customerId` uuid, `name.trim()` nonempty, `budgetCents` integer ≥ 0 (default 0). `INSERT INTO projects (tenant_id, customer_id, name, budget_cents, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`. Audit action `project.created`.

**`POST tenants/current/projects/:id/status`** — body `{ status: "active"|"completed"|"archived" }`. `UPDATE projects SET status=$2 WHERE id=$1 RETURNING id` (404 if no row).

**`GET tenants/current/projects`** — list with rollups (the tricky query; LATERAL avoids join fan-out):

```sql
SELECT p.id, p.name, p.status, p.budget_cents, p.customer_id,
       c.name AS customer_name,
       coalesce(t.hours, 0)::numeric        AS hours,
       coalesce(t.unbilled_cents, 0)::bigint AS unbilled_cents,
       coalesce(t.labor_cost_cents, 0)::bigint AS labor_cost_cents,
       coalesce(t.invoiced_cents, 0)::bigint AS invoiced_cents,
       coalesce(e.expense_cents, 0)::bigint  AS expense_cents
FROM projects p
JOIN customers c ON c.id = p.customer_id
LEFT JOIN LATERAL (
  SELECT sum(te.hours) AS hours,
         sum(round(te.rate_cents * te.hours))
           FILTER (WHERE te.billable AND te.invoice_id IS NULL) AS unbilled_cents,
         sum(round(te.cost_rate_cents * te.hours)) AS labor_cost_cents,
         sum(round(te.rate_cents * te.hours))
           FILTER (WHERE inv.status IN ('issued','paid')) AS invoiced_cents
  FROM project_time_entries te
  LEFT JOIN invoices inv ON inv.id = te.invoice_id
  WHERE te.project_id = p.id
) t ON true
LEFT JOIN LATERAL (
  SELECT sum(pe.amount_cents) AS expense_cents
  FROM project_expenses pe WHERE pe.project_id = p.id
) e ON true
ORDER BY p.status, p.name
LIMIT 200
```

**`GET tenants/current/projects/:id`** — `{ project, time, expenses }`:
- project: `SELECT p.*, c.name AS customer_name FROM projects p JOIN customers c ON c.id=p.customer_id WHERE p.id=$1` (404 if none)
- time: `SELECT te.id, te.work_date, te.hours, te.rate_cents, te.cost_rate_cents, te.billable, te.notes, te.invoice_id, e.full_name AS employee_name, inv.invoice_no, inv.status AS invoice_status FROM project_time_entries te JOIN employees e ON e.id=te.employee_id LEFT JOIN invoices inv ON inv.id=te.invoice_id WHERE te.project_id=$1 ORDER BY te.work_date DESC, te.created_at DESC LIMIT 500`
- expenses: `SELECT id, description, amount_cents, expense_date, journal_entry_id FROM project_expenses WHERE project_id=$1 ORDER BY expense_date DESC LIMIT 200`

**`POST tenants/current/projects/:id/time`** — body `{ employeeId, workDate, hours, rateCents, costRateCents?, billable?, notes? }`. Validate: hours number `0 < hours <= 24` (2dp: reject if `Math.round(hours*100)/100 !== hours`), `rateCents`/`costRateCents` non-negative integers, `workDate` `YYYY-MM-DD`. Verify project exists and `status = 'active'` (400 `"Cannot log time to a completed/archived project"`). Plain INSERT returning id.

**`POST tenants/current/projects/:id/expenses`** — body `{ description, amountCents, expenseDate, paidVia?, accountCode? }`. Same validation as `sales-extras.recordExpense` (`paidVia` in cash|mpesa|bank → credit 1000/1010/1020, debit `accountCode ?? "6000"`). Inside one `db.withTenant` transaction:
1. verify project exists (404);
2. `ledger.post(client, { sourceType: "project_expense", sourceId: projectId, entryDate: expenseDate, memo: \`[${projectName}] ${description}\`, idempotencyKey: \`project-expense:${claims.sub}:${Date.now()}:${random}\`, lines: [debit expense acct, credit cash acct] })`;
3. `INSERT INTO project_expenses (tenant_id, project_id, description, amount_cents, expense_date, journal_entry_id, created_by) VALUES (...) RETURNING id`;
4. audit `project.expense_recorded`.
Returns `{ id, journalEntryId }`. (These rows do NOT appear in `GET /expenses` list, which filters `source_type='expense'` — intentional, they show on the project page.)

**`GET tenants/current/projects/:id/profitability`** — Roles owner/admin/accountant. Returns:

```json
{ "budgetCents": n, "hours": n, "billableValueCents": n, "unbilledCents": n,
  "draftBilledCents": n, "invoicedCents": n, "laborCostCents": n,
  "expenseCents": n, "totalCostCents": n, "profitCents": n, "marginPct": n }
```

SQL (single query + expenses subquery, then arithmetic in TS):

```sql
SELECT coalesce(sum(te.hours),0)::numeric AS hours,
       coalesce(sum(round(te.rate_cents*te.hours)) FILTER (WHERE te.billable),0)::bigint AS billable_value_cents,
       coalesce(sum(round(te.rate_cents*te.hours))
         FILTER (WHERE te.billable AND te.invoice_id IS NULL),0)::bigint AS unbilled_cents,
       coalesce(sum(round(te.rate_cents*te.hours))
         FILTER (WHERE inv.status = 'draft'),0)::bigint AS draft_billed_cents,
       coalesce(sum(round(te.rate_cents*te.hours))
         FILTER (WHERE inv.status IN ('issued','paid')),0)::bigint AS invoiced_cents,
       coalesce(sum(round(te.cost_rate_cents*te.hours)),0)::bigint AS labor_cost_cents
FROM project_time_entries te
LEFT JOIN invoices inv ON inv.id = te.invoice_id
WHERE te.project_id = $1
```

TS: `totalCost = laborCost + expenseCents`; `profit = invoicedCents - totalCost`; `marginPct = invoicedCents > 0 ? Math.round(profit / invoicedCents * 1000) / 10 : 0`. Note: `invoicedCents` is VAT-exclusive line value (matches Sales Revenue posting), stated in a code comment.

**`POST tenants/current/projects/:id/bill`** — the one-click action. Body `{ branchId, vatRate?, dueDate? }` (`branchId` required uuid — same convention as quote/invoice creation; `vatRate` in `"0.16"|"0"|"exempt"`, default `"0.16"`). `ProjectsService.billUnbilledTime` inside one `db.withTenant` transaction:

```ts
// 1. project + customer (404 if missing)
const proj = await client.query(
  `SELECT p.id, p.name, p.customer_id, p.status FROM projects p WHERE p.id = $1 FOR UPDATE`,
  [projectId]);
// 2. lock unbilled billable entries so concurrent billing can't double-invoice
const entries = await client.query(
  `SELECT te.id, te.work_date, te.hours, te.rate_cents, te.notes,
          e.full_name AS employee_name
   FROM project_time_entries te
   JOIN employees e ON e.id = te.employee_id
   WHERE te.project_id = $1 AND te.billable AND te.invoice_id IS NULL
   ORDER BY te.work_date, te.created_at
   FOR UPDATE OF te`, [projectId]);
if (!entries.rows.length) throw new BadRequestException("No unbilled time on this project");
// 3. one invoice line per time entry — quantity = hours, unit price = rate
const lines: InvoiceLineInput[] = entries.rows.map(r => ({
  description: `${proj.name}: ${r.employee_name} ${r.work_date.toISOString().slice(0,10)}`
    + (r.notes ? ` — ${r.notes}` : ""),
  quantity: Number(r.hours),
  unitPriceCents: Number(r.rate_cents),
  vatRate,
}));
// 4. single posting-path entry point — draft only, no ledger effect until issue
const { id: invoiceId } = await this.invoices.createDraft(client, {
  tenantId, userId, branchId, customerId: proj.customer_id, dueDate, lines });
// 5. mark entries billed
await client.query(
  `UPDATE project_time_entries SET invoice_id = $2 WHERE id = ANY($3) AND project_id = $1`,
  [projectId, invoiceId, entries.rows.map(r => r.id)]);
// 6. audit: action "project.time_billed", entityType "invoice", payload {projectId, entryCount, totalCents}
return { invoiceId, entryCount: entries.rows.length,
         subtotalCents: /* sum of computeLine totals */ };
```

Controller constructor deps: `DbService`, `ProjectsService`, `LedgerService`, `AuditService`; `ProjectsService` deps: `InvoicesService`, `AuditService`. All new `sourceType` strings: `project_expense`. Descriptions cap at ~180 chars (truncate notes).

Edit-scope invariants: no new posting path (expenses reuse `LedgerService.post`, billing produces a *draft* — DR AR/CR Sales happens only via the existing `invoices/:id/issue`), entries immutable once `invoice_id` set (no update/delete route for time entries in v1).

---

## 3) Web — `apps/web/app/(app)/projects/page.tsx`

**Nav**: in `AppShell.tsx` add to the `navOperations` section, first item: `{ href: "/projects", labelKey: "navProjects", icon: "chart" }`. In `lib/i18n.tsx` add `navProjects: "Projects"` (en) / `navProjects: "Miradi"` (sw).

**Page** (`"use client"`, tabs pattern like `crm/page.tsx`): `type Tab = "projects" | "time" | "profit"`.

Load on mount: `GET /tenants/current/projects`, `GET /tenants/current/customers`, `GET /tenants/current/hr/employees` (active), `GET /tenants/current/branches`. On selecting a project (state `selId`), load `GET /tenants/current/projects/${selId}` and `/profitability`.

- **Tab "projects"**:
  - "New project" card: customer `<select>`, name `<input>`, budget KES `<input type=number>` (×100 → cents) → POST.
  - `DataTable<ProjectRow>` `searchKeys={["name","customer_name"]}` `csvName="projects.csv"`:
    columns `Name` (render: button setting `selId` + tab "time"), `Customer`, `Status` (pill: active→`issued`, completed→`paid`, archived→`pending`), `Budget` (num, `fmtKes0`), `Hours` (num), `Unbilled` (num, KES), `Expenses` (num, KES), action column: status `<select>` posting `/status`.
- **Tab "time"** (requires `selId`; else muted "Pick a project from the Projects tab"):
  - Card "Log time": employee select, date, hours, rate KES/h, cost rate KES/h, billable checkbox, notes → `POST /projects/:id/time`.
  - Card header row: **"Bill unbilled time"** primary button (visible when `unbilled_cents > 0`): branch select + VAT select (`16% / 0% / exempt`) inline, on click `POST /projects/:id/bill`, success msg `"Draft invoice created — see Invoices."`, reload.
  - `DataTable<TimeRow>` columns: `Date`, `Employee`, `Notes`, `Hours` (num), `Rate` (num), `Amount` (num, `round(rate*hours)`), `Billable` (pill `sent`/muted "no"), `Billed` (render: unbilled billable → pill `pending` "unbilled"; invoice draft → pill `issued` "draft"; issued/paid → pill `paid` `INV {invoice_no}`).
  - Below: card "Project expenses": form (description, amount KES, date, paid via select, account code optional) → `POST /projects/:id/expenses`; plain table Date / Description / Amount (small list, no DataTable needed).
- **Tab "profit"**:
  - If `selId`: tile row (`tiles` pattern from dashboard): **Invoiced**, **Total cost** (labor+expenses), **Profit** (green/red), **Margin %**, **Budget used** (`totalCost/budget`), from the profitability endpoint; muted breakdown line: unbilled X · draft-billed Y · labor Z · expenses W.
  - Always: `DataTable<ProjectRow>` "All projects" with columns `Project`, `Invoiced`, `Labor cost` , `Expenses`, `Profit` (computed client-side `invoiced - labor - expenses`, red when negative), `Budget` — `csvName="project-profitability.csv"`.

Errors/messages: shared `err`/`msg` state + `act()` helper exactly as in `crm/page.tsx`.

---

## 4) Tests — `apps/api/test/projects.spec.ts` (follow harness of `quotes-reports.spec.ts`)

1. **Bill unbilled time creates a correct draft**: seed customer+2 employees, project, 3 billable entries (e.g. 2h @ 5,000 KES/h, 1.5h @ 6,000, 8h @ 1,000) + 1 non-billable; `POST /bill` → invoice exists with 3 lines, `subtotal_cents = 1_000_000 + 900_000 + 800_000`, VAT 16% applied, all 3 entries have `invoice_id` set, non-billable untouched.
2. **No double billing**: immediately repeat `POST /bill` → 400 `"No unbilled time"`; add one new entry, bill again → second draft has exactly 1 line.
3. **Project expense posts to ledger and links**: `POST /expenses` (25,000 KES, mpesa) → `project_expenses.journal_entry_id` points at an entry with `source_type='project_expense'`, lines DR 6000 / CR 1010 both 2,500,000 (balanced); trial balance reflects it.
4. **Profitability math**: with entries above billed+invoice issued, cost_rate 60% of rate, plus the expense: `invoicedCents = 2_700_000`, `laborCostCents = 1_620_000`, `expenseCents = 2_500_000`, `profitCents = invoiced − labor − expenses` (negative here), `marginPct` matches; unbilled/draft buckets move correctly before vs after issue.
5. **RLS isolation** (extend pattern from `rls-leak.spec.ts`): tenant B's token gets 404 on tenant A's `GET /projects/:id` and empty `GET /projects`; `POST /projects/:id/bill` cross-tenant → 404.

---

## 5) Demo data — extend `apps/api/src/tenants/demo-data.controller.ts` main `seed()`

After employees/customers/invoices are created (reuse the ids arrays and `rnd`/`pick`/`int` helpers already in scope; add `projects: 0, timeEntries: 0` to `counts`):

- **4 projects** for 4 distinct existing customers: names `"Office fit-out — {town}"`, `"Website & branding"`, `"Warehouse racking install"`, `"Annual maintenance contract"`; budgets `int(200_000, 900_000) * 100` cents; statuses: 3 active, 1 completed.
- **~40 time entries**: per project `int(8, 12)` entries, employee = `pick(employeeIds)`, `work_date = day(daysAgo(int(1, 60)))`, `hours = int(2, 16) / 2` (0.5h steps), `rate_cents = pick([150_000, 250_000, 400_000])` (KES 1,500–4,000/h), `cost_rate_cents = Math.round(rate * 0.6)`, `billable = rnd() < 0.85`, notes from a small const array (`"Site survey"`, `"Installation"`, `"Client meeting"`, `"Snag fixes"`, `"Design review"`).
- **~10 project expenses**: 2–3 per project via the same transactional path as the endpoint (ledger.post `project_expense` + insert), memos from `EXPENSE_MEMOS`, `int(3_000, 40_000) * 100` cents, paidVia mpesa/cash.
- **Bill one project**: call `ProjectsService.billUnbilledTime` for the completed project (default branch id already in scope) and then `invoices.issue` it — so profitability shows real invoiced revenue out of the box. Inject `ProjectsService` into the controller constructor.

---

## 6) Out of scope (explicit)

- Internal (non-customer) projects — `customer_id` is NOT NULL.
- Editing/deleting time entries or project expenses (immutable v1; corrections = compensating entry, expense corrections = reversing journal via existing patterns).
- Timesheet approval workflow, per-employee default rates, timers/attendance integration.
- Grouped/summarized invoice lines (one line per time entry only), partial billing (it's all unbilled time or nothing), removing billed lines from the draft (unbill).
- WIP accounting — unbilled time never touches the ledger; only the eventual invoice issue posts.
- Allocating existing bills/inventory issues to projects (project costs = direct expenses only in v1).
- Budget alerts/notifications, per-task breakdown, Gantt/scheduling.
- Swahili localization of the projects page body (nav key only, per current convention).