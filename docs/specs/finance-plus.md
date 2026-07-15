# Finance Extensions (Dynamics 365 Finance slice) — Implementation Spec

Module: **finance** — budgets + budget-vs-actual, fixed-asset register with straight-line depreciation, recurring invoice templates with a draft-posting worker. New files: `db/migrations/0017_finance.sql`, `apps/api/src/finance/{finance.controller.ts,assets.service.ts,recurring.service.ts}`, `apps/web/app/(app)/finance/page.tsx`. Touched: `ledger.service.ts` (3 new default accounts), `reports.controller.ts` (1 endpoint), `app.module.ts`, `AppShell.tsx`, `i18n.tsx`, `demo-data.controller.ts` (1 new sub-endpoint), `apps/api/test/finance.spec.ts`. ~780 changed lines.

---

## 1) Migration — `db/migrations/0017_finance.sql` (complete, ready to paste)

```sql
-- 0017: Finance extensions — budgets, fixed-asset register, recurring
-- invoice templates. Budgets are pure planning data (no postings).
-- Depreciation and asset acquisition post through LedgerService only.
-- recurring_invoices doubles as a worker queue: like fiscal_documents,
-- jenga_worker gets a cross-tenant policy on THIS TABLE ONLY (SELECT),
-- discovery-only — all drafting runs as jenga_app under tenant RLS.

-- ---------------------------------------------------------------------------
-- Budgets: one row per account per calendar month, integer cents.
-- ---------------------------------------------------------------------------
CREATE TABLE budgets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  account_code text NOT NULL,
  period_month date NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, account_code, period_month)
);

CREATE INDEX budgets_period_idx ON budgets (tenant_id, period_month);

ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgets FORCE ROW LEVEL SECURITY;
CREATE POLICY budgets_tenant ON budgets
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON budgets TO jenga_app;

-- ---------------------------------------------------------------------------
-- Fixed assets: register rows; every money movement (acquisition,
-- monthly straight-line depreciation) is a journal entry via LedgerService.
-- ---------------------------------------------------------------------------
CREATE TABLE fixed_assets (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id),
  name                 text NOT NULL,
  category             text NOT NULL DEFAULT 'equipment',
  cost_cents           bigint NOT NULL CHECK (cost_cents > 0),
  salvage_cents        bigint NOT NULL DEFAULT 0
                       CHECK (salvage_cents >= 0 AND salvage_cents < cost_cents),
  acquired_on          date NOT NULL,
  useful_life_months   int NOT NULL CHECK (useful_life_months BETWEEN 1 AND 600),
  funding_account_code text NOT NULL DEFAULT '1020',
  status               text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'disposed')),
  depreciated_through  date,          -- last period-month posted (first-of-month)
  journal_entry_id     uuid REFERENCES journal_entries (id),  -- acquisition entry
  created_by           uuid REFERENCES users (id),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX fixed_assets_tenant_idx ON fixed_assets (tenant_id, status, acquired_on);

ALTER TABLE fixed_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixed_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY fixed_assets_tenant ON fixed_assets
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON fixed_assets TO jenga_app;

-- ---------------------------------------------------------------------------
-- Recurring invoice templates. `lines` is a JSON snapshot of
-- InvoiceLineInput[] (description, quantity, unitPriceCents, vatRate,
-- itemId?) — the worker replays it through InvoicesService.createDraft.
-- ---------------------------------------------------------------------------
CREATE TABLE recurring_invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  customer_id   uuid NOT NULL REFERENCES customers (id),
  branch_id     uuid NOT NULL REFERENCES branches (id),
  frequency     text NOT NULL CHECK (frequency IN ('weekly', 'monthly')),
  next_run_date date NOT NULL,
  end_date      date,
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'paused', 'ended')),
  lines         jsonb NOT NULL,
  memo          text NOT NULL DEFAULT '',
  last_run_at   timestamptz,
  created_by    uuid REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= next_run_date OR status = 'ended')
);

-- Worker discovery scan: due active templates across all tenants.
CREATE INDEX recurring_invoices_due_idx
  ON recurring_invoices (next_run_date) WHERE status = 'active';
CREATE INDEX recurring_invoices_tenant_idx
  ON recurring_invoices (tenant_id, status, next_run_date);

ALTER TABLE recurring_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY recurring_invoices_tenant ON recurring_invoices
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Worker: discovery only (SELECT). All writes/drafting run as jenga_app
-- inside DbService.withTenant, so tenant RLS binds the actual work.
CREATE POLICY recurring_invoices_worker ON recurring_invoices
  FOR SELECT TO jenga_worker USING (true);

GRANT SELECT, INSERT, UPDATE ON recurring_invoices TO jenga_app;
GRANT SELECT ON recurring_invoices TO jenga_worker;
```

**Chart of accounts** — append to `DEFAULT_ACCOUNTS` in `apps/api/src/ledger/ledger.service.ts` (insert in code order):

```ts
{ code: "1500", name: "Fixed Assets", type: "asset", system: true },
{ code: "1510", name: "Accumulated Depreciation", type: "asset", system: true }, // contra-asset: credit-balance
{ code: "6200", name: "Depreciation Expense", type: "expense", system: true },
```

Existing tenants pick these up by re-running `POST tenants/current/accounts/seed-defaults` (idempotent `ON CONFLICT DO NOTHING`). The finance endpoints return LedgerService's `Unknown account code: 1500` 400 if not seeded — no extra guard needed, but the web page shows a hint linking to Settings when that error string appears.

---

## 2) API

### 2a) `reports/budget-vs-actual` — add to `apps/api/src/ledger/reports.controller.ts`

`GET tenants/current/reports/budget-vs-actual?from=YYYY-MM&to=YYYY-MM` — `@Roles(...REPORT_ROLES)`. Validate `from`/`to` against `/^\d{4}-\d{2}$/`; compute `fromDate = from + "-01"` and `toDate` = last day of `to` month (`new Date(Date.UTC(y, m, 0)).toISOString().slice(0,10)`). The actuals CTE is the P&L query re-grouped by month:

```sql
WITH actual AS (
  SELECT a.code,
         date_trunc('month', je.entry_date)::date AS period_month,
         sum(CASE WHEN a.type = 'income'
                  THEN jl.credit_cents - jl.debit_cents
                  ELSE jl.debit_cents - jl.credit_cents END)::bigint AS actual_cents
  FROM journal_lines jl
  JOIN accounts a ON a.id = jl.account_id
  JOIN journal_entries je ON je.id = jl.entry_id
  WHERE a.type IN ('income', 'expense')
    AND je.entry_date BETWEEN $1 AND $2
  GROUP BY a.code, 2
),
merged AS (
  SELECT coalesce(ac.code, b.account_code)         AS code,
         coalesce(ac.period_month, b.period_month) AS period_month,
         coalesce(b.amount_cents, 0)::bigint       AS budget_cents,
         coalesce(ac.actual_cents, 0)::bigint      AS actual_cents
  FROM actual ac
  FULL OUTER JOIN budgets b
    ON b.account_code = ac.code AND b.period_month = ac.period_month
  WHERE coalesce(ac.period_month, b.period_month) BETWEEN $1 AND $2
)
SELECT m.code, a.name, a.type,
       to_char(m.period_month, 'YYYY-MM') AS month,
       m.budget_cents, m.actual_cents,
       (m.actual_cents - m.budget_cents)::bigint AS variance_cents
FROM merged m
JOIN accounts a ON a.code = m.code
ORDER BY a.type DESC, m.code, m.period_month
```

(Both `budgets` and `accounts` are RLS-scoped, so the FULL OUTER JOIN never crosses tenants.) Response: `{ from, to, rows, totals: { budgetIncomeCents, actualIncomeCents, budgetExpenseCents, actualExpenseCents } }` — totals reduced in TS like `pnl()` does. Income variance sign convention: `variance_cents = actual - budget` for all rows; the UI colors income-positive/expense-negative as favourable.

### 2b) `FinanceController` — `apps/api/src/finance/finance.controller.ts`

`@Controller("tenants/current")`, guards `JwtAuthGuard, TenantContextGuard, RolesGuard`, `const FINANCE_ROLES = ["owner", "admin", "accountant"] as const;` on every route. Injects `DbService`, `AssetsService`, `RecurringService`, `AuditService`.

| Route | Behaviour |
|---|---|
| `GET budgets?year=YYYY` | `SELECT account_code, to_char(period_month,'YYYY-MM') AS month, amount_cents FROM budgets WHERE period_month BETWEEN $1 AND $2 ORDER BY account_code, period_month` ($1=`YYYY-01-01`, $2=`YYYY-12-01`) |
| `POST budgets` | Body `{ entries: { accountCode, month /*YYYY-MM*/, amountCents }[] }` (max 200). Validate month regex, `Number.isInteger(amountCents) && amountCents >= 0`. First verify every code: `SELECT code FROM accounts WHERE code = ANY($1) AND type IN ('income','expense')` — 400 on unknown/non-P&L code. Then per entry upsert: `INSERT INTO budgets (tenant_id, account_code, period_month, amount_cents) VALUES ($1,$2,($3||'-01')::date,$4) ON CONFLICT (tenant_id, account_code, period_month) DO UPDATE SET amount_cents = EXCLUDED.amount_cents, updated_at = now()`. Audit `budget.upserted` once with `{count}`. Returns `{ upserted }` |
| `GET fixed-assets` | Register with live accumulated depreciation off the journal (see SQL below) |
| `POST fixed-assets` | Body `{ name, category?, costCents, salvageCents?, acquiredOn, usefulLifeMonths, fundingAccountCode? /*default '1020'*/ }`. Insert row, then `AssetsService.postAcquisition` (below), audit `asset.created` |
| `POST fixed-assets/depreciation/run` | Body `{ period: "YYYY-MM" }`. Returns `{ posted, skipped, totalCents }` (see 2c) |
| `GET recurring-invoices` | `SELECT r.id, c.name AS customer, r.frequency, r.next_run_date, r.end_date, r.status, r.memo, r.last_run_at, (SELECT sum(((l->>'unitPriceCents')::bigint * round((l->>'quantity')::numeric * 1000)) / 1000) FROM jsonb_array_elements(r.lines) l)::bigint AS subtotal_cents FROM recurring_invoices r JOIN customers c ON c.id = r.customer_id ORDER BY r.next_run_date LIMIT 500` |
| `POST recurring-invoices` | Body `{ customerId, branchId, frequency, nextRunDate, endDate?, memo?, lines: InvoiceLineInput[] }`. Validate each line via `InvoicesService.computeLine` (throws on bad qty/price) before insert; store `JSON.stringify(lines)`. Audit `recurring.created` |
| `POST recurring-invoices/:id/pause` / `:id/resume` | `UPDATE recurring_invoices SET status = 'paused'|'active' WHERE id = $1 AND status = 'active'|'paused' RETURNING id` — 404 if no row |
| `POST recurring-invoices/run` | Manual per-tenant run (sweep-timeouts pattern): `RecurringService.runDueForTenant(claims.tid)`. Returns `{ drafted: number }` |

Register-with-NBV query (`GET fixed-assets`; `source_id` is `text`, hence the cast):

```sql
SELECT fa.id, fa.name, fa.category, fa.cost_cents, fa.salvage_cents,
       fa.acquired_on, fa.useful_life_months, fa.status, fa.depreciated_through,
       coalesce(dep.cents, 0)::bigint AS accumulated_cents,
       (fa.cost_cents - coalesce(dep.cents, 0))::bigint AS nbv_cents
FROM fixed_assets fa
LEFT JOIN LATERAL (
  SELECT sum(jl.credit_cents - jl.debit_cents) AS cents
  FROM journal_entries je
  JOIN journal_lines jl ON jl.entry_id = je.id
  JOIN accounts a ON a.id = jl.account_id AND a.code = '1510'
  WHERE je.source_type = 'depreciation' AND je.source_id = fa.id::text
) dep ON true
ORDER BY fa.acquired_on DESC LIMIT 500
```

### 2c) `AssetsService` — `apps/api/src/finance/assets.service.ts`

Injects `LedgerService`. All methods take the caller's `PoolClient` (inside `withTenant`).

`postAcquisition(client, { tenantId, userId, assetId, name, costCents, fundingAccountCode, acquiredOn })`:
```
ledger.post: entryDate=acquiredOn, memo=`Asset acquisition: ${name}`,
  sourceType='fixed_asset', sourceId=assetId,
  idempotencyKey=`asset-acquisition:${assetId}`,
  lines: DR 1500 costCents / CR fundingAccountCode costCents
then UPDATE fixed_assets SET journal_entry_id=$2 WHERE id=$1
```

`runDepreciation(client, { tenantId, userId, period /*YYYY-MM*/ })` — the exact math (integer cents, remainder in final month so lifetime total equals `cost - salvage` exactly):

```ts
const [y, m] = period.split("-").map(Number);
const entryDate = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // last day of period
const assets = await client.query(
  `SELECT id, name, cost_cents, salvage_cents, acquired_on, useful_life_months
   FROM fixed_assets WHERE status = 'active' ORDER BY acquired_on`);
let posted = 0, skipped = 0, totalCents = 0;
for (const a of assets.rows) {
  const acq = new Date(a.acquired_on);
  // 1-based month index within the depreciation schedule (full-month convention,
  // starting in the acquisition month).
  const idx = (y * 12 + m) - (acq.getUTCFullYear() * 12 + acq.getUTCMonth() + 1) + 1;
  const life = Number(a.useful_life_months);
  if (idx < 1 || idx > life) { skipped++; continue; }
  const base = Number(a.cost_cents) - Number(a.salvage_cents);
  const monthly = Math.floor(base / life);
  const amount = idx === life ? base - monthly * (life - 1) : monthly;
  if (amount <= 0) { skipped++; continue; }
  const r = await this.ledger.post(client, {
    tenantId, postedBy: userId, entryDate,
    memo: `Depreciation ${period}: ${a.name} (month ${idx}/${life})`,
    sourceType: "depreciation", sourceId: a.id,
    idempotencyKey: `depreciation:${a.id}:${period}`,   // <-- idempotency
    lines: [
      { accountCode: "6200", debitCents: amount },
      { accountCode: "1510", creditCents: amount },
    ],
  });
  if (r.deduplicated) { skipped++; continue; }
  await client.query(
    `UPDATE fixed_assets SET depreciated_through = greatest(coalesce(depreciated_through,'1900-01-01'), $2::date)
     WHERE id = $1`, [a.id, `${period}-01`]);
  posted++; totalCents += amount;
}
return { posted, skipped, totalCents };
```

One journal entry per asset per month; re-running a period is a no-op via the ledger idempotency key (LedgerService dedupes before posting). The whole run is one `withTenant` transaction — all-or-nothing.

### 2d) `RecurringService` — `apps/api/src/finance/recurring.service.ts`

Follows `FiscalService`'s worker shape exactly: `OnModuleInit`/`OnModuleDestroy`, `makePool(loadConfig().workerDbUrl, 2)` for **discovery only**, `setInterval` 60_000 ms gated by `process.env.RECURRING_WORKER_ENABLED === "true"`, `.unref()`. Injects `DbService`, `InvoicesService`.

```ts
/** Worker tick: find due templates cross-tenant (jenga_worker, SELECT-only
 *  policy on recurring_invoices), then run each tenant as jenga_app. */
async processOnce(): Promise<number> {
  const due = await this.workerPool.query(
    `SELECT DISTINCT tenant_id FROM recurring_invoices
     WHERE status = 'active' AND next_run_date <= current_date LIMIT 20`);
  let drafted = 0;
  for (const row of due.rows) drafted += await this.runDueForTenant(row.tenant_id);
  return drafted;
}

/** Also called by POST tenants/current/recurring-invoices/run. */
async runDueForTenant(tenantId: string): Promise<number> {
  let drafted = 0;
  // One template-advance per transaction; loop caps catch-up at 12 drafts.
  for (let i = 0; i < 12; i++) {
    const n = await this.db.withTenant(tenantId, null, async (client) => {
      const res = await client.query(
        `SELECT id, customer_id, branch_id, frequency, next_run_date, end_date,
                lines, memo, created_by
         FROM recurring_invoices
         WHERE status = 'active' AND next_run_date <= current_date
         ORDER BY next_run_date LIMIT 1
         FOR UPDATE SKIP LOCKED`);
      const t = res.rows[0];
      if (!t) return 0;
      const runDate: string = t.next_run_date.toISOString?.().slice(0,10) ?? t.next_run_date;
      if (t.end_date && runDate > (t.end_date.toISOString?.().slice(0,10) ?? t.end_date)) {
        await client.query(`UPDATE recurring_invoices SET status = 'ended' WHERE id = $1`, [t.id]);
        return 0; // ended, no draft
      }
      // Claim the run atomically with the draft (same tx): advance next_run_date.
      await client.query(
        `UPDATE recurring_invoices
         SET next_run_date = (next_run_date + CASE frequency
               WHEN 'weekly' THEN interval '7 days' ELSE interval '1 month' END)::date,
             last_run_at = now()
         WHERE id = $1`, [t.id]);
      await this.invoices.createDraft(client, {
        tenantId, userId: t.created_by,
        branchId: t.branch_id, customerId: t.customer_id,
        dueDate: runDate,
        lines: t.lines,           // jsonb comes back parsed as InvoiceLineInput[]
      });
      return 1;
    });
    if (n === 0) break;
    drafted += n;
  }
  return drafted;
}
```

Drafts only — no issue, no numbering, no ledger posting, no eTIMS (that stays a human action on the Invoices page). Because the claim (`UPDATE next_run_date`) and the draft commit in the same transaction, a crash rolls both back and the next tick retries; `FOR UPDATE SKIP LOCKED` prevents double-drafting under concurrent workers.

### 2e) Wiring — `apps/api/src/app.module.ts`

Add `FinanceController` to `controllers`; `AssetsService`, `RecurringService` to `providers`. Nothing else (LedgerService/InvoicesService already provided).

---

## 3) Web page — `apps/web/app/(app)/finance/page.tsx`

**Nav:** add to the `navCompliance` section of `NAV` in `AppShell.tsx`, above `/reports`: `{ href: "/finance", labelKey: "navFinance", icon: "payroll" }`. **i18n** (`i18n.tsx`): `navFinance: "Finance"` (en) / `navFinance: "Fedha"` (sw).

`"use client"`, tabs pattern identical to `reports/page.tsx`: `type Tab = "budgets" | "assets" | "recurring"` with lazy load per tab in `switchTab`.

**Budgets tab**
- Toolbar card: `from`/`to` `<input type="month">` (defaults: Jan of current year → current month), Run button → `GET /tenants/current/reports/budget-vs-actual?from=&to=`.
- 4 stat tiles (`.row` of `.card` + `.stat` like the sales report): Budgeted income, Actual income, Budgeted expenses, Actual expenses.
- `DataTable` (`csvName="budget-vs-actual.csv"`, `searchKeys=["code","name"]`), columns: `code`, `name`, `month`, `budget` (num, `fmtKes(budget_cents)`), `actual` (num), `variance` (num, render with pill: favourable — income actual≥budget or expense actual≤budget — `pill ok`, else `pill warn`).
- "Set budget" card under the table: account `<select>` (loaded from `GET accounts/trial-balance`, filtered to income/expense), month input, KES amount input (×100 on submit), Add-to-batch → local list → Save posts `POST /tenants/current/budgets { entries }`, then reloads report.

**Fixed assets tab**
- Toolbar: month input + "Run depreciation" button → `POST /tenants/current/fixed-assets/depreciation/run { period }`; show `Posted N entries — KES X` result line; on 400 containing "Unknown account code" show hint "Re-seed default accounts in Settings".
- `DataTable` (`csvName="fixed-assets.csv"`, `searchKeys=["name","category"]`), columns: Name, Category, Acquired (`acquired_on.slice(0,10)`), Cost (num), Life (mo), Accumulated (num), NBV (num), Status (pill: `active` → `pill ok`, `disposed` → `pill muted`).
- "New asset" card: name, category, cost KES, salvage KES, acquired-on date, life months, funding account select (1000/1010/1020/2100) → `POST /tenants/current/fixed-assets`.

**Recurring tab**
- Toolbar: "Run due now" button → `POST /tenants/current/recurring-invoices/run`, shows "N draft(s) created".
- `DataTable` (`csvName="recurring-invoices.csv"`), columns: Customer, Frequency, Next run, Subtotal (num, `fmtKes(subtotal_cents)`), Ends, Status (pill: active `ok` / paused `warn` / ended `muted`), Actions (Pause/Resume button per row).
- "New template" card mirroring the invoice-new line editor in miniature: customer select (`GET customers`), branch select (`GET branches`), frequency select, next-run date, optional end date, line rows (description, qty, unit price KES, VAT select 16%/0%/exempt) with add/remove → `POST /tenants/current/recurring-invoices`.

---

## 4) Tests — `apps/api/test/finance.spec.ts`

1. **Depreciation idempotency + remainder month:** asset cost 100 000 00, salvage 10 000 00, life 7 mo → run months 1..7: months 1–6 post `1285714`, month 7 posts `1285716`; sum == 9 000 000 exactly. Re-run any month → `{posted:0, skipped:≥1}` and `journal_entries` count unchanged.
2. **Depreciation window:** run for the month before `acquired_on` and for month life+1 → both skipped, no entries; disposed asset skipped.
3. **Budget vs actual reuses the ledger:** upsert budget 4000 = 50 000 00 for month M; issue one invoice (subtotal 30 000 00) in M → report row for 4000/M has `budget_cents=5000000, actual_cents=3000000, variance_cents=-2000000`; a budget-only account (6000) still appears with `actual_cents=0`; numbers agree with `reports/pnl` for the same range.
4. **Recurring draft + advance:** template `next_run_date = yesterday`, monthly → `runDueForTenant` creates exactly 1 draft invoice (status `draft`, totals computed from the JSON lines, `due_date` = old run date), `next_run_date` advanced +1 month, `last_run_at` set; immediate second run → 0 drafts. Template with `end_date < next_run_date` → status flips to `ended`, 0 drafts.
5. **RLS leak (extend `rls-leak.spec.ts` pattern):** tenant B sees zero rows from `budgets`, `fixed_assets`, `recurring_invoices` seeded by tenant A; `jenga_worker` can `SELECT` `recurring_invoices` cross-tenant but `INSERT`/`UPDATE` fails; worker has no grant on `budgets`/`fixed_assets`.

---

## 5) Demo data — new endpoint in `demo-data.controller.ts`

`POST tenants/current/demo-data/finance` (`@Roles("owner","admin")`, `@HttpCode(200)`), guard: 400 if `SELECT count(*) FROM budgets` > 0. Uses `mulberry32(7)`, injects `AssetsService`, `RecurringService`.

- **Budgets:** for accounts `4000, 5000, 6000, 6100`, all 12 months of the current year; bases 2 500 000 / 1 400 000 / 300 000 / 450 000 KES ±15% jitter, rounded to whole KES ×100.
- **Fixed assets:** 5 rows via the same insert+`postAcquisition` path — Delivery van (KES 2 800 000, 60 mo, funding 1020), Office computers (450 000, 36 mo), Warehouse shelving (300 000, 96 mo, salvage 30 000), Generator (520 000, 84 mo), POS equipment (180 000, 36 mo) — `acquired_on` spread 4–14 months back; then call `runDepreciation` for each of the last 3 full months.
- **Recurring:** 3 monthly templates against 3 existing demo customers (fallback: pick first 3 `customers`) — "Monthly retainer" (85 000 KES, 16%), "Service contract" (40 000, 16%), "Storage fee" (12 500, exempt), `next_run_date = today` → call `runDueForTenant` once so 3 fresh drafts appear on the Invoices page. Return `{ budgets, assets, depreciationEntries, recurringTemplates, drafts }`.

---

## 6) Out of scope (explicit)

- Asset disposal/sale postings, revaluation, impairment; declining-balance or units-of-production methods (straight-line, full-month convention only).
- Depreciation proration by days; mid-month conventions.
- Auto-**issuing** recurring invoices (drafts only — issue/eTIMS/numbering stays manual on the Invoices page); editing a template's lines after creation (pause + recreate).
- Budget approval workflow, budget versions/scenarios, per-branch or per-department budgets, CSV budget import.
- Balance-sheet-account budgets (income/expense codes only).
- Deleting budgets/assets/templates (no DELETE grants anywhere in the schema; use amount 0 / `disposed` / `paused`).
- New worker role grants beyond SELECT on `recurring_invoices`; no scheduler UI (worker is env-flag + manual run button).
- Fixed-asset purchase-via-bill linkage (funding account credit only) and VAT on asset acquisition.