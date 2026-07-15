-- 0020: Project Operations — customer projects with time tracking, project
-- expenses and one-click billing of unbilled work into a draft invoice via
-- InvoicesService.createDraft. Money in integer cents; hourly_rate_cents is
-- the project's billing rate per hour (also used as the internal labour
-- valuation in profitability). billed_invoice_id links a time entry or
-- expense to the draft invoice that billed it; rows lock once billed.

CREATE TABLE projects (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id),
  customer_id       uuid REFERENCES customers (id),
  name              text NOT NULL,
  status            text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'completed', 'archived')),
  budget_cents      bigint CHECK (budget_cents IS NULL OR budget_cents >= 0),
  hourly_rate_cents bigint CHECK (hourly_rate_cents IS NULL OR hourly_rate_cents >= 0),
  created_by        uuid REFERENCES users (id),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX projects_tenant_idx ON projects (tenant_id, status, name);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
CREATE POLICY projects_tenant ON projects
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON projects TO jenga_app;

CREATE TABLE project_time_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id),
  project_id        uuid NOT NULL REFERENCES projects (id),
  employee_id       uuid REFERENCES employees (id),
  entry_date        date NOT NULL,
  hours             numeric(6,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  note              text NOT NULL DEFAULT '',
  billable          boolean NOT NULL DEFAULT true,
  billed_invoice_id uuid REFERENCES invoices (id), -- NULL = unbilled
  created_by        uuid REFERENCES users (id),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX project_time_entries_project_idx
  ON project_time_entries (tenant_id, project_id, entry_date DESC);
-- fast "billable unbilled work" lookup for the billing action
CREATE INDEX project_time_entries_unbilled_idx
  ON project_time_entries (tenant_id, project_id)
  WHERE billable AND billed_invoice_id IS NULL;

ALTER TABLE project_time_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_time_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY project_time_entries_tenant ON project_time_entries
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON project_time_entries TO jenga_app;

CREATE TABLE project_expenses (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id),
  project_id        uuid NOT NULL REFERENCES projects (id),
  expense_date      date NOT NULL,
  description       text NOT NULL,
  amount_cents      bigint NOT NULL CHECK (amount_cents > 0),
  billable          boolean NOT NULL DEFAULT true,
  billed_invoice_id uuid REFERENCES invoices (id), -- NULL = unbilled
  created_by        uuid REFERENCES users (id),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX project_expenses_project_idx
  ON project_expenses (tenant_id, project_id, expense_date DESC);

ALTER TABLE project_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_expenses FORCE ROW LEVEL SECURITY;
CREATE POLICY project_expenses_tenant ON project_expenses
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON project_expenses TO jenga_app;
